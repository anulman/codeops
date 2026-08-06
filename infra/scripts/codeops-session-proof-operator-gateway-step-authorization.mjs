import { execFileSync } from "node:child_process";
import {
  readSessionProofOperatorArtifact,
} from "./codeops-session-proof-operator-admission.mjs";
import {
  readSessionProofDatabaseWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-database-wait.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeFifthSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readSessionProofDatabaseWaitOutputsFromOperatorPacket(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const gatewayManifestSource = readSessionProofOperatorArtifact(input, "gateway");
  return authorizeSessionProofStep({
    planSource: outputs.planSource,
    creationReceiptSource: outputs.creationReceiptSource,
    priorReceiptSources: [
      outputs.stepReceiptSource,
      outputs.secondStepReceiptSource,
      outputs.thirdStepReceiptSource,
      outputs.fourthStepReceiptSource,
    ],
    artifactSource: gatewayManifestSource,
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
