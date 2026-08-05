import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { buildSessionProofPlan } from "./codeops-session-proof-plan.mjs";
import { persistSessionProofOperatorPacket } from "./codeops-session-proof-operator-packet.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};
function resource(kind, name, namespace) {
  return { apiVersion: "v1", kind, metadata: { name, ...(namespace ? { namespace } : {}) } };
}
function manifest(resources) { return resources.map((value) => stringify(value)).join("---\n"); }
function fixture() {
  const namespace = resource("Namespace", identity.namespace);
  namespace.metadata.labels = {
    "app.kubernetes.io/part-of": "codeops-session-proof",
    "codeops.renoconcierge.ca/proof-run": identity.runId,
    "codeops.renoconcierge.ca/base-sha": identity.baseSha,
  };
  const targeted = (rows) => manifest(rows.map(([kind, name]) => resource(kind, name)));
  const explicit = (rows) => manifest(rows.map(([kind, name]) => resource(kind, name, identity.namespace)));
  const artifactSources = {
    namespace: manifest([namespace, resource("LimitRange", "codeops-session-proof", identity.namespace), resource("ResourceQuota", "codeops-session-proof", identity.namespace), resource("NetworkPolicy", "default-deny", identity.namespace)]),
    database: targeted([["ServiceAccount", "codeops-session-proof-database"], ["ConfigMap", "codeops-session-proof-database-init"], ["Deployment", "codeops-session-proof-database"], ["Service", "codeops-session-proof-database"], ["NetworkPolicy", "codeops-session-proof-database"]]),
    gateway: targeted([["ServiceAccount", "codeops-control-gateway"], ["Deployment", "codeops-control-gateway"], ["Service", "codeops-control-gateway"], ["NetworkPolicy", "codeops-control-gateway"]]),
    grants: targeted([["ServiceAccount", "codeops-session-proof-grants"], ["ConfigMap", "codeops-session-proof-grants"], ["Job", "codeops-session-proof-grants"], ["NetworkPolicy", "codeops-session-proof-grants"]]),
    "codex-login": explicit([["PersistentVolumeClaim", "codeops-codex-auth"], ["ServiceAccount", "codeops-codex-auth"], ["Job", "codeops-codex-auth-login"], ["NetworkPolicy", "codeops-codex-auth"]]),
    "codex-smoke": explicit([["PersistentVolumeClaim", "codeops-codex-auth"], ["ServiceAccount", "codeops-codex-auth"], ["Job", "codeops-codex-auth-smoke"], ["NetworkPolicy", "codeops-codex-auth"]]),
    ui: explicit([["ServiceAccount", "codeops-agents-ui"], ["Deployment", "codeops-agents-ui"], ["Service", "codeops-agents-ui"], ["NetworkPolicy", "codeops-agents-ui"]]),
    runtime: targeted([["ServiceAccount", "codeops-session-runtime-video-1"], ["Job", "codeops-session-runtime-video-1"], ["NetworkPolicy", "codeops-session-runtime-video-1"]]),
  };
  const files = Object.fromEntries(Object.entries(artifactSources).map(([id, source]) => [id, { path: `/tmp/${id}.yaml`, source }]));
  return { artifactSources, planSource: JSON.stringify(buildSessionProofPlan({ ...identity, files })) };
}

test("atomically persists one private exact-byte reviewed operator packet", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const input = fixture();
    const result = persistSessionProofOperatorPacket({ ...input, packetPath });
    assert.equal(result.result, "persisted-reviewed-inputs-only");
    assert.equal(result.fileCount, 11);
    assert.equal(lstatSync(packetPath).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(packetPath, "plan.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(packetPath, "plan.json"), "utf8"), input.planSource);
    const manifest = JSON.parse(readFileSync(join(packetPath, "packet-manifest.json"), "utf8"));
    assert.equal(manifest.state, "reviewed-inputs-only");
    assert.equal(manifest.clusterMutation, false);
    assert.equal(manifest.files.length, 10);
    for (const file of manifest.files) {
      const source = readFileSync(join(packetPath, file.path));
      assert.equal(source.length, file.bytes);
      assert.equal(createHash("sha256").update(source).digest("hex"), file.sha256);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses overwrite, path substitution, and a symbolic-link parent", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
  try {
    const input = fixture();
    const packetPath = join(root, `${identity.namespace}.packet`);
    persistSessionProofOperatorPacket({ ...input, packetPath });
    assert.throws(() => persistSessionProofOperatorPacket({ ...input, packetPath }), /already exists/);
    assert.throws(() => persistSessionProofOperatorPacket({ ...input, packetPath: join(root, "other.packet") }), /derive exactly/);
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    assert.throws(() => persistSessionProofOperatorPacket({
      ...input,
      packetPath: join(linkedParent, `${identity.namespace}.packet`),
    }), /real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects reviewed artifact drift before creating the packet", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
  try {
    const input = fixture();
    input.artifactSources.runtime += "\n";
    const packetPath = join(root, `${identity.namespace}.packet`);
    assert.throws(() => persistSessionProofOperatorPacket({ ...input, packetPath }), /artifact bytes drifted/);
    assert.throws(() => lstatSync(packetPath), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
