import { execFileSync } from "node:child_process";
import { applySessionProofRuntime } from "./codeops-session-proof-runtime-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readFifteenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-step-authorization.mjs";

export function applySessionProofRuntimeFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofRuntime,
) {
  const { authorization } =
    readFifteenthSessionProofStepAuthorizationFromOperatorPacket(input, runner);
  const manifestSource = readSessionProofOperatorArtifact(input, "runtime");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}
