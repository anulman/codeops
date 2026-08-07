import { execFileSync } from "node:child_process";
import {
  readSessionProofRecordingOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-record.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeEighteenthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
  readRecordingOutputs = readSessionProofRecordingOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const outputs = readRecordingOutputs(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  return authorizeStep({
    planSource: outputs.planSource,
    creationReceiptSource: outputs.creationReceiptSource,
    priorReceiptSources: [
      outputs.stepReceiptSource,
      outputs.secondStepReceiptSource,
      outputs.thirdStepReceiptSource,
      outputs.fourthStepReceiptSource,
      outputs.fifthStepReceiptSource,
      outputs.sixthStepReceiptSource,
      outputs.seventhStepReceiptSource,
      outputs.eighthStepReceiptSource,
      outputs.ninthStepReceiptSource,
      outputs.tenthStepReceiptSource,
      outputs.eleventhStepReceiptSource,
      outputs.twelfthStepReceiptSource,
      outputs.thirteenthStepReceiptSource,
      outputs.fourteenthStepReceiptSource,
      outputs.fifteenthStepReceiptSource,
      outputs.sixteenthStepReceiptSource,
      outputs.seventeenthStepReceiptSource,
    ],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
