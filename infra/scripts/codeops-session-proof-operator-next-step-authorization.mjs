import { execFileSync } from "node:child_process";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  readFirstSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-step-authorization.mjs";
import {
  readFirstSessionProofCredentialOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-credential-issuance.mjs";
import {
  authorizeSessionProofStep,
  completeSessionProofStep,
} from "./codeops-session-proof-step-receipts.mjs";

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function readAndVerifyFirstCredentialOutputs(input, runner) {
  const outputs = readFirstSessionProofCredentialOutputsFromOperatorPacket(input);
  const { authorization } = readFirstSessionProofStepAuthorizationFromOperatorPacket(
    input,
    runner,
  );
  const evidence = parseJson(outputs.evidenceSource, "proof first-step evidence");
  const receipt = parseJson(outputs.stepReceiptSource, "proof first-step receipt");
  if (
    receipt.checkedAt !== evidence.observedAt ||
    Date.parse(receipt.checkedAt ?? "") < Date.parse(authorization.authorizedAt)
  ) {
    throw new Error("proof first-step output timestamps drifted");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  const expected = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: receipt.checkedAt,
    evidenceSource: outputs.evidenceSource,
  });
  const expectedSource = `${JSON.stringify(expected, null, 2)}\n`;
  if (outputs.stepReceiptSource !== expectedSource) {
    throw new Error("proof first-step receipt is not the exact persisted artifact");
  }
  return outputs;
}

export function authorizeSecondSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const outputs = readAndVerifyFirstCredentialOutputs(input, runner);
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    outputs.creationReceipt.namespace.name,
    runner,
  );
  return authorizeSessionProofStep({
    planSource: outputs.planSource,
    creationReceiptSource: outputs.creationReceiptSource,
    priorReceiptSources: [outputs.stepReceiptSource],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
