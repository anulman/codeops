import {
  sessionRuntimeClaimRequestSchema,
  sessionRuntimeClaimResponseSchema,
  sessionRuntimeCompletionRequestSchema,
  sessionRuntimeCompletionResponseSchema,
  sessionRuntimeCompletionSchema,
  type SessionCommandResult,
  type SessionRuntimeCompletion,
  type SessionRuntimeDispatchClaim,
} from "@renoconcierge/codeops-contracts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN_PATTERN = /^[\x21-\x7e]{32,4096}$/;

export class SessionRuntimeTransportError extends Error {}

export type RuntimeExecutor = (
  claim: SessionRuntimeDispatchClaim,
) => Promise<SessionRuntimeCompletion>;

function exactGatewayOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime gateway URL must be one credential-free HTTP origin",
    );
  }
  return parsed.origin;
}

function exactToken(raw: string): string {
  const token = raw.trim();
  if (token !== raw || !TOKEN_PATTERN.test(token)) {
    throw new SessionRuntimeTransportError(
      "session runtime token must be 32 to 4096 printable non-space bytes",
    );
  }
  return token;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null) {
    const bytes = Number(length);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      throw new SessionRuntimeTransportError(
        "session runtime response exceeds the 1 MiB transport bound",
      );
    }
  }
  if (response.body === null) {
    throw new SessionRuntimeTransportError(
      "session runtime response body is missing",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SessionRuntimeTransportError(
        "session runtime response exceeds the 1 MiB transport bound",
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SessionRuntimeTransportError(
      "session runtime response is not valid bounded UTF-8 JSON",
    );
  }
}

function requireSuccess(response: Response): void {
  if (response.status !== 200) {
    throw new SessionRuntimeTransportError(
      `session runtime gateway returned HTTP ${response.status}`,
    );
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      response.headers.get("content-type") ?? "",
    )
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime response content type must be application/json",
    );
  }
}

function requireCompletionIdentity(
  claim: SessionRuntimeDispatchClaim,
  completion: SessionRuntimeCompletion,
): void {
  const { dispatch, claimExpiresAt } = claim;
  const { command, snapshot } = dispatch;
  if (
    completion.dispatchId !== dispatch.dispatchId ||
    completion.sessionId !== command.sessionId ||
    completion.generation !== command.generation ||
    completion.leaseId !== command.leaseId ||
    completion.idempotencyKey !== command.idempotencyKey ||
    completion.type !== command.type ||
    completion.observedEventCursor !== snapshot.eventCursor ||
    Date.parse(completion.completedAt) < Date.parse(dispatch.dispatchedAt) ||
    Date.parse(completion.completedAt) >= Date.parse(claimExpiresAt)
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime completion drifted from the exact live claim",
    );
  }
}

export class SessionRuntimeTransport {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(input: {
    readonly gatewayOrigin: string;
    readonly token: string;
    readonly fetch?: typeof fetch;
    readonly requestTimeoutMs?: number;
  }) {
    this.#origin = exactGatewayOrigin(input.gatewayOrigin);
    this.#token = exactToken(input.token);
    this.#fetch = input.fetch ?? fetch;
    this.#requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1_000 ||
      this.#requestTimeoutMs > 30_000
    ) {
      throw new SessionRuntimeTransportError(
        "session runtime request timeout must be between 1 and 30 seconds",
      );
    }
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#requestTimeoutMs,
    );
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
      requireSuccess(response);
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof SessionRuntimeTransportError) throw error;
      throw new SessionRuntimeTransportError(
        `session runtime gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async claim(leaseMs: number): Promise<SessionRuntimeDispatchClaim | null> {
    const request = sessionRuntimeClaimRequestSchema.parse({
      version: "codeops.session-runtime-claim-request/v1",
      leaseMs,
    });
    const response = sessionRuntimeClaimResponseSchema.parse(
      await this.#post("/v1/session-runtime/claims", request),
    );
    return response.claim;
  }

  async complete(
    claim: SessionRuntimeDispatchClaim,
    rawCompletion: unknown,
    now: () => Date = () => new Date(),
  ): Promise<SessionCommandResult> {
    if (now().getTime() >= Date.parse(claim.claimExpiresAt)) {
      throw new SessionRuntimeTransportError(
        "session runtime claim expired before completion submission",
      );
    }
    const completion = sessionRuntimeCompletionSchema.parse(rawCompletion);
    requireCompletionIdentity(claim, completion);
    const request = sessionRuntimeCompletionRequestSchema.parse({
      version: "codeops.session-runtime-completion-request/v1",
      claimToken: claim.claimToken,
      completion,
    });
    return sessionRuntimeCompletionResponseSchema.parse(
      await this.#post(
        `/v1/session-runtime/dispatches/${claim.dispatch.dispatchId}/completions`,
        request,
      ),
    );
  }

  async runOne(input: {
    readonly leaseMs: number;
    readonly execute: RuntimeExecutor;
    readonly now?: () => Date;
  }): Promise<SessionCommandResult | null> {
    const claim = await this.claim(input.leaseMs);
    if (claim === null) return null;
    const now = input.now ?? (() => new Date());
    if (now().getTime() >= Date.parse(claim.claimExpiresAt)) {
      throw new SessionRuntimeTransportError(
        "session runtime claim expired before execution began",
      );
    }
    const completion = await input.execute(claim);
    if (now().getTime() >= Date.parse(claim.claimExpiresAt)) {
      throw new SessionRuntimeTransportError(
        "session runtime claim expired before completion submission",
      );
    }
    return this.complete(claim, completion, now);
  }
}
