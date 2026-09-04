import { setTimeout as delay } from "node:timers/promises";
import type { SessionCommandResult } from "@codeops/codeops-contracts";
import {
  SessionRuntimeClaimUnavailableError,
  type RuntimeExecutor,
} from "./transport.js";

export interface RuntimeWorkerTransport {
  runOne(input: {
    readonly leaseMs: number;
    readonly execute: RuntimeExecutor;
    readonly onClaimAuthenticated?: () => void | Promise<void>;
  }): Promise<SessionCommandResult | null>;
}

export interface RuntimeWorkerLoopOptions {
  readonly transport: RuntimeWorkerTransport;
  readonly execute: RuntimeExecutor;
  readonly leaseMs: number;
  readonly idlePollMs: number;
  readonly signal: AbortSignal;
  readonly onCompleted?: (result: SessionCommandResult) => void | Promise<void>;
  readonly onClaimAuthenticated?: () => void | Promise<void>;
}

function boundedMilliseconds(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} milliseconds`);
  }
  return value;
}

/**
 * Claims and completes at most one dispatch at a time. An execution error is
 * terminal for this process: the claim may expire and be inspected/reclaimed,
 * but the loop never silently retries an ambiguous ACP/workspace operation.
 */
export async function runSessionRuntimeWorker(
  input: RuntimeWorkerLoopOptions,
): Promise<void> {
  const leaseMs = boundedMilliseconds(
    "session runtime claim lease",
    input.leaseMs,
    1_000,
    15 * 60_000,
  );
  const idlePollMs = boundedMilliseconds(
    "session runtime idle poll",
    input.idlePollMs,
    100,
    30_000,
  );

  while (!input.signal.aborted) {
    let result: SessionCommandResult | null;
    try {
      result = await input.transport.runOne({
        leaseMs,
        execute: input.execute,
        onClaimAuthenticated: input.onClaimAuthenticated,
      });
    } catch (error) {
      if (!(error instanceof SessionRuntimeClaimUnavailableError)) throw error;
      try {
        await delay(idlePollMs, undefined, { signal: input.signal });
      } catch (delayError) {
        if (input.signal.aborted) return;
        throw delayError;
      }
      continue;
    }
    if (result !== null) {
      await input.onCompleted?.(result);
      continue;
    }
    try {
      await delay(idlePollMs, undefined, { signal: input.signal });
    } catch (error) {
      if (input.signal.aborted) return;
      throw error;
    }
  }
}
