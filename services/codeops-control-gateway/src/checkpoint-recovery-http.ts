import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import { authenticateBearer } from "./bearer-auth.js";
import { authenticatedCheckpointOperator, type AuthenticatedCheckpointOperator } from "./checkpoint-recovery.js";

export class InvalidCheckpointControlRequestError extends Error {}

export async function serveCheckpointRecoveryControl(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly hold: (input: { operator: AuthenticatedCheckpointOperator;
    checkpointId: string; action: "placed" | "released"; reason: string;
    eventId?: string }) => Promise<unknown>;
  readonly retention: (input: { operator: AuthenticatedCheckpointOperator;
    checkpointId: string; retainForSeconds: number; authorityForSeconds: number;
    decisionId?: string }) => Promise<unknown>;
  readonly cleanup: (input: { operator: AuthenticatedCheckpointOperator;
    checkpointId: string; decisionId?: string }) => Promise<unknown>;
}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (input.url === undefined) return null;
  const url = new URL(input.url, "http://codeops.internal");
  const match = /^\/v1\/checkpoints\/([^/]+)\/(holds|retention|cleanup)$/.exec(url.pathname);
  if (match === null) return null;
  if (input.method !== "POST") return { status: 405, body: { status: "method-not-allowed" } };
  if (!authenticateBearer(typeof input.headers.authorization === "string"
      ? input.headers.authorization : undefined, input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  let operator: AuthenticatedCheckpointOperator;
  try { operator = authenticatedCheckpointOperator(input); } catch {
    throw new InvalidCheckpointControlRequestError("checkpoint control requires a non-runtime principal");
  }
  const checkpoint = z.string().uuid().safeParse(match[1]);
  if (!checkpoint.success || url.search !== "" ||
      typeof input.headers["content-type"] !== "string" ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(input.headers["content-type"])) {
    throw new InvalidCheckpointControlRequestError("checkpoint control route or content type is invalid");
  }
  const body = await input.readBody();
  const authority = { operator, checkpointId: checkpoint.data };
  let result: unknown;
  if (match[2] === "holds") {
    const parsed = z.object({ action: z.enum(["placed", "released"]),
      reason: z.string().min(1).max(1000), eventId: z.string().uuid().optional() }).strict().safeParse(body);
    if (!parsed.success) throw new InvalidCheckpointControlRequestError("checkpoint control body is invalid");
    result = await input.hold({ ...authority, ...parsed.data });
  } else if (match[2] === "retention") {
    const parsed = z.object({ retainForSeconds: z.number().int().min(1).max(31_536_000),
      authorityForSeconds: z.number().int().min(1).max(86_400),
      decisionId: z.string().uuid().optional() }).strict().safeParse(body);
    if (!parsed.success) throw new InvalidCheckpointControlRequestError("checkpoint control body is invalid");
    result = await input.retention({ ...authority, ...parsed.data });
  } else {
    const parsed = z.object({ decisionId: z.string().uuid().optional() }).strict().safeParse(body);
    if (!parsed.success) throw new InvalidCheckpointControlRequestError("checkpoint control body is invalid");
    result = await input.cleanup({ ...authority, ...parsed.data });
  }
  return { status: 200, body: { result } };
}
