import { execFileSync } from "node:child_process";
import {
  readSessionProofRuntimeApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-apply.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeSixteenthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
  readRuntimeApplyOutputs = readSessionProofRuntimeApplyOutputsFromOperatorPacket,
  authorizeStep = authorizeSessionProofStep,
) {
  const outputs = readRuntimeApplyOutputs(input, runner);
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
    ],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
