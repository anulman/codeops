import { execFileSync } from "node:child_process";
import { applySessionProofDatabase } from "./codeops-session-proof-database-apply.mjs";
import { readSessionProofOperatorArtifact } from "./codeops-session-proof-operator-admission.mjs";
import {
  readThirdSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-database-step-authorization.mjs";

export function applySessionProofDatabaseFromOperatorPacket(
  input,
  runner = execFileSync,
  apply = applySessionProofDatabase,
) {
  const { authorization } = readThirdSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const manifestSource = readSessionProofOperatorArtifact(input, "database");
  return apply({
    authorization,
    manifestSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
  }, runner);
}
