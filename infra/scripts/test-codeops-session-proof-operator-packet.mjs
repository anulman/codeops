import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { buildSessionProofPlan } from "./codeops-session-proof-plan.mjs";
import { persistSessionProofOperatorPacket } from "./codeops-session-proof-operator-packet.mjs";
import { attachSessionProofOperatorAdmission } from "./codeops-session-proof-operator-admission.mjs";
import { runSessionProofOperatorPacketPreflight } from "./codeops-session-proof-operator-preflight.mjs";

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
    "codeops.example/proof-run": identity.runId,
    "codeops.example/base-sha": identity.baseSha,
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

const certificateData = Buffer.from("synthetic-client-certificate").toString("base64");
const admissionInput = {
  operator: {
    username: "operator@example.com",
    uid: null,
    credentialSha256: createHash("sha256")
      .update(Buffer.from(certificateData, "base64"))
      .digest("hex"),
  },
  target: { context: "proof-context", server: "https://cluster.example.invalid" },
  approvedAt: "2026-08-05T05:00:00Z",
  expiresAt: "2026-08-05T08:00:00Z",
};

function preflightRunner() {
  const calls = [];
  const execute = (_file, args) => {
    calls.push(args);
    const command = args.join(" ");
    if (command === "config current-context") return `${admissionInput.target.context}\n`;
    if (command === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: admissionInput.target.server } }] });
    }
    if (command === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: admissionInput.operator.username } } });
    }
    if (command.includes("jsonpath={.users[0].user.client-certificate-data}")) {
      return certificateData;
    }
    if (command.startsWith("get namespace ")) return "";
    throw new Error(`unexpected kubectl call: ${command}`);
  };
  return { calls, execute };
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

test("attaches one private admission beside the exact immutable packet", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const admissionPath = join(root, `${identity.namespace}.admission.json`);
    const input = fixture();
    persistSessionProofOperatorPacket({ ...input, packetPath });
    const before = readFileSync(join(packetPath, "packet-manifest.json"));
    const result = attachSessionProofOperatorAdmission({
      packetPath,
      admissionPath,
      ...admissionInput,
    });
    assert.equal(result.result, "attached-approved-unbound-admission");
    assert.equal(result.liveAccess, false);
    assert.equal(result.clusterMutation, false);
    assert.equal(lstatSync(admissionPath).mode & 0o777, 0o600);
    const admission = JSON.parse(readFileSync(admissionPath, "utf8"));
    assert.equal(admission.state, "approved-unbound");
    assert.equal(admission.namespaceUid, null);
    assert.deepEqual(admission.identity, identity);
    assert.deepEqual(readFileSync(join(packetPath, "packet-manifest.json")), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses admission overwrite and path or authority substitution", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const admissionPath = join(root, `${identity.namespace}.admission.json`);
    persistSessionProofOperatorPacket({ ...fixture(), packetPath });
    assert.throws(() => attachSessionProofOperatorAdmission({
      packetPath,
      admissionPath,
      ...admissionInput,
      operator: { ...admissionInput.operator, credentialSha256: "not-a-digest" },
    }), /credential fingerprint/i);
    attachSessionProofOperatorAdmission({ packetPath, admissionPath, ...admissionInput });
    assert.throws(() => attachSessionProofOperatorAdmission({
      packetPath,
      admissionPath,
      ...admissionInput,
    }), /exist/i);
    assert.throws(() => attachSessionProofOperatorAdmission({
      packetPath,
      admissionPath: join(root, "other.admission.json"),
      ...admissionInput,
    }), /derive exactly/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a changed, extra, or permission-weakened packet before attachment", () => {
  const makePacket = () => {
    const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
    const packetPath = join(root, `${identity.namespace}.packet`);
    persistSessionProofOperatorPacket({ ...fixture(), packetPath });
    return { root, packetPath, admissionPath: join(root, `${identity.namespace}.admission.json`) };
  };
  for (const mutate of [
    ({ packetPath }) => writeFileSync(join(packetPath, "plan.json"), "{}"),
    ({ packetPath }) => writeFileSync(join(packetPath, "itinerary.json"), "{}"),
    ({ packetPath }) => writeFileSync(join(packetPath, "unexpected"), "extra"),
    ({ packetPath }) => chmodSync(join(packetPath, "plan.json"), 0o644),
  ]) {
    const paths = makePacket();
    try {
      mutate(paths);
      assert.throws(() => attachSessionProofOperatorAdmission({ ...paths, ...admissionInput }));
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  }
});

test("hands the exact packet and admission to the read-only live preflight", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const admissionPath = join(root, `${identity.namespace}.admission.json`);
    persistSessionProofOperatorPacket({ ...fixture(), packetPath });
    attachSessionProofOperatorAdmission({ packetPath, admissionPath, ...admissionInput });
    const runner = preflightRunner();
    const result = runSessionProofOperatorPacketPreflight({
      packetPath,
      admissionPath,
      observedAt: "2026-08-05T06:00:00Z",
    }, runner.execute);
    assert.equal(result.result, "ready-for-reviewed-namespace-creation");
    assert.equal(result.namespace.state, "absent");
    assert.match(result.packetManifestSha256, /^[0-9a-f]{64}$/);
    assert.match(result.admissionSha256, /^[0-9a-f]{64}$/);
    assert.equal(runner.calls.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects attachment drift before any Kubernetes read", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-packet-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const admissionPath = join(root, `${identity.namespace}.admission.json`);
    persistSessionProofOperatorPacket({ ...fixture(), packetPath });
    attachSessionProofOperatorAdmission({ packetPath, admissionPath, ...admissionInput });
    const admission = JSON.parse(readFileSync(admissionPath, "utf8"));
    writeFileSync(admissionPath, `${JSON.stringify({ ...admission, unexpected: true }, null, 2)}\n`);
    const runner = preflightRunner();
    assert.throws(() => runSessionProofOperatorPacketPreflight({
      packetPath,
      admissionPath,
      observedAt: "2026-08-05T06:00:00Z",
    }, runner.execute), /exact attached artifact/i);
    assert.equal(runner.calls.length, 0);
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
