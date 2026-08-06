import { execFileSync } from "node:child_process";
import {
  readSessionProofOperatorArtifact,
} from "./codeops-session-proof-operator-admission.mjs";
import {
  readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-gateway-wait.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeSeventhSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readSessionProofGatewayMigrationWaitOutputsFromOperatorPacket(
    input,
    runner,
  );
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const grantsManifestSource = readSessionProofOperatorArtifact(input, "grants");
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
    ],
    artifactSource: grantsManifestSource,
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
