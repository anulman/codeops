import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJsonText, sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { verifyRetainedSourceEvidence, readRetainedSourceEvidence,
  serveRetainedSourceRecovery } from "../dist/retained-source-recovery.js";

const uuid = (n) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ type: "spki", format: "pem" });
const token = "operator-token-".repeat(4);
const envelope = (evidence) => ({ evidence,
  signature: sign(null, Buffer.from("codeops.retained-source-evidence/v1\0" +
    canonicalJsonText(evidence)), privateKey).toString("base64") });

function fixture() {
  const snapshot = {
    version: "codeops.session-snapshot/v1", sessionId: "session-retained", generation: 1,
    state: "running", identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: { version: "codeops.session-policy/v1", mode: "implement",
        workspaceAccess: "bounded-writes", modelCalls: "allowed",
        modelPolicy: { provider: "openai", model: "gpt-5.6-sol", reasoningEffort: "medium" } },
      workspace: { version: "codeops.workspace/v1", sources: [{ catalogKey: "project",
        repository: "example/project", checkoutPath: "sources/project",
        requestedRef: "main", resolvedSha: "a".repeat(40) }], scratchPath: "scratch" },
      workflowId: "workspace-launch", runId: "retained-run", displayName: "Retained source",
      parentSessionId: null, forkedAtCursor: null,
    },
    lease: { leaseId: uuid("3"), generation: 1, status: "active", holderId: "worker",
      acquiredAt: "2026-09-08T00:00:00.000Z", expiresAt: "2026-09-08T23:00:00.000Z" },
    checkpoint: null, pendingPermission: null, eventCursor: 4,
    capabilities: ["prompt", "respond_permission", "cancel", "checkpoint", "hibernate", "resume", "fork", "archive"]
      .map((action) => action === "prompt" ? { action, availability: "enabled" } :
        { action, availability: "disabled", reason: "Unavailable." }),
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
  const dispatch = { version: "codeops.session-runtime-dispatch/v1", dispatchId: uuid("2"),
    principalId: "operator:alice", command: { version: "codeops.session-command/v1",
      sessionId: snapshot.sessionId, generation: 1, leaseId: uuid("3"),
      idempotencyKey: uuid("4"), type: "prompt", prompt: "Prepare a candidate." },
    snapshot: structuredClone(snapshot), dispatchedAt: "2026-09-08T00:00:00.000Z" };
  const history = { session: { session_id: snapshot.sessionId, snapshot_json: structuredClone(snapshot) },
    dispatch: { dispatch_id: uuid("2"), session_id: snapshot.sessionId,
      admission_id: uuid("5"), dispatch_json: dispatch, status: "claimed",
      claim_token: uuid("6"), completion_json: null, claim_expires_at: "2026-09-08T00:10:00.000Z" },
    progress: [{ resource_configuration_digest: null }], checkpoints: [] };
  const candidate = { version: "codeops.github-branch-publish-candidate/v1",
    binding: { repository: "example/project", baseSha: "a".repeat(40),
      baseTreeSha: "b".repeat(40), treeSha: "c".repeat(40) },
    changes: [{ path: "new.txt", oldText: "", newText: "retained content", exact: {
      baseBlobSha: null, baseMode: null, mode: "100644" } }] };
  const candidateDigest = sha256CanonicalJsonDigest(candidate);
  const evidence = { version: "codeops.retained-source-evidence/v1", recoveryId: uuid("1"),
    origin: "retained-source", retainedSourceId: "retained-object",
    sourceManifestDigest: `sha256:${"f".repeat(64)}`,
    historical: { sessionId: snapshot.sessionId, dispatchId: uuid("2"),
      digest: sha256CanonicalJsonDigest(history), checkpointBindingFailed: true,
      workerState: "terminated", terminationEvidenceId: "termination-evidence" },
    authority: { principalId: "operator:alice", sessionId: snapshot.sessionId,
      generation: 1, leaseId: uuid("3"), expiresAt: "2026-09-08T23:00:00.000Z" },
    candidate, candidateDigest,
    checks: { candidateDigest, sourceManifestDigest: `sha256:${"f".repeat(64)}`,
      focused: "accepted", full: "accepted",
      qualificationEvidenceId: "isolated-gate", reviewEvidenceId: "review-evidence",
      reviewerId: "independent-reviewer", review: "accepted" },
    publication: { baseBranch: "main", branchName: "retained-source", commitMessage: "Publish retained source",
      title: "Retained source", body: "Verified source changes.", draft: false },
  };
  return { snapshot, history, evidence };
}

