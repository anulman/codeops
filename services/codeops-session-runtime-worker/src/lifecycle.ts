import { createHash } from "node:crypto";
import {
  sessionRuntimeDispatchSchema,
  type SessionRuntimeDispatch,
} from "@codeops/codeops-contracts";
import {
  runtimeExecutionResultSchema,
  SessionRuntimeTransportError,
  type RuntimeExecutionResult,
  type RuntimeExecutor,
} from "./transport.js";

export interface RuntimeExecutionReceipt {
  readonly dispatchId: string;
  readonly dispatchDigest: string;
  readonly result: RuntimeExecutionResult;
}

export interface RuntimeExecutionReservation {
  readonly dispatchId: string;
  readonly dispatchDigest: string;
  readonly result: RuntimeExecutionResult | null;
}

/**
 * The production implementation must durably compare-and-create receipts.
 * Returning a pre-existing receipt is permitted only when it is byte-for-byte
 * the same immutable dispatch/result pair.
 */
export interface RuntimeExecutionReceiptStore {
  read(dispatchId: string): Promise<RuntimeExecutionReservation | null>;
  reserve(input: {
    readonly dispatchId: string;
    readonly dispatchDigest: string;
  }): Promise<{
    readonly acquired: boolean;
    readonly reservation: RuntimeExecutionReservation;
  }>;
  complete(receipt: RuntimeExecutionReceipt): Promise<RuntimeExecutionReceipt>;
}

type RuntimeDispatchFor<Type extends RuntimeExecutionResult["type"]> =
  SessionRuntimeDispatch & {
    readonly command: Extract<
      SessionRuntimeDispatch["command"],
      { readonly type: Type }
    >;
  };

/**
 * Command-specific ACP/workspace operations. Implementations may see the
 * immutable dispatch, but never the worker bearer token or claim token.
 */
export interface AcpWorkspaceLifecycle {
  prompt(dispatch: RuntimeDispatchFor<"prompt">): Promise<RuntimeExecutionResult>;
  checkpoint(
    dispatch: RuntimeDispatchFor<"checkpoint">,
  ): Promise<RuntimeExecutionResult>;
  hibernate(
    dispatch: RuntimeDispatchFor<"hibernate">,
  ): Promise<RuntimeExecutionResult>;
  resume(dispatch: RuntimeDispatchFor<"resume">): Promise<RuntimeExecutionResult>;
  fork(dispatch: RuntimeDispatchFor<"fork">): Promise<RuntimeExecutionResult>;
}

export function sessionRuntimeDispatchDigest(
  dispatch: SessionRuntimeDispatch,
): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(dispatch))
    .digest("hex")}`;
}

function exactReceipt(
  raw: RuntimeExecutionReservation,
  dispatch: SessionRuntimeDispatch,
  digest: string,
): RuntimeExecutionResult {
  if (raw.result === null) {
    throw new SessionRuntimeTransportError(
      "session runtime lifecycle operation is incomplete and requires repair",
    );
  }
  const result = runtimeExecutionResultSchema.parse(raw.result);
  if (
    raw.dispatchId !== dispatch.dispatchId ||
    raw.dispatchDigest !== digest ||
    result.type !== dispatch.command.type
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime lifecycle receipt drifted from the immutable dispatch",
    );
  }
  return result;
}

async function executeCommand(
  lifecycle: AcpWorkspaceLifecycle,
  dispatch: SessionRuntimeDispatch,
): Promise<RuntimeExecutionResult> {
  switch (dispatch.command.type) {
    case "prompt":
      return lifecycle.prompt(dispatch as RuntimeDispatchFor<"prompt">);
    case "checkpoint":
      return lifecycle.checkpoint(
        dispatch as RuntimeDispatchFor<"checkpoint">,
      );
    case "hibernate":
      return lifecycle.hibernate(dispatch as RuntimeDispatchFor<"hibernate">);
    case "resume":
      return lifecycle.resume(dispatch as RuntimeDispatchFor<"resume">);
    case "fork":
      return lifecycle.fork(dispatch as RuntimeDispatchFor<"fork">);
  }
}

/**
 * Reserve one dispatch durably before invoking ACP/workspace side effects, then
 * retain the prepared result. Reclaims replay completed work; an incomplete
 * reservation fails closed for operator reconciliation rather than risking a
 * repeated prompt, checkpoint, resume, or fork.
 */
export function createSessionRuntimeLifecycleExecutor(input: {
  readonly lifecycle: AcpWorkspaceLifecycle;
  readonly receipts: RuntimeExecutionReceiptStore;
}): RuntimeExecutor {
  return async (rawDispatch) => {
    const dispatch = sessionRuntimeDispatchSchema.parse(rawDispatch);
    const digest = sessionRuntimeDispatchDigest(dispatch);
    const existing = await input.receipts.read(dispatch.dispatchId);
    if (existing !== null) return exactReceipt(existing, dispatch, digest);

    const reserved = await input.receipts.reserve({
      dispatchId: dispatch.dispatchId,
      dispatchDigest: digest,
    });
    if (!reserved.acquired) {
      return exactReceipt(reserved.reservation, dispatch, digest);
    }

    const result = runtimeExecutionResultSchema.parse(
      await executeCommand(input.lifecycle, dispatch),
    );
    if (result.type !== dispatch.command.type) {
      throw new SessionRuntimeTransportError(
        "session runtime lifecycle result type drifted from the immutable dispatch",
      );
    }
    const proposed = { dispatchId: dispatch.dispatchId, dispatchDigest: digest, result };
    const stored = await input.receipts.complete(proposed);
    const replay = exactReceipt(stored, dispatch, digest);
    if (JSON.stringify(replay) !== JSON.stringify(result)) {
      throw new SessionRuntimeTransportError(
        "session runtime lifecycle receipt conflicted with prepared execution",
      );
    }
    return replay;
  };
}
