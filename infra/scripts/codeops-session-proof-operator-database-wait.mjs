import { execFileSync } from "node:child_process";
import { waitForSessionProofDatabase } from "./codeops-session-proof-database-wait.mjs";
import {
  readSessionProofDatabaseApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-database-apply.mjs";
import {
  readFourthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-database-wait-authorization.mjs";

export function waitForSessionProofDatabaseFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForDatabase = waitForSessionProofDatabase,
) {
  const { authorization } = readFourthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofDatabaseApplyOutputsFromOperatorPacket(input, runner);
  return waitForDatabase({
    authorization,
    databaseApplyReceiptSource: outputs.thirdStepReceiptSource,
    databaseApplyEvidenceSource: outputs.thirdEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}
