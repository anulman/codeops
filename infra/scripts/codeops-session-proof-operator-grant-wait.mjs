import { execFileSync } from "node:child_process";
import { waitForSessionProofGrants } from "./codeops-session-proof-grant-wait.mjs";
import {
  readSessionProofGrantApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-apply.mjs";
import {
  readEighthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait-authorization.mjs";

export function waitForSessionProofGrantsFromOperatorPacket(
  input,
  runner = execFileSync,
  waitForGrants = waitForSessionProofGrants,
) {
  const { authorization } = readEighthSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const outputs = readSessionProofGrantApplyOutputsFromOperatorPacket(input, runner);
  return waitForGrants({
    authorization,
    grantApplyReceiptSource: outputs.seventhStepReceiptSource,
    grantApplyEvidenceSource: outputs.seventhEvidenceSource,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    maxAttempts: input.maxAttempts,
    pollIntervalMs: input.pollIntervalMs,
  }, runner);
}
