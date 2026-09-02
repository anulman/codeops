import assert from "node:assert/strict";
import test from "node:test";
import {
  loadUnknownProviderEffectReconciliation,
  listProviderEffectReceipts,
  operatorResolveProviderEffect,
  recordProviderEffectReconciliation,
} from "../dist/provider-effect-receipts.js";

const row = {
  effect_id: `githubmutation-${"a".repeat(64)}`,
  provider: "github",
  repository: "anulman/codeops",
  operation: "review_thread_reply",
  pull_request_number: 39,
  target_id: "PRRT_thread",
  expected_head_sha: "b".repeat(40),
  payload_digest: `sha256:${"c".repeat(64)}`,
  permission_digest: `sha256:${"d".repeat(64)}`,
  session_id: "session-1",
  dispatch_id: "11111111-1111-4111-8111-111111111111",
  state: "unknown",
  authorized_at: new Date("2026-08-16T00:00:00.000Z"),
  attempted_at: new Date("2026-08-16T00:00:01.000Z"),
  resolved_at: null,
  reconciliation_action: "search_review_thread_marker",
  resolution_summary: null,
};

test("moves only stale attempting effects into reconciliation", async () => {
  const calls = [];
  await assert.rejects(loadUnknownProviderEffectReconciliation({
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: text.startsWith("UPDATE") ? 1 : 0, rows: [] };
    },
  }, row.effect_id, "operator@example.com"), /was not found/);
  assert.match(calls[0].text, /state = 'attempting'/);
  assert.match(calls[0].text, /interval '5 minutes'/);
  assert.match(calls[0].text, /session\.owner_principal_id = \$2/);
  assert.deepEqual(calls[0].values, [row.effect_id, "operator@example.com"]);
});

test("projects bounded provider effect attention without raw provider evidence", async () => {
  const calls = [];
  const effects = await listProviderEffectReceipts({
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: 1, rows: [row] };
    },
  }, 25, "operator@example.com");
  assert.equal(effects[0].state, "unknown");
  assert.equal(effects[0].reconciliationAction, "search_review_thread_marker");
  assert.equal("evidenceJson" in effects[0], false);
  assert.deepEqual(calls[0].values, [25, "operator@example.com"]);
  assert.match(calls[0].text, /WHEN 'unknown' THEN 0/);
  assert.match(calls[0].text, /session\.owner_principal_id = \$2/);
  await assert.rejects(listProviderEffectReceipts({ query() {} }, 201));
});

test("stores only bounded operator resolution evidence behind the unknown fence", async () => {
  const calls = [];
  await operatorResolveProviderEffect({
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
  }, {
    effectId: row.effect_id,
    principalId: "operator@example.com",
    resolution: "accepted_unknown",
    summary: "The operator accepts the unresolved provider attribution.",
    evidenceReferences: ["ticket:CODEOPS-123"],
    now: () => new Date("2026-08-16T00:03:00.000Z"),
  });
  assert.match(calls[0].text, /state = 'operator_resolved'/);
  assert.deepEqual(JSON.parse(calls[0].values[0]), {
    evidenceReferences: ["ticket:CODEOPS-123"],
    resolution: "accepted_unknown",
  });
  assert.equal(calls[0].values[2], "operator@example.com");
  assert.match(calls[0].text, /session\.owner_principal_id = \$3/);
  await assert.rejects(operatorResolveProviderEffect({ query() {} }, {
    effectId: row.effect_id,
    principalId: "operator@example.com",
    resolution: "accepted_unknown",
    summary: "x",
    evidenceReferences: ["x".repeat(501)],
  }), /evidence is invalid/);
});

test("records only a bounded terminal reconciliation behind the unknown-state fence", async () => {
  const calls = [];
  const request = {
    version: "codeops.github-mutation-provider-request/v1",
    operation: "check_rerun",
    operationId: row.effect_id,
    input: {
      repository: row.repository,
      expectedHeadSha: row.expected_head_sha,
      checkRunId: 1234,
    },
    payloadDigest: row.payload_digest,
    permissionDigest: row.permission_digest,
    provenance: {
      sessionId: row.session_id,
      dispatchId: row.dispatch_id,
      admissionId: "22222222-2222-4222-8222-222222222222",
      sessionGeneration: 1,
      sessionLeaseId: "33333333-3333-4333-8333-333333333333",
      permissionRequestId: "permission-runtime",
      authorizationExpiresAt: "2026-08-31T12:00:00.000Z",
      principalDigest: `sha256:${"e".repeat(64)}`,
    },
  };
  await recordProviderEffectReconciliation({
    async query(text, values) {
      calls.push({ text, values });
      return { rowCount: 1, rows: [] };
    },
  }, {
    request,
    principalId: "codeops:agents-ui",
    reconciliation: {
      version: "codeops.github-mutation-reconciliation-result/v1",
      state: "reconciled_not_observed",
      result: null,
      summary: "The exact prior provider state remains after the consistency window.",
    },
    now: () => new Date("2026-08-16T00:02:00.000Z"),
  });
  assert.match(calls[0].text, /state = 'unknown'/);
  assert.equal(calls[0].values[0], "reconciled_not_observed");
  assert.equal(calls[0].values[3], "codeops:agents-ui");
  assert.match(calls[0].text, /session\.owner_principal_id = \$4/);

  calls.length = 0;
  await recordProviderEffectReconciliation({ query() { throw new Error("must not write"); } }, {
    request,
    principalId: "codeops:agents-ui",
    reconciliation: {
      version: "codeops.github-mutation-reconciliation-result/v1",
      state: "unknown",
      result: null,
      summary: "Attribution remains ambiguous.",
    },
  });
  assert.equal(calls.length, 0);
});
