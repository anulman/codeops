import { runSessionProofOperatorPacketPreflight } from "./codeops-session-proof-operator-preflight.mjs";

const result = runSessionProofOperatorPacketPreflight({
  packetPath: process.env.CODEOPS_SESSION_PROOF_PACKET,
  admissionPath: process.env.CODEOPS_SESSION_PROOF_ADMISSION,
  observedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
