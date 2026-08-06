import { execFileSync } from "node:child_process";
import {
  readSessionProofCodexSmokeReplacementOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-smoke-replace.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeTwelfthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readSessionProofCodexSmokeReplacementOutputsFromOperatorPacket(
    input,
    runner,
  );
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  return authorizeSessionProofStep({
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
    ],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
