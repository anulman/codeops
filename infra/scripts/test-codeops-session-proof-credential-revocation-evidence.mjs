import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSessionProofCredentialRevocationEvidence,
  sessionProofCredentialNames,
  verifySessionProofCredentialRevocationEvidence,
} from "./codeops-session-proof-credential-revocation-evidence.mjs";

const authorization = {
  planSha256: "a".repeat(64),
  stepId: "revoke-capabilities",
  action: "operator-revoke-exact-secrets",
  namespace: { name: "codeops-session-proof-video-1", uid: "namespace-uid-1" },
};

test("attests exact absence of all broker and runtime credentials", () => {
  const evidence = buildSessionProofCredentialRevocationEvidence({
    authorization,
    observedAt: "2026-08-05T19:15:00Z",
    absentCredentialNames: sessionProofCredentialNames().reverse(),
  });
  assert.equal(evidence.result, "verified");
  assert.equal(evidence.absentCredentialNames.length, 9);
  assert.deepEqual(evidence.absentCredentialNames, sessionProofCredentialNames());
});

test("rejects missing, extra, duplicate, or wrong-step absence evidence", () => {
  const build = (names, auth = authorization) =>
    buildSessionProofCredentialRevocationEvidence({
      authorization: auth,
      observedAt: "2026-08-05T19:15:00Z",
      absentCredentialNames: names,
    });
  const names = sessionProofCredentialNames();
  assert.throws(() => build(names.slice(1)), /evidence drifted/);
  assert.throws(() => build([...names, "unreviewed-secret"]), /evidence drifted/);
  assert.throws(() => build([...names, names[0]]), /evidence drifted/);
  assert.throws(
    () => build(names, { ...authorization, stepId: "stop-runtime" }),
    /not exact credential revocation/,
  );
});

test("rejects identity and timestamp drift", () => {
  const names = sessionProofCredentialNames();
  assert.throws(() => buildSessionProofCredentialRevocationEvidence({
    authorization,
    observedAt: "not-a-time",
    absentCredentialNames: names,
  }), /evidence drifted/);
  const evidence = buildSessionProofCredentialRevocationEvidence({
    authorization,
    observedAt: "2026-08-05T19:15:00Z",
    absentCredentialNames: names,
  });
  assert.throws(() => verifySessionProofCredentialRevocationEvidence(authorization, {
    ...evidence,
    namespace: { name: "wrong", uid: "namespace-uid-1" },
  }), /evidence drifted/);
});
