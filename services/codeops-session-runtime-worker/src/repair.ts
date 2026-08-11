import {
  sessionRuntimeDispatchSchema,
  type SessionRuntimeDispatch,
} from "@codeops/codeops-contracts";
import {
  sessionRuntimeDispatchDigest,
  type RuntimeExecutionReceiptStore,
} from "./lifecycle.js";
import {
  runtimeExecutionResultSchema,
  SessionRuntimeTransportError,
  type RuntimeExecutionResult,
} from "./transport.js";

/**
 * Adopts a result established by an explicit out-of-band reconciliation.
 * This function never invokes ACP or workspace operations. It only completes
 * an existing started reservation when dispatch, digest, and result type are
 * exact, making repair an auditable separate action rather than an automatic
 * retry path in the polling worker.
 */
export async function reconcileIncompleteRuntimeExecution(input: {
  readonly dispatch: SessionRuntimeDispatch;
  readonly result: RuntimeExecutionResult;
  readonly receipts: RuntimeExecutionReceiptStore;
}): Promise<RuntimeExecutionResult> {
  const dispatch = sessionRuntimeDispatchSchema.parse(input.dispatch);
  const result = runtimeExecutionResultSchema.parse(input.result);
  if (result.type !== dispatch.command.type) {
    throw new SessionRuntimeTransportError(
      "session runtime repair result type drifted from the immutable dispatch",
    );
  }
  const digest = sessionRuntimeDispatchDigest(dispatch);
  const reservation = await input.receipts.read(dispatch.dispatchId);
  if (
    reservation === null ||
    reservation.dispatchId !== dispatch.dispatchId ||
    reservation.dispatchDigest !== digest
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime repair requires the exact incomplete reservation",
    );
  }
  if (reservation.result !== null) {
    const replay = runtimeExecutionResultSchema.parse(reservation.result);
    if (JSON.stringify(replay) !== JSON.stringify(result)) {
      throw new SessionRuntimeTransportError(
        "session runtime repair conflicted with the reconciled result",
      );
    }
    return replay;
  }
  const stored = await input.receipts.complete({
    dispatchId: dispatch.dispatchId,
    dispatchDigest: digest,
    result,
  });
  const completed = runtimeExecutionResultSchema.parse(stored.result);
  if (
    stored.dispatchId !== dispatch.dispatchId ||
    stored.dispatchDigest !== digest ||
    completed.type !== dispatch.command.type ||
    JSON.stringify(completed) !== JSON.stringify(result)
  ) {
    throw new SessionRuntimeTransportError(
      "session runtime repair conflicted with the reconciled result",
    );
  }
  return completed;
}
