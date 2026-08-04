import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import {
  sessionRuntimeClaimRequestSchema,
  sessionRuntimeCompletionRequestSchema,
  type SessionCommandResult,
} from "@renoconcierge/codeops-contracts";
import { authenticateBearer } from "./core.js";
import type { SessionRuntimeDispatchClaim } from "./session-broker-runtime-outbox.js";

const dispatchId = z.string().uuid();
const claimPath = "/v1/session-runtime/claims";
const completionPath =
  /^\/v1\/session-runtime\/dispatches\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/completions$/i;

function header(
  headers: IncomingHttpHeaders,
  name: "authorization" | "content-type",
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function requireJson(headers: IncomingHttpHeaders): void {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      header(headers, "content-type") ?? "",
    )
  ) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime content type must be application/json",
    );
  }
}

async function readRequestBody(
  readBody: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await readBody();
  } catch {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime body is not valid bounded JSON",
    );
  }
}

export class InvalidSessionRuntimeRequestError extends Error {}

export interface SessionRuntimeHttpResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export async function serveSessionRuntime(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly workerId: string;
  readonly readBody: () => Promise<unknown>;
  readonly claim: (input: {
    readonly workerId: string;
    readonly leaseMs: number;
  }) => Promise<SessionRuntimeDispatchClaim | null>;
  readonly complete: (input: {
    readonly dispatchId: string;
    readonly claimToken: string;
    readonly workerId: string;
    readonly completion: unknown;
  }) => Promise<SessionCommandResult>;
}): Promise<SessionRuntimeHttpResult | null> {
  if (input.method !== "POST" || input.url === undefined) return null;
  const url = new URL(input.url, "http://codeops.internal");
  const isClaim = url.pathname === claimPath;
  const completionMatch = url.pathname.match(completionPath);
  if (!isClaim && completionMatch === null) return null;
  if ([...url.searchParams].length !== 0) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime routes do not accept query parameters",
    );
  }
  if (!authenticateBearer(header(input.headers, "authorization"), input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  requireJson(input.headers);

  if (isClaim) {
    const request = sessionRuntimeClaimRequestSchema.safeParse(
      await readRequestBody(input.readBody),
    );
    if (!request.success) {
      throw new InvalidSessionRuntimeRequestError(
        "session runtime claim body is invalid",
      );
    }
    const claim = await input.claim({
      workerId: input.workerId,
      leaseMs: request.data.leaseMs,
    });
    return {
      status: 200,
      body: {
        version: "codeops.session-runtime-claim-response/v1",
        claim,
      },
    };
  }

  const request = sessionRuntimeCompletionRequestSchema.safeParse(
    await readRequestBody(input.readBody),
  );
  if (!request.success) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime completion body is invalid",
    );
  }
  const pathDispatchId = dispatchId.parse(completionMatch![1]);
  if (request.data.completion.dispatchId !== pathDispatchId) {
    throw new InvalidSessionRuntimeRequestError(
      "session runtime completion path and body identities do not match",
    );
  }
  return {
    status: 200,
    body: await input.complete({
      dispatchId: pathDispatchId,
      claimToken: request.data.claimToken,
      workerId: input.workerId,
      completion: request.data.completion,
    }),
  };
}
