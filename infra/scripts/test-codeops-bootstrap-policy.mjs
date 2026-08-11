import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootstrapNamespace,
  evaluateBootstrapDeployPlan,
} from "./codeops-bootstrap-policy.mjs";

const now = new Date("2026-07-25T18:45:00.000Z");
const candidateSha = "7592cda8feb15224d4aff0a1e42bd828abf476ce";

function plan(overrides = {}) {
  return {
    candidateSha,
    namespace: bootstrapNamespace(candidateSha),
    targetEnvironment: "codeops-bootstrap",
    deployAuthority: "trusted-external-supervisor",
    candidateHasDeployCredential: false,
    mutatesSharedDev: false,
    mutatesProduction: false,
    acceptanceVerdictWriter: "independent-acceptance",
    maxConcurrentRuns: 1,
    cleanupRequired: true,
    expiresAt: "2026-07-26T06:45:00.000Z",
    sourceGates: {
      codeopsCi: "success",
      prGuardrails: "success",
      acceptanceRunnerGuardrails: "success",
    },
    imageDigests: {
      orchestrator: `sha256:${"a".repeat(64)}`,
      "session-gateway": `sha256:${"b".repeat(64)}`,
    },
    ...overrides,
  };
}

test("accepts an exact-SHA disposable bootstrap deployment", () => {
  const result = evaluateBootstrapDeployPlan(plan(), { now });
  assert.equal(result.ok, true);
  assert.equal(result.namespace, "codeops-bootstrap-7592cda8feb1");
});

test("binds the namespace to the exact candidate SHA", () => {
  const result = evaluateBootstrapDeployPlan(plan({ namespace: "codeops-bootstrap-other" }), {
    now,
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /namespace must be/);
});

test("requires every trusted source gate", () => {
  const value = plan();
  value.sourceGates.prGuardrails = "pending";
  const result = evaluateBootstrapDeployPlan(value, { now });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /source gate prGuardrails must be success/);
});

test("rejects candidate deploy authority and shared-environment mutation", () => {
  const result = evaluateBootstrapDeployPlan(
    plan({
      deployAuthority: "candidate-workflow",
      candidateHasDeployCredential: true,
      mutatesSharedDev: true,
      mutatesProduction: true,
    }),
    { now },
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /trusted external supervisor/);
  assert.match(result.reasons.join("\n"), /must not receive a deploy credential/);
  assert.match(result.reasons.join("\n"), /exclude shared dev/);
  assert.match(result.reasons.join("\n"), /exclude production/);
});

test("keeps acceptance independent and concurrency capped", () => {
  const result = evaluateBootstrapDeployPlan(
    plan({
      acceptanceVerdictWriter: "candidate",
      maxConcurrentRuns: 2,
      cleanupRequired: false,
    }),
    { now },
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /independent acceptance identity/);
  assert.match(result.reasons.join("\n"), /concurrency must be exactly one/);
  assert.match(result.reasons.join("\n"), /cleanup must be required/);
});

test("requires immutable image digests", () => {
  const result = evaluateBootstrapDeployPlan(
    plan({ imageDigests: { orchestrator: "sha-7592cda" } }),
    { now },
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /invalid immutable image digest/);
});

test("requires a future expiry no more than 24 hours away", () => {
  const expired = evaluateBootstrapDeployPlan(
    plan({ expiresAt: "2026-07-25T18:44:00.000Z" }),
    { now },
  );
  const unbounded = evaluateBootstrapDeployPlan(
    plan({ expiresAt: "2026-07-27T18:45:00.000Z" }),
    { now },
  );
  assert.match(expired.reasons.join("\n"), /must be in the future/);
  assert.match(unbounded.reasons.join("\n"), /within 24 hours/);
});

test("rejects malformed candidate identity", () => {
  const result = evaluateBootstrapDeployPlan(
    plan({ candidateSha: "7592cda", namespace: "codeops-bootstrap-7592cda" }),
    { now },
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /40-character Git SHA/);
});
