import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  checkpointCleanupDecisionSchema,
  checkpointDescriptorSchema,
  checkpointHoldEventSchema,
  checkpointRetentionDecisionSchema,
  sessionRuntimeCompletionSchema,
  sha256CanonicalJsonDigest,
} from "../dist/index.js";

const digest = (value) => `sha256:${value.repeat(64)}`;
const binding = {
  version: "codeops.checkpoint-workspace-binding/v1",
  sessionId: "ses_verified",
  generation: 2,
  workspaceJobUid: "11111111-1111-4111-8111-111111111111",
  resourceConfigurationDigest: digest("e"),
  workspaceConfigurationDigest: digest("a"),
  workspaceManifestDigest: digest("b"),
};
const manifest = {
  version: "codeops.checkpoint-manifest/v1",
  checkpointId: "22222222-2222-4222-8222-222222222222",
  binding,
  sourcePatches: [{
    artifactId: "artifact:22222222-2222-4222-8222-222222222222:source:codeops",
    catalogKey: "codeops", repository: "example/codeops",
    checkoutPath: "sources/codeops", baseSha: "c".repeat(40),
    bytes: 12, digest: digest("c"),
  }],
  scratchArtifact: {
    artifactId: "artifact:22222222-2222-4222-8222-222222222222:scratch",
    bytes: 20, digest: digest("d"),
  },
  pathSetDigest: digest("f"), pathCount: 1,
  totalBytes: 32,
  capturedAt: "2026-09-04T12:00:00.000Z",
};

test("accepts an exact versioned checkpoint descriptor and refuses mixed versions", () => {
  const descriptor = checkpointDescriptorSchema.parse({
    version: "codeops.checkpoint-descriptor/v1",
    manifest,
    manifestDigest: sha256CanonicalJsonDigest(manifest),
  });
  assert.equal(descriptor.manifest.binding.generation, 2);
  assert.throws(() => checkpointDescriptorSchema.parse({
    ...descriptor, version: "codeops.checkpoint-descriptor/v2",
  }));
  assert.throws(() => checkpointDescriptorSchema.parse({
    ...descriptor, manifest: { ...manifest, totalBytes: 31 },
  }), /total must be exact/);
  assert.throws(() => checkpointDescriptorSchema.parse({
    ...descriptor, manifest: { ...manifest, pathCount: 10_005 },
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(descriptor)) < 1024 * 1024);
  const maximum = checkpointDescriptorSchema.parse({ ...descriptor,
    manifest: { ...descriptor.manifest, pathCount: 10_004 } });
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) < 1024 * 1024);
});

test("maximum bounded path metadata remains in the artifact, below completion transport limit", () => {
  const paths = Array.from({ length: 9_999 }, (_, index) => ({
    path: `scratch/${String(index).padStart(5, "0")}-${"x".repeat(180)}`,
    type: "file", bytes: 0, digest: `sha256:${createHash("sha256").update("").digest("hex")}`, executable: false,
  }));
  const sources = Array.from({ length: 4 }, (_, index) => {
    const key = `${index}${"x".repeat(62)}`;
    return { artifactId: `artifact:${manifest.checkpointId}:source:${key}`, catalogKey: key,
      repository: `${"o".repeat(100)}/${index}${"r".repeat(99)}`,
      checkoutPath: `sources/${key}`, baseSha: "f".repeat(40), bytes: 2_000_000, digest: digest("c") };
  });
  const scratch = Buffer.from(JSON.stringify({ version: "codeops.scratch-artifact/v1", entries: [
    { path: ".", type: "directory" }, ...paths.map(entry => ({ ...entry,
      path: entry.path.slice("scratch/".length), contentBase64: "" })),
  ] }));
  const exactPaths = [...sources.map(source => ({ path: source.checkoutPath,
    type: "file", bytes: source.bytes, digest: source.digest, executable: false })), ...paths];
  const maximum = { ...manifest, binding: { ...binding, sessionId: "s".repeat(128),
    generation: Number.MAX_SAFE_INTEGER }, sourcePatches: sources,
    scratchArtifact: { ...manifest.scratchArtifact, bytes: scratch.byteLength,
      digest: `sha256:${createHash("sha256").update(scratch).digest("hex")}` },
    totalBytes: 8_000_000 + scratch.byteLength, pathCount: exactPaths.length,
    pathSetDigest: sha256CanonicalJsonDigest(exactPaths) };
  const completion = sessionRuntimeCompletionSchema.parse({
    version: "codeops.session-runtime-completion/v1",
    dispatchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sessionId: binding.sessionId,
    generation: 1, leaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", observedEventCursor: 1,
    completedAt: manifest.capturedAt, type: "hibernate", material: {
      version: "codeops.session-workspace-checkpoint-material/v2",
      descriptor: { version: "codeops.checkpoint-descriptor/v1", manifest: maximum,
        manifestDigest: sha256CanonicalJsonDigest(maximum) },
      acpSessionId: "a".repeat(500),
      evidenceReferences: [...sources.map(source => source.artifactId), maximum.scratchArtifact.artifactId],
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(paths)) > 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(completion)) < 16_384);
  assert.equal("pathSet" in completion.material.descriptor.manifest, false);
  assert.throws(() => sessionRuntimeCompletionSchema.parse({ ...completion, material: {
    ...completion.material, evidenceReferences: Array(5).fill(maximum.scratchArtifact.artifactId),
  } }));
});

test("keeps hold, retention, and cleanup records strict and versioned", () => {
  assert.equal(checkpointHoldEventSchema.parse({
    version: "codeops.checkpoint-hold-event/v1",
    eventId: "33333333-3333-4333-8333-333333333333",
    checkpointId: manifest.checkpointId, revision: 1, action: "placed",
    operatorPrincipalId: "operator:alice", reason: "Legal review",
    occurredAt: "2026-09-04T12:01:00.000Z",
  }).action, "placed");
  assert.throws(() => checkpointRetentionDecisionSchema.parse({
    version: "codeops.checkpoint-retention-decision/v1",
    decisionId: "44444444-4444-4444-8444-444444444444",
    checkpointId: manifest.checkpointId, policyRevision: 1, configured: true,
    retainUntil: "2026-09-04T13:00:00.000Z",
    expiresAt: "2026-09-04T12:30:00.000Z",
    decidedAt: "2026-09-04T12:00:00.000Z", operatorPrincipalId: "operator:alice",
  }), /ordered/);
  assert.equal(checkpointCleanupDecisionSchema.parse({
    version: "codeops.checkpoint-cleanup-decision/v1",
    decisionId: "55555555-5555-4555-8555-555555555555",
    checkpointId: manifest.checkpointId, authorized: false,
    reason: "policy-not-configured", decidedAt: "2026-09-04T12:00:00.000Z",
  }).reason, "policy-not-configured");
});
