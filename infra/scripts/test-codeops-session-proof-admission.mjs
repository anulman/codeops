import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  bindSessionProofNamespace,
  createSessionProofAdmission,
  verifySessionProofOperation,
} from "./codeops-session-proof-admission.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};
const operator = {
  username: "operator@example.com",
  uid: null,
  credentialSha256: "9".repeat(64),
};
const target = { context: "ovh-prod", server: "https://cluster.example.invalid" };
const approvedAt = "2026-08-05T05:00:00.000Z";
const expiresAt = "2026-08-05T08:00:00.000Z";
const artifactIds = [
  "namespace", "database", "gateway", "grants", "codex-login", "codex-smoke", "ui", "runtime",
];

function planSource() {
  return JSON.stringify({
    apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
    admission: "closed",
    execution: "render-and-review-only",
    identity,
    artifacts: artifactIds.map((id, index) => ({
      id,
      sha256: `${index}`.repeat(64),
    })),
    sequence: sessionProofSequence(),
  });
}

function admission() {
  const source = planSource();
  return createSessionProofAdmission({
    planSource: source,
    reviewedPlanSha256: createHash("sha256").update(source).digest("hex"),
    operator,
    target,
    approvedAt,
    expiresAt,
  });
}

function namespace(uid = "namespace-uid-1") {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: identity.namespace,
      uid,
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.renoconcierge.ca/proof-run": identity.runId,
        "codeops.renoconcierge.ca/base-sha": identity.baseSha,
      },
    },
  };
}

const observedAt = "2026-08-05T06:00:00.000Z";

test("admits only one reviewed plan digest, principal, target, and short window", () => {
  const value = admission();
  assert.equal(value.state, "approved-unbound");
  assert.equal(value.namespaceUid, null);
  assert.deepEqual(value.operator, operator);
  assert.deepEqual(value.target, target);
  assert.throws(() => createSessionProofAdmission({
    planSource: planSource(), reviewedPlanSha256: "f".repeat(64), operator, target,
    approvedAt, expiresAt,
  }));
  assert.throws(() => createSessionProofAdmission({
    planSource: planSource(),
    reviewedPlanSha256: createHash("sha256").update(planSource()).digest("hex"),
    operator, target, approvedAt, expiresAt: "2026-08-05T10:00:00.000Z",
  }));
});

test("allows creation only while absent, then binds every operation to the Namespace UID", () => {
  const unbound = admission();
  assert.equal(verifySessionProofOperation(unbound, {
    stepId: "create-namespace", namespaceResource: null, operator, target, observedAt,
  }), true);
  const bound = bindSessionProofNamespace(unbound, {
    namespaceResource: namespace(), operator, target, observedAt,
  });
  assert.equal(bound.namespaceUid, "namespace-uid-1");
  assert.equal(verifySessionProofOperation(bound, {
    stepId: "start-runtime", namespaceResource: namespace(), operator, target, observedAt,
  }), true);
  assert.equal(verifySessionProofOperation(bound, {
    stepId: "delete-namespace", namespaceResource: namespace(), operator, target, observedAt,
  }), true);
  assert.equal(verifySessionProofOperation(bound, {
    stepId: "verify-teardown", namespaceResource: null, operator, target, observedAt,
  }), true);
});

test("fails closed on principal, cluster, expiry, namespace labels, UID, or step drift", () => {
  const bound = bindSessionProofNamespace(admission(), {
    namespaceResource: namespace(), operator, target, observedAt,
  });
  const base = { stepId: "start-runtime", namespaceResource: namespace(), operator, target, observedAt };
  assert.throws(() => verifySessionProofOperation(bound, {
    ...base, operator: { ...operator, credentialSha256: "8".repeat(64) },
  }));
  assert.throws(() => verifySessionProofOperation(bound, {
    ...base, target: { ...target, context: "other" },
  }));
  assert.throws(() => verifySessionProofOperation(bound, {
    ...base, observedAt: "2026-08-05T09:00:00.000Z",
  }));
  assert.throws(() => verifySessionProofOperation(bound, {
    ...base, namespaceResource: namespace("replacement-uid"),
  }));
  const relabeled = namespace();
  relabeled.metadata.labels["codeops.renoconcierge.ca/proof-run"] = "other";
  assert.throws(() => verifySessionProofOperation(bound, {
    ...base, namespaceResource: relabeled,
  }));
  assert.throws(() => verifySessionProofOperation(bound, {
    ...base, stepId: "deploy-production",
  }));
  assert.throws(() => verifySessionProofOperation({
    ...bound, authorizedSteps: [...bound.authorizedSteps, "deploy-production"],
  }, {
    ...base, stepId: "deploy-production",
  }));
});
