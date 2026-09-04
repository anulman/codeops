import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  sessionJobInitializationRequestSchema,
  sessionJobInitializationResponseSchema,
  type SessionRuntimeDispatch,
  type SessionJobInitializationRequest,
  type SessionJobInitializationResponse,
  type WorkspaceContextAttachment,
} from "@codeops/codeops-contracts";
import { verifyWorkspaceContextAttachments, workspaceContextAttachmentDescriptors } from
  "@codeops/codeops-contracts/workspace-context-node";
import { setTimeout as delay } from "node:timers/promises";
import {
  boundedJson,
  exactGatewayOrigin,
  exactToken,
  requireSuccess,
  SessionRuntimeTransportError,
} from "./transport.js";
import type { RuntimeExecutor } from "./transport.js";

export function admittedChildInitialDispatchExecutor(input: {
  readonly initialDispatchDigest: string;
  readonly contextAttachments: readonly WorkspaceContextAttachment[];
  readonly execute: RuntimeExecutor;
}): RuntimeExecutor {
  return async (dispatch, context) => {
    const dispatchDigest = `sha256:${createHash("sha256")
      .update(canonicalJsonText(dispatch)).digest("hex")}`;
    const exactInitialDispatch = dispatch.command.type === "prompt" &&
      dispatchDigest === input.initialDispatchDigest;
    if (context.isAdmittedInitialDispatch !== exactInitialDispatch) {
      throw new Error("admitted child initial dispatch marker or identity drifted before ACP exposure");
    }
    if (!context.isAdmittedInitialDispatch) return input.execute(dispatch, context);
    const admittedDispatch: SessionRuntimeDispatch = {
      ...dispatch,
      command: { ...dispatch.command, ...(input.contextAttachments.length === 0 ? {} : {
        contextAttachments: [...input.contextAttachments],
      }) },
    };
    return input.execute(admittedDispatch, context);
  };
}

/**
 * Narrow Job bootstrap client. Its bearer can create only a root broker
 * session; it never crosses into the runtime claim/completion transport.
 */
export class SessionJobInitializer {
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #retryDelaysMs: readonly number[];

  constructor(input: {
    readonly gatewayOrigin: string;
    readonly token: string;
    readonly fetch?: typeof fetch;
    readonly requestTimeoutMs?: number;
    readonly retryDelaysMs?: readonly number[];
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
    this.#retryDelaysMs = input.retryDelaysMs ?? [100, 250, 1_000];
    if (
      this.#retryDelaysMs.length > 8 ||
      this.#retryDelaysMs.some((value) =>
        !Number.isSafeInteger(value) || value < 0 || value > 10_000
      )
    ) {
      throw new SessionRuntimeTransportError(
        "session Job initialization retry delays must contain at most 8 values between 0 and 10 seconds",
      );
    }
  }

  async initialize(
    rawRequest: SessionJobInitializationRequest,
  ): Promise<SessionJobInitializationResponse> {
    const request = sessionJobInitializationRequestSchema.parse(rawRequest);
    const boundBoundary = request.version ===
      "codeops.session-job-initialization/v3";
    const path = boundBoundary
      ? "/v2/session-jobs/initializations"
      : "/v1/session-jobs/initializations";
    const body = JSON.stringify(request);
    const retryDelays = boundBoundary ? this.#retryDelaysMs : [];
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.#requestTimeoutMs,
        );
        try {
          response = await this.#fetch(`${this.#origin}${path}`, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${this.#token}`,
              "content-type": "application/json; charset=utf-8",
            },
            body,
          });
        } catch (error) {
          if (attempt === retryDelays.length) throw error;
          await delay(retryDelays[attempt]);
          continue;
        } finally {
          clearTimeout(timeout);
        }
        if (
          attempt < retryDelays.length &&
          [404, 408, 425, 429, 502, 503, 504].includes(response.status)
        ) {
          await response.body?.cancel();
          await delay(retryDelays[attempt]);
          continue;
        }
        break;
      }
      if (response === undefined) {
        throw new SessionRuntimeTransportError(
          "session Job initialization produced no gateway response",
        );
      }
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
      if ("admissionId" in request) {
        if (result.disposition !== "duplicate" || result.contextAttachments === undefined ||
            result.initialDispatchDigest === undefined) {
          throw new SessionRuntimeTransportError("admitted child initialization response is incomplete");
        }
        const attachments = verifyWorkspaceContextAttachments(result.contextAttachments);
        if (canonicalJsonText(workspaceContextAttachmentDescriptors(attachments)) !==
            canonicalJsonText(request.identity.contextAttachments)) {
          throw new SessionRuntimeTransportError("admitted child attachment bytes drifted from the exact descriptors");
        }
      }
      if (
        result.snapshot.sessionId !== request.sessionId ||
        JSON.stringify(result.snapshot.identity) !==
          JSON.stringify(request.identity) ||
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
    }
  }
}