test("only verifier signatures over exact retained source and accepted checks are admitted", () => {
  const e = fixture().evidence;
  assert.deepEqual(verifyRetainedSourceEvidence(envelope(e), key), e);
  for (const mutate of [
    (e) => { e.candidate.changes[0].newText = "forged"; },
    (e) => { e.checks.reviewEvidenceId = "forged-review"; },
    (e) => { e.authority.principalId = "operator:mallory"; },
    (e) => { e.historical.digest = `sha256:${"0".repeat(64)}`; },
  ]) {
    const signed = envelope(structuredClone(e)); mutate(signed.evidence);
    assert.throws(() => verifyRetainedSourceEvidence(signed, key));
  }
  const inconsistent = structuredClone(e); inconsistent.checks.candidateDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => verifyRetainedSourceEvidence(envelope(inconsistent), key));
  const assertion = structuredClone(e); assertion.historical.runtimeSucceeded = true;
  assert.throws(() => verifyRetainedSourceEvidence(envelope(assertion), key));
  const rejectedReview = structuredClone(e); rejectedReview.checks.review = "rejected";
  assert.throws(() => verifyRetainedSourceEvidence(envelope(rejectedReview), key));
  const differentManifest = structuredClone(e); differentManifest.checks.sourceManifestDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => verifyRetainedSourceEvidence(envelope(differentManifest), key));
  const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => verifyRetainedSourceEvidence(envelope(e), wrongKey));
});

test("service evidence reads reject symlinks, traversal, digest drift and unsigned files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "retained-source-test-"));
  try {
    const e = fixture().evidence, d = sha256CanonicalJsonDigest(e);
    const file = path.join(root, `${d.slice(7)}.json`);
    await writeFile(file, JSON.stringify(envelope(e)));
    assert.deepEqual(await readRetainedSourceEvidence(root, d, key), e);
    await assert.rejects(readRetainedSourceEvidence(root, "../outside", key));
    await rm(file); await symlink("missing-target", file);
    await assert.rejects(readRetainedSourceEvidence(root, d, key));
    await rm(file); await writeFile(file, JSON.stringify({ evidence: e, signature: "A".repeat(86) + "==" }));
    await assert.rejects(readRetainedSourceEvidence(root, d, key));
    const other = structuredClone(e); other.retainedSourceId = "other-source";
    await writeFile(file, JSON.stringify(envelope(other)));
    await assert.rejects(readRetainedSourceEvidence(root, d, key));
  } finally { await rm(root, { recursive: true, force: true }); }
});

function service() {
  const f = fixture(), rows = new Map(), effects = new Map(), writes = [];
  let clock = "2026-09-08T01:00:00.000Z", providerCalls = 0, priorEffects = [];
  let fail = false;
  const client = { release() {}, async query(sql, values = []) {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (sql.includes("SELECT snapshot_json")) return { rows: values[1] === "operator:alice"
      ? [{ snapshot_json: f.snapshot, database_now: clock }] : [] };
    if (sql.includes("jsonb_build_object")) return { rows: [{ history: f.history }] };
    if (sql.includes("FROM codeops.provider_effect_receipts")) return { rows: priorEffects };
    if (sql.includes("SELECT clock_timestamp()")) return { rows: [{ now: clock }] };
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
      assert.match(sql, /codeops\.retained_source_(recoveries|effects)/);
      writes.push(sql);
    }
    if (sql.includes("INSERT INTO codeops.retained_source_recoveries")) {
      if (!rows.has(values[0])) rows.set(values[0], { evidence_digest: values[1], evidence_json: JSON.parse(values[2]) });
    } else if (sql.includes("FROM codeops.retained_source_recoveries")) {
      return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
    } else if (sql.includes("INSERT INTO codeops.retained_source_effects")) {
      assert.ok(!effects.has(values[1]));
      effects.set(values[1], { request_json: JSON.parse(values[3]), state: "attempting", attempted_at: clock, result_json: null });
    } else if (sql.includes("FROM codeops.retained_source_effects")) {
      const row = effects.get(values[1] ?? "branch"); return { rows: row ? [row] : [] };
    } else if (sql.includes("UPDATE codeops.retained_source_effects")) {
      Object.assign(effects.get(values[1]), { state: values[2], result_json: JSON.parse(values[3]) });
    } else throw Error(`Unexpected SQL ${sql}`);
    return { rows: [] };
  } };
  const branchResult = (request) => ({ version: "codeops.github-branch-publish-result/v1",
    operationId: request.operationId, repository: request.input.repository,
    baseBranch: "main", branchName: "retained-source", baseSha: "a".repeat(40),
    headSha: "d".repeat(40), url: "https://github.com/example/project/tree/retained-source" });
  const call = (action, principal = "operator:alice", body) => serveRetainedSourceRecovery({
    method: "POST", url: `/v1/retained-source-recoveries/${f.evidence.recoveryId}/${action}`,
    headers: { authorization: `Bearer ${token}`, "x-codeops-principal": principal, "content-type": "application/json" }, token,
    readBody: async () => body ?? { evidenceDigest: sha256CanonicalJsonDigest(f.evidence) },
    loadEvidence: async () => verifyRetainedSourceEvidence(envelope(f.evidence), key),
    connect: async () => client,
    resolveRepository: (repository) => assert.equal(repository, "example/project"),
    mutate: async (request) => { providerCalls++; if (fail) throw Error("response lost");
      assert.equal(request.provenance.sourceRecoveryId, f.evidence.recoveryId);
      assert.equal(request.provenance.dispatchId, f.evidence.historical.dispatchId);
      if (request.operation === "pull_request_create") return {
        version: "codeops.github-pull-request-create-result/v1", operationId: request.operationId,
        repository: request.input.repository, pullRequestNumber: 1,
        headSha: request.input.expectedHeadSha, baseSha: request.input.expectedBaseSha,
        headBranch: request.input.headBranch, baseBranch: request.input.baseBranch,
        title: request.input.title, body: request.input.body, draft: request.input.draft,
        url: "https://github.com/example/project/pull/1",
      };
      return branchResult(request); },
    reconcile: async (request) => ({ version: "codeops.github-mutation-reconciliation-result/v1",
      state: "reconciled_satisfied", result: branchResult(request), summary: "Exact tree and marker observed." }),
  });
  return { ...f, call, writes, effects, providerCalls: () => providerCalls,
    loseResponse: () => { fail = true; }, advance: () => { clock = "2026-09-08T02:00:00.000Z"; },
    priorEffect: () => { priorEffects = [{ effect_id: "existing-unknown" }]; } };
}

