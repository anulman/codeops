import { execFileSync } from "node:child_process";
import {
  readSessionProofOperatorArtifact,
} from "./codeops-session-proof-operator-admission.mjs";
import {
  readSecondSessionProofCredentialOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-runtime-credential-issuance.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeThirdSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readSecondSessionProofCredentialOutputsFromOperatorPacket(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const databaseManifestSource = readSessionProofOperatorArtifact(input, "database");
  return authorizeSessionProofStep({
    planSource: outputs.planSource,
    creationReceiptSource: outputs.creationReceiptSource,
    priorReceiptSources: [outputs.stepReceiptSource, outputs.secondStepReceiptSource],
    artifactSource: databaseManifestSource,
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
