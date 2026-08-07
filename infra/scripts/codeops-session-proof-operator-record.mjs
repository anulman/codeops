import { execFileSync } from "node:child_process";
import {
  readSeventeenthSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-record-authorization.mjs";
import { completeSessionProofRecording } from "./codeops-session-proof-record.mjs";

export function completeSessionProofRecordingFromOperatorPacket(
  input,
  runner = execFileSync,
  record = completeSessionProofRecording,
  readAuthorization = readSeventeenthSessionProofStepAuthorizationFromOperatorPacket,
) {
  const { authorization, runtimeWaitOutputs } = readAuthorization(input, runner);
  return record({
    authorization,
    runtimeReadinessReceiptSource: runtimeWaitOutputs.sixteenthStepReceiptSource,
    runtimeReadinessEvidenceSource: runtimeWaitOutputs.sixteenthEvidenceSource,
    captureDirectory: input.captureDirectory,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    completedAt: input.completedAt,
    inspection: input.inspection,
  }, runner);
}