test("finalization and duplicate publication preserve all historical and null progress evidence", async () => {
  const f = service(), before = structuredClone(f.history);
  assert.equal((await f.call("finalize")).body.state, "source-finalized");
  assert.equal((await f.call("branch")).body.state, "succeeded");
  assert.equal((await f.call("branch")).status, 200);
  assert.equal(f.providerCalls(), 1);
  assert.deepEqual(f.history, before);
  assert.equal(f.history.progress[0].resource_configuration_digest, null);
  assert.equal(f.history.dispatch.completion_json, null);
});

test("lost provider outcomes require reconciliation and cannot trigger another mutation", async () => {
  const f = service(); f.loseResponse();
  assert.equal((await f.call("branch")).body.state, "unknown");
  await assert.rejects(f.call("branch"), /cannot be retried/);
  await assert.rejects(f.call("reconcile-branch"), /attempt window/);
  f.advance();
  assert.equal((await f.call("reconcile-branch")).body.state, "reconciled_satisfied");
  await f.call("branch");
  assert.equal(f.providerCalls(), 1);
});

test("ready PR publication uses accepted evidence and the real published head with recovered origin", async () => {
  const f = service();
  await assert.rejects(f.call("pull-request"));
  assert.equal(f.providerCalls(), 0);
  await f.call("branch");
  const response = await f.call("pull-request");
  assert.equal(response.body.result.headSha, "d".repeat(40));
  assert.equal(response.body.result.draft, false);
  assert.match(response.body.result.body, /Source origin: recovered retained source/);
  assert.match(response.body.result.body, /does not assert historical runtime success/);
  await f.call("pull-request");
  assert.equal(f.providerCalls(), 2);
});

test("stale authority, old source, historical effects and user approval assertions fail before writes", async () => {
  for (const mutate of [
    (f) => { f.snapshot.generation++; },
    (f) => { f.snapshot.lease.leaseId = uuid("7"); },
    (f) => { f.evidence.authority.expiresAt = "2026-09-08T00:00:00.000Z"; },
    (f) => { f.history.progress[0].resource_configuration_digest = `sha256:${"a".repeat(64)}`; },
    (f) => { f.history.dispatch.completion_json = { fabricated: true }; },
    (f) => { f.evidence.candidate.binding.baseSha = "e".repeat(40);
      f.evidence.candidateDigest = sha256CanonicalJsonDigest(f.evidence.candidate);
      f.evidence.checks.candidateDigest = f.evidence.candidateDigest; },
    (f) => f.priorEffect(),
  ]) {
    const f = service(); mutate(f);
    await assert.rejects(f.call("finalize"));
    assert.equal(f.writes.length, 0); assert.equal(f.providerCalls(), 0);
  }
  const f = service();
  assert.equal((await f.call("finalize", "session-runtime:worker")).status, 401);
  await assert.rejects(f.call("finalize", "operator:mallory"));
  await assert.rejects(f.call("finalize", "operator:alice", { evidenceDigest: sha256CanonicalJsonDigest(f.evidence), approved: true }));
  assert.equal(f.writes.length, 0);
});
