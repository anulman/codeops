import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PostgresWorkspaceCheckpointArtifactStore } from "../dist/workspace-artifacts.js";

const content = Buffer.from("durable patch\n");
const artifact = {
  artifactId: "artifact:99999999-9999-4999-8999-999999999999:source:codeops",
  sessionId: "ses_test",
  generation: 1,
  checkpointId: "99999999-9999-4999-8999-999999999999",
  kind: "source-patch",
  catalogKey: "codeops",
  digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  content,
};

test("inserts one bounded artifact and verifies an idempotent replay", async () => {
  const calls = [];
  const row = {
    artifact_id: artifact.artifactId,
    session_id: artifact.sessionId,
    generation: "1",
    checkpoint_id: artifact.checkpointId,
    artifact_kind: artifact.kind,
    catalog_key: artifact.catalogKey,
    artifact_digest: artifact.digest,
    artifact_bytes: String(content.byteLength),
  };
  const database = {
    query: async (text, values) => {
      calls.push({ text, values });
      return text.startsWith("INSERT")
        ? { rows: [] }
        : { rows: [row] };
    },
  };
  await new PostgresWorkspaceCheckpointArtifactStore(database).put(artifact);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values.at(-1), content);
  assert.match(calls[1].text, /WHERE artifact_id = \$1/);
});

test("rejects content or replay identity drift", async () => {
  await assert.rejects(
    new PostgresWorkspaceCheckpointArtifactStore({ query: async () => assert.fail() })
      .put({ ...artifact, digest: `sha256:${"0".repeat(64)}` }),
    /digest does not match/,
  );
  const database = {
    query: async (text) => text.startsWith("INSERT")
      ? { rows: [] }
      : { rows: [{
          artifact_id: artifact.artifactId,
          session_id: "different-session",
          generation: "1",
          checkpoint_id: artifact.checkpointId,
          artifact_kind: artifact.kind,
          catalog_key: artifact.catalogKey,
          artifact_digest: artifact.digest,
          artifact_bytes: String(content.byteLength),
        }] },
  };
  await assert.rejects(
    new PostgresWorkspaceCheckpointArtifactStore(database).put(artifact),
    /identity conflicts/,
  );
});
