import assert from "node:assert/strict";
import test from "node:test";

import { workItemRetryDispositionRequestSchema } from "../dist/index.js";

const ids = Array.from({ length: 12 }, (_, index) =>
  `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`);
const digest = (character) => `sha256:${character.repeat(64)}`;
const observation = {
  version: "codeops.session-runtime-terminal-observation/v1",
  sessionId: "session-attempt-1", generation: 1, leaseId: ids[3], runId: "run-one",
  job: { name: "workspace-attempt-1", uid: ids[4], resourceVersion: "42" }, pod: null,
  cause: { type: "failed", reason: "BackoffLimitExceeded", message: "failed", exitCode: 1 },
  terminalAt: "2026-08-30T10:00:00.000Z", observedAt: "2026-08-30T10:00:01.000Z",
};

function request(effect, kind = "retry-same-input", successor = {}) {
  return {
    version: "codeops.work-item-retry-disposition/v1", dispositionId: ids[0], lineageRevision: 1,
    rootAdmissionId: ids[1], predecessorSessionId: observation.sessionId, kind, reasonCode: "transient",
    authority: { repository: "example-org/example-repository",
      provider: { kind: "plane", workspaceId: ids[5], projectId: ids[6] }, workItemId: ids[7],
      workflowId: "workflow-one", runId: observation.runId, sourceSha: "a".repeat(40),
      ownerPrincipalId: "access:owner@example.com", predecessorGeneration: 1,
      predecessorLeaseId: observation.leaseId, expiresAt: "2026-08-31T09:00:00.000Z" },
    terminalObservation: observation, providerEffect: effect,
    budget: { rootBudgetId: "session-attempt-1", rootRevision: 1,
      providerRequestsConsumed: 1, outputTokensConsumed: 100 },
    successor: successor === null ? null : { admissionId: ids[8], sessionId: "session-attempt-2",
      generation: 1, leaseId: ids[9], holderId: "runtime-worker:attempt-2", dispatchId: ids[10],
      idempotencyKey: ids[11], prompt: "Retry the exact work.", inputDigest: digest("b"),
      candidateDigest: digest("c"), runtimeCapabilityDigest: digest("d"),
      runtimeRelease: `ghcr.io/example/runtime@${digest("e")}`, ...successor },
  };
}

test("admits only authoritative pre-effect proof or allowlisted transient failure", () => {
  const none = request({ state: "none", preEffectProofDigest: digest("f"), proofEventId: digest("1") });
  assert.equal(workItemRetryDispositionRequestSchema.parse(none).successor.sessionId, "session-attempt-2");
  const failed = request({ state: "failed", effectId: `githubmutation-${"2".repeat(64)}`,
    receiptDigest: digest("3"), failureCode: "provider_timeout" });
  assert.equal(workItemRetryDispositionRequestSchema.parse(failed).providerEffect.failureCode, "provider_timeout");
  assert.throws(() => workItemRetryDispositionRequestSchema.parse({ ...failed,
    providerEffect: { ...failed.providerEffect, failureCode: null } }), /transient failure code/);
});

for (const [state, kind] of [
  ["attempting", "reconcile-unknown-effect"], ["unknown", "reconcile-unknown-effect"],
  ["succeeded", "stop-terminal"], ["reconciled_satisfied", "stop-terminal"],
  ["not_attempted", "wait-external"], ["reconciled_not_observed", "wait-external"],
  ["operator_resolved", "wait-human"],
]) {
  test(`${state} records a non-admitting ${kind} disposition`, () => {
    const value = request({ state, effectId: `githubmutation-${"4".repeat(64)}`,
      receiptDigest: digest("5"), failureCode: null }, kind, null);
    assert.equal(workItemRetryDispositionRequestSchema.parse(value).successor, null);
    assert.throws(() => workItemRetryDispositionRequestSchema.parse({ ...value,
      kind: "retry-same-input", successor: request({ state: "none",
        preEffectProofDigest: digest("6"), proofEventId: digest("7") }).successor }));
  });
}

test("authorized fails closed without advertising an admitting resume", () => {
  const effect = { state: "authorized", effectId: `githubmutation-${"8".repeat(64)}`,
    receiptDigest: digest("9"), failureCode: null };
  assert.equal(workItemRetryDispositionRequestSchema.parse(
    request(effect, "stop-terminal", null)).successor, null);
  assert.throws(() => workItemRetryDispositionRequestSchema.parse(
    request(effect, "retry-same-input", null)), /cannot be resumed atomically/);
  assert.throws(() => workItemRetryDispositionRequestSchema.parse(request(effect)), /cannot admit a successor/);
});

test("strict disposition schemas reject identity drift and extra authority", () => {
  const value = request({ state: "none", preEffectProofDigest: digest("a"), proofEventId: digest("b") });
  assert.throws(() => workItemRetryDispositionRequestSchema.parse({ ...value, unexpected: true }));
  assert.throws(() => workItemRetryDispositionRequestSchema.parse({ ...value,
    terminalObservation: { ...observation, generation: 2 } }), /failed predecessor identity/);
  assert.throws(() => workItemRetryDispositionRequestSchema.parse({ ...value,
    successor: { ...value.successor, runtimeRelease: "ghcr.io/example/runtime:latest" } }));
});
