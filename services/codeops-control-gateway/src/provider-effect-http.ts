import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import { authenticateBearer } from "./bearer-auth.js";

const pathPattern = /^\/v1\/provider-effects\/(githubmutation-[0-9a-f]{64})\/reconcile$/;
const resolvePathPattern = /^\/v1\/provider-effects\/(githubmutation-[0-9a-f]{64})\/resolve$/;
const bodySchema = z.object({
  version: z.literal("codeops.provider-effect-reconciliation-command/v1"),
}).strict();
const principalSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const resolutionBodySchema = z.object({
  version: z.literal("codeops.provider-effect-operator-resolution-command/v1"),
  resolution: z.enum(["satisfied", "not_observed", "accepted_unknown"]),
  summary: z.string().min(1).max(1_000),
  evidenceReferences: z.array(z.string().min(1).max(500)).max(10),
}).strict();

export class InvalidProviderEffectRequestError extends Error {}

export async function serveProviderEffectReconciliation(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly reconcile: (input: {
    readonly effectId: string;
    readonly principalId: string;
  }) => Promise<Readonly<Record<string, unknown>>>;
  readonly resolve: (input: {
    readonly effectId: string;
    readonly principalId: string;
    readonly resolution: "satisfied" | "not_observed" | "accepted_unknown";
    readonly summary: string;
    readonly evidenceReferences: readonly string[];
  }) => Promise<Readonly<Record<string, unknown>>>;
}): Promise<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> } | null> {
  if (input.method !== "POST" || input.url === undefined) return null;
  const url = new URL(input.url, "http://codeops.internal");
  const match = url.pathname.match(pathPattern);
  const resolveMatch = url.pathname.match(resolvePathPattern);
  if (match === null && resolveMatch === null) return null;
  if ([...url.searchParams].length !== 0) {
    throw new InvalidProviderEffectRequestError("provider effect command does not accept query parameters");
  }
  if (!authenticateBearer(
    typeof input.headers.authorization === "string" ? input.headers.authorization : undefined,
    input.token,
  )) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (!input.headers["content-type"]?.startsWith("application/json")) {
    return { status: 415, body: { status: "unsupported-media-type" } };
  }
  let principalId: string;
  let resolutionCommand: z.infer<typeof resolutionBodySchema> | null = null;
  try {
    const body = await input.readBody();
    principalId = principalSchema.parse(input.headers["x-codeops-principal"]);
    if (resolveMatch !== null) {
      resolutionCommand = resolutionBodySchema.parse(body);
    } else {
      bodySchema.parse(body);
    }
  } catch (error) {
    throw new InvalidProviderEffectRequestError("provider effect command is invalid", { cause: error });
  }
  if (resolutionCommand !== null) {
    return {
      status: 200,
      body: await input.resolve({
        effectId: resolveMatch![1]!,
        principalId,
        resolution: resolutionCommand.resolution,
        summary: resolutionCommand.summary,
        evidenceReferences: resolutionCommand.evidenceReferences,
      }),
    };
  }
  return {
    status: 200,
    body: await input.reconcile({ effectId: match![1]!, principalId }),
  };
}
