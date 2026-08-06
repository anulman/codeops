import { execFileSync } from "node:child_process";
import { applySessionProofGrants } from "./codeops-session-proof-grant-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readSeventhSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-step-authorization.mjs";

export function applySessionProofGrantsFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofGrants,
) {
  const { authorization } = readSeventhSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const manifestSource = readSessionProofOperatorArtifact(input, "grants");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}
