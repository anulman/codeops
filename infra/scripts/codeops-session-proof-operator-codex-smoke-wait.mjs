import { execFileSync } from "node:child_process";
import { waitForSessionProofCodexSmoke } from "./codeops-session-proof-codex-smoke-wait.mjs";
import {
  readTwelfthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-wait-authorization.mjs";

export function waitForSessionProofCodexSmokeFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForSmoke = waitForSessionProofCodexSmoke,
) {
  const { authorization, replacementOutputs } =
    readTwelfthSessionProofStepAuthorizationFromOperatorPacket(input, runner);
  return waitForSmoke({
    authorization,
    smokeReplacementReceiptSource: replacementOutputs.eleventhStepReceiptSource,
    smokeReplacementEvidenceSource: replacementOutputs.eleventhEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}
