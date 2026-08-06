import { execFileSync } from "node:child_process";
import { waitForSessionProofGatewayMigration } from "./codeops-session-proof-gateway-wait.mjs";
import {
  readSessionProofGatewayApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-apply.mjs";
import {
  readSixthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-wait-authorization.mjs";

export function waitForSessionProofGatewayMigrationFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGatewayMigration = waitForSessionProofGatewayMigration,
) {
  const { authorization } = readSixthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofGatewayApplyOutputsFromOperatorPacket(input, runner);
  return waitForGatewayMigration({
    authorization,
    gatewayApplyReceiptSource: outputs.fifthStepReceiptSource,
    gatewayApplyEvidenceSource: outputs.fifthEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}
