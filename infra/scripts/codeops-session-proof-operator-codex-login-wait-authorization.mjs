import { execFileSync } from "node:child_process";
import {
  readSessionProofCodexLoginApplyOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-apply.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeTenthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readSessionProofCodexLoginApplyOutputsFromOperatorPacket(input, runner);
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
    ],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
