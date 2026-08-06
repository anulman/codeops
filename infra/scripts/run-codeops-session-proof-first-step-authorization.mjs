import { persistFirstSessionProofStepAuthorizationFromOperatorPacket } from "./codeops-session-proof-operator-step-authorization.mjs";

const result = persistFirstSessionProofStepAuthorizationFromOperatorPacket({
  packetPath: process.env.CODEOPS_SESSION_PROOF_PACKET,
  admissionPath: process.env.CODEOPS_SESSION_PROOF_ADMISSION,
  receiptPath: process.env.CODEOPS_SESSION_PROOF_NAMESPACE_RECEIPT,
  authorizationPath: process.env.CODEOPS_SESSION_PROOF_STEP_AUTHORIZATION,
  observedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
