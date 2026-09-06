import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../sql/verified-checkpoint-recovery-v1.sql", import.meta.url);
const revertUrl = new URL("../sql/verified-checkpoint-recovery-v1-revert.sql", import.meta.url);
const repositoryUrl = new URL("../src/session-broker-repository.ts", import.meta.url);
const outboxUrl = new URL("../src/session-broker-runtime-outbox.ts", import.meta.url);
const recoveryUrl = new URL("../src/checkpoint-recovery.ts", import.meta.url);
const terminalUrl = new URL("../src/session-runtime-terminal-reconciler.ts", import.meta.url);

test("defines additive append-only verified recovery evidence without deletion effects", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  const revert = await readFile(revertUrl, "utf8");
  for (const table of ["workspace_checkpoint_descriptors",
    "workspace_checkpoint_restore_receipts", "workspace_checkpoint_hold_events",
    "workspace_checkpoint_retention_decisions", "workspace_checkpoint_cleanup_decisions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE codeops\\.${table}`));
  }
  assert.match(migration, /verified checkpoint evidence is append-only/);
  assert.match(migration, /workspace_checkpoint_artifacts_append_only/);
  assert.match(migration, /codeops\.checkpoint-descriptor\/v1/);
  assert.match(migration, /codeops\.restore-receipt\/v1/);
  assert.match(revert, /cannot revert verified checkpoint recovery while durable evidence exists/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP TABLE|TRUNCATE/);
});

test("abrupt runtime failure records terminal state without deleting its PVC or workspace", async () => {
  const terminal = await readFile(terminalUrl, "utf8");
  assert.match(terminal, /session_runtime_terminal_observations/);
  assert.match(terminal, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.doesNotMatch(terminal,
    /delete(?:Job|Pod|PersistentVolumeClaim|PersistentVolume)|removeResource|cleanupResources/);
  const recovery = await readFile(recoveryUrl, "utf8");
  assert.match(recovery, /restore-receipt-missing/);
});

test("finalizes evidence before the existing serializable completion commit", async () => {
  const repository = await readFile(repositoryUrl, "utf8");
  const outbox = await readFile(outboxUrl, "utf8");
  const recovery = await readFile(recoveryUrl, "utf8");
  assert.match(repository, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.ok(repository.indexOf("await input.finalize?.(client, result, committedAt)") <
    repository.lastIndexOf('await client.query("COMMIT")'));
  assert.match(outbox, /finalizeVerifiedCheckpoint/);
  assert.match(recovery, /checkpoint artifact live readback is incomplete or stale/);
  assert.match(recovery, /The sole fail-closed handoff to COAUTO-15/);
  assert.doesNotMatch(recovery, /deleteJob|deletePod|delete.*volume|removeResource/);
});
