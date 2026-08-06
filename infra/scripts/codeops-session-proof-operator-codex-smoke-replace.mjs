import { execFileSync } from "node:child_process";
import { replaceSessionProofCodexSmoke } from "./codeops-session-proof-codex-smoke-replace.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readSessionProofCodexLoginWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-wait.mjs";
import {
  readEleventhSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-step-authorization.mjs";

export function replaceSessionProofCodexSmokeFromOperatorPacket(
  input,
  runner = execFileSync,
  replace = replaceSessionProofCodexSmoke,
) {
  const { authorization } = readEleventhSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofCodexLoginWaitOutputsFromOperatorPacket(input, runner);
  const manifestSource = readSessionProofOperatorArtifact(input, "codex-smoke");
  return replace({
    authorization,
    manifestSource,
    loginCompletionReceiptSource: outputs.tenthStepReceiptSource,
    loginCompletionEvidenceSource: outputs.tenthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, { runner });
}
