import { createSessionProofNamespaceFromOperatorPacket } from "./codeops-session-proof-operator-namespace-create.mjs";

const result = createSessionProofNamespaceFromOperatorPacket({
  packetPath: process.env.CODEOPS_SESSION_PROOF_PACKET,
  admissionPath: process.env.CODEOPS_SESSION_PROOF_ADMISSION,
  receiptPath: process.env.CODEOPS_SESSION_PROOF_NAMESPACE_RECEIPT,
  observedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.proceed) process.exitCode = 1;
