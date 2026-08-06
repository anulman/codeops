import { execFileSync } from "node:child_process";
import { readSessionProofOperatorAdmissionAttachment } from "./codeops-session-proof-operator-admission.mjs";
import { runSessionProofPreflight } from "./codeops-session-proof-preflight.mjs";

export function runSessionProofOperatorPacketPreflight(input, runner = execFileSync) {
  const attachment = readSessionProofOperatorAdmissionAttachment(input);
  const preflight = runSessionProofPreflight({
    planSource: attachment.planSource,
    admission: attachment.admission,
    observedAt: input.observedAt,
  }, runner);
  return {
    ...preflight,
    apiVersion: "codeops.renoconcierge.ca/session-proof-operator-packet-preflight/v1",
    packetManifestSha256: attachment.packetManifestSha256,
    admissionSha256: attachment.admissionSha256,
  };
}
