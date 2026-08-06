import { execFileSync } from "node:child_process";
import { waitForSessionProofCodexLogin } from "./codeops-session-proof-codex-login-wait.mjs";
import {
  readSessionProofCodexLoginApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-apply.mjs";
import {
  readTenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-wait-authorization.mjs";

export function waitForSessionProofCodexLoginFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForLogin = waitForSessionProofCodexLogin,
) {
  const { authorization } = readTenthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofCodexLoginApplyOutputsFromOperatorPacket(input, runner);
  return waitForLogin({
    authorization,
    loginApplyReceiptSource: outputs.ninthStepReceiptSource,
    loginApplyEvidenceSource: outputs.ninthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}
