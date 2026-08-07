import { execFileSync } from "node:child_process";
import {
  readSixteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-wait-authorization.mjs";
import { waitForSessionProofRuntime } from "./codeops-session-proof-runtime-wait.mjs";

export function waitForSessionProofRuntimeFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForRuntime = waitForSessionProofRuntime,
  readAuthorization = readSixteenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeApplyOutputs } = readAuthorization(input, runner);
  return waitForRuntime({
    authorization,
    runtimeApplyReceiptSource: runtimeApplyOutputs.fifteenthStepReceiptSource,
    runtimeApplyEvidenceSource: runtimeApplyOutputs.fifteenthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}
