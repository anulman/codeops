import { execFileSync } from "node:child_process";
import {
  readSessionProofRuntimeStopOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-stop.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeNineteenthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
  readRuntimeStopOutputs = readSessionProofRuntimeStopOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const outputs = readRuntimeStopOutputs(input, runner);
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
      outputs.eighteenthStepReceiptSource,
    ],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
