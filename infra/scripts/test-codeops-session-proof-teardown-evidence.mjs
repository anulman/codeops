import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildSessionProofCredentialRevocationEvidence,
  sessionProofCredentialNames,
} from "./codeops-session-proof-credential-revocation-evidence.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";
import {
  buildSessionProofNamespaceDeleteReceipt,
  buildSessionProofTeardownReceipt,
} from "./codeops-session-proof-teardown-evidence.mjs";

const planSha256 = "a".repeat(64);
const namespace = { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" };
const authorization = {
  planSha256,
  stepId: "revoke-capabilities",
  action: "operator-revoke-exact-secrets",
  namespace,
};
const revocationEvidenceSource = JSON.stringify(buildSessionProofCredentialRevocationEvidence({
  authorization,
  observedAt: "2026-08-05T06:20:00Z",
  absentCredentialNames: sessionProofCredentialNames(),
}));
const revocationReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  checkedAt: "2026-08-05T06:21:00Z",
  planSha256,
  namespace,
  stepIndex: sessionProofSequence().findIndex((step) => step.id === "revoke-capabilities"),
  stepId: "revoke-capabilities",
  action: "operator-revoke-exact-secrets",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: "b".repeat(64),
  evidenceSha256: createHash("sha256").update(revocationEvidenceSource).digest("hex"),
});

function buildDelete() {
  return buildSessionProofNamespaceDeleteReceipt({
    planSha256,
    namespace,
    observedAt: "2026-08-05T06:22:00Z",
    revocationReceiptSource,
    revocationEvidenceSource,
    deletionAccepted: true,
  });
}

test("chains exact revocation, Namespace deletion, and final absence receipts", () => {
  const deletion = buildDelete();
  const deleteReceiptSource = JSON.stringify(deletion.receipt);
  const teardown = buildSessionProofTeardownReceipt({
    planSha256,
    namespace,
    observedAt: "2026-08-05T06:23:00Z",
    deleteReceiptSource,
    deleteEvidenceSource: deletion.evidenceSource,
    namespaceAbsent: true,
  });
  assert.equal(deletion.receipt.stepId, "delete-namespace");
  assert.equal(teardown.receipt.stepId, "verify-teardown");
  assert.equal(teardown.receipt.previousReceiptSha256,
    createHash("sha256").update(deleteReceiptSource).digest("hex"));
});

test("rejects revocation, deletion evidence, final absence, or time drift", () => {
  assert.throws(() => buildSessionProofNamespaceDeleteReceipt({
    planSha256,
    namespace,
    observedAt: "2026-08-05T06:22:00Z",
    revocationReceiptSource,
    revocationEvidenceSource: `${revocationEvidenceSource}\n`,
    deletionAccepted: true,
  }));
  const deletion = buildDelete();
  const deleteReceiptSource = JSON.stringify(deletion.receipt);
  for (const input of [
    { namespaceAbsent: false, observedAt: "2026-08-05T06:23:00Z" },
    { namespaceAbsent: true, observedAt: "2026-08-05T06:21:30Z" },
    { namespaceAbsent: true, observedAt: "2026-08-05T06:23:00Z", deleteEvidenceSource: `${deletion.evidenceSource}\n` },
    {
      namespaceAbsent: true,
      observedAt: "2026-08-05T06:23:00Z",
      deleteEvidenceSource: JSON.stringify({ ...JSON.parse(deletion.evidenceSource), extra: true }),
    },
  ]) {
    assert.throws(() => buildSessionProofTeardownReceipt({
      planSha256,
      namespace,
      deleteReceiptSource,
      deleteEvidenceSource: deletion.evidenceSource,
      ...input,
    }));
  }
});
