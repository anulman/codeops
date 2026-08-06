import { execFileSync } from "node:child_process";
import { readSessionProofOperatorCreationReceipt } from "./codeops-session-proof-operator-namespace-create.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { authorizeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";

export function authorizeFirstSessionProofStepFromOperatorPacket(
  input,
  runner = execFileSync,
) {
  const operatorInput = readSessionProofOperatorCreationReceipt(input);
  if (operatorInput.creationReceipt.proceed !== true) {
    throw new Error("proof Namespace creation did not admit the first intermediate step");
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    operatorInput.creationReceipt.namespace.name,
    runner,
  );
  return authorizeSessionProofStep({
    planSource: operatorInput.planSource,
    creationReceiptSource: operatorInput.creationReceiptSource,
    priorReceiptSources: [],
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });
}
