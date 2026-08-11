import { attachSessionProofOperatorAdmission } from "./codeops-session-proof-operator-admission.mjs";

const operatorUid = process.env.CODEOPS_SESSION_PROOF_OPERATOR_UID;
const result = attachSessionProofOperatorAdmission({
  packetPath: process.env.CODEOPS_SESSION_PROOF_PACKET,
  admissionPath: process.env.CODEOPS_SESSION_PROOF_ADMISSION,
  operator: {
    username: process.env.CODEOPS_SESSION_PROOF_OPERATOR_USERNAME,
    uid: operatorUid ? operatorUid : null,
    credentialSha256: process.env.CODEOPS_SESSION_PROOF_OPERATOR_CREDENTIAL_SHA256,
  },
  target: {
    context: process.env.CODEOPS_SESSION_PROOF_KUBE_CONTEXT,
    server: process.env.CODEOPS_SESSION_PROOF_KUBE_SERVER,
  },
  approvedAt: process.env.CODEOPS_SESSION_PROOF_APPROVED_AT,
  expiresAt: process.env.CODEOPS_SESSION_PROOF_EXPIRES_AT,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
