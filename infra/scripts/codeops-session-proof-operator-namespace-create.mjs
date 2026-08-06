import { execFileSync } from "node:child_process";
import { createSessionProofNamespace } from "./codeops-session-proof-namespace-create.mjs";
import { readSessionProofOperatorAdmissionAttachment } from "./codeops-session-proof-operator-admission.mjs";

export function createSessionProofNamespaceFromOperatorPacket(input, runner = execFileSync) {
  const attachment = readSessionProofOperatorAdmissionAttachment(input);
  return createSessionProofNamespace({
    planSource: attachment.planSource,
    admission: attachment.admission,
    namespaceManifestSource: attachment.namespaceManifestSource,
    observedAt: input.observedAt,
  }, runner);
}
