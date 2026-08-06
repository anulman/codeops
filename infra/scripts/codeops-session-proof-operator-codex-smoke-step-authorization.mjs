import { execFileSync } from "node:child_process";
import {
  readSessionProofOperatorArtifact,
} from "./codeops-session-proof-operator-admission.mjs";
import {
  readSessionProofCodexLoginWaitOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-codex-login-wait.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeEleventhSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readSessionProofCodexLoginWaitOutputsFromOperatorPacket(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const codexSmokeManifestSource = readSessionProofOperatorArtifact(input, "codex-smoke");
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
    ],
    artifactSource: codexSmokeManifestSource,
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
