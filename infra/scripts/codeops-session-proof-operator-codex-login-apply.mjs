import { execFileSync } from "node:child_process";
import { applySessionProofCodexLogin } from "./codeops-session-proof-codex-login-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readNinthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-step-authorization.mjs";

export function applySessionProofCodexLoginFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofCodexLogin,
) {
  const { authorization } = readNinthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const manifestSource = readSessionProofOperatorArtifact(input, "codex-login");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}
