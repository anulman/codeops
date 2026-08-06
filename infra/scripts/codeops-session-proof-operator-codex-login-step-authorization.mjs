import { execFileSync } from "node:child_process";
import {
  readSessionProofOperatorArtifact,
} from "./codeops-session-proof-operator-admission.mjs";
import {
  readSessionProofGrantWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-grant-wait.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeNinthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readSessionProofGrantWaitOutputsFromOperatorPacket(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const codexLoginManifestSource = readSessionProofOperatorArtifact(input, "codex-login");
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
    ],
    artifactSource: codexLoginManifestSource,
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
