import {
  sessionJobInitializationRequestSchema,
  sessionJobInitializationResponseSchema,
  type SessionJobInitializationRequest,
  type SessionJobInitializationResponse,
} from "@codeops/codeops-contracts";
import {
  boundedJson,
  exactGatewayOrigin,
  exactToken,
  requireSuccess,
  SessionRuntimeTransportError,
} from "./transport.js";

/**
 * Narrow Job bootstrap client. Its bearer can create only a root broker
 * session; it never crosses into the runtime claim/completion transport.
 */
export class SessionJobInitializer {
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
        "session Job initialization timeout must be between 1 and 30 seconds",
      );
    }
  }

  async initialize(
    rawRequest: SessionJobInitializationRequest,
  ): Promise<SessionJobInitializationResponse> {
    const request = sessionJobInitializationRequestSchema.parse(rawRequest);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#requestTimeoutMs,
    );
    try {
      const response = await this.#fetch(
        `${this.#origin}/v1/session-jobs/initializations`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.#token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(request),
        },
      );
      requireSuccess(response);
      const result = sessionJobInitializationResponseSchema.parse(
        await boundedJson(response),
      );
      const exactActiveLease =
        result.snapshot.lease?.status === "active" &&
        result.snapshot.lease.leaseId === request.leaseId &&
        result.snapshot.lease.holderId === request.holderId;
      const duplicateReleasedLease =
        result.disposition === "duplicate" &&
        result.snapshot.lease?.status === "released";
      if (
        result.snapshot.sessionId !== request.sessionId ||
        JSON.stringify(result.snapshot.identity) !==
          JSON.stringify(request.identity) ||
        result.modelProxyToken === undefined ||
        (!exactActiveLease && !duplicateReleasedLease)
      ) {
        throw new SessionRuntimeTransportError(
          "session Job initialization response drifted from the requested root identity",
        );
      }
      return result;
    } catch (error) {
      if (error instanceof SessionRuntimeTransportError) throw error;
      throw new SessionRuntimeTransportError(
        `session Job initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
