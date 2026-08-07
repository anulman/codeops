import { execFileSync } from "node:child_process";
import {
  readSessionProofRuntimeWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-wait.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeSeventeenthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
  readRuntimeWaitOutputs = readSessionProofRuntimeWaitOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const outputs = readRuntimeWaitOutputs(input, runner);
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
    ],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
