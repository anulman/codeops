import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { buildSessionProofOperatorItinerary } from "./codeops-session-proof-operator-itinerary.mjs";

const PACKET_VERSION = "codeops.renoconcierge.ca/session-proof-operator-packet/v1";
const FILES = {
  namespace: "artifacts/namespace.yaml",
  database: "artifacts/database.yaml",
  gateway: "artifacts/gateway.yaml",
  grants: "artifacts/grants.yaml",
  "codex-login": "artifacts/codex-login.yaml",
  "codex-smoke": "artifacts/codex-smoke.yaml",
  ui: "artifacts/ui.yaml",
  runtime: "artifacts/runtime.yaml",
};
const EXPECTED_FILES = [...Object.values(FILES), "itinerary.json", "plan.json"].sort();

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function assertRealDirectory(path, mode, label) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (mode !== null && (stat.mode & 0o777) !== mode)
  ) {
    throw new Error(`${label} must be one real directory with its required mode`);
  }
}

function readPrivateFile(path, label) {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.size < 2 ||
    before.size > 1024 * 1024
  ) {
    throw new Error(`${label} must be one bounded private regular file`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const source = readFileSync(descriptor);
    const after = lstatSync(path);
    if (
      source.length !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      (after.mode & 0o777) !== 0o600 ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return source;
  } finally {
    closeSync(descriptor);
  }
}

function assertPacketLayout(packetPath) {
  if (!isAbsolute(packetPath ?? "") || resolve(packetPath) !== packetPath) {
    throw new Error("proof operator packet path must be absolute and normalized");
  }
  assertRealDirectory(dirname(packetPath), null, "proof operator packet parent");
  assertRealDirectory(packetPath, 0o700, "proof operator packet");
  assertRealDirectory(join(packetPath, "artifacts"), 0o700, "proof operator artifact directory");
  const roots = readdirSync(packetPath).sort();
  if (JSON.stringify(roots) !== JSON.stringify(["artifacts", "itinerary.json", "packet-manifest.json", "plan.json"])) {
    throw new Error("proof operator packet root inventory drifted");
  }
  const artifacts = readdirSync(join(packetPath, "artifacts"))
    .map((name) => `artifacts/${name}`)
    .sort();
  if (JSON.stringify(artifacts) !== JSON.stringify(EXPECTED_FILES.slice(0, 8))) {
    throw new Error("proof operator packet artifact inventory drifted");
  }
}

function readAndVerifyPacket(packetPath) {
  assertPacketLayout(packetPath);
  const manifestSource = readPrivateFile(join(packetPath, "packet-manifest.json"), "proof packet manifest");
  const manifest = parseJson(manifestSource, "proof packet manifest");
  const files = manifest.files;
  if (
    manifest.apiVersion !== PACKET_VERSION ||
    manifest.state !== "reviewed-inputs-only" ||
    manifest.liveAccess !== false ||
    manifest.clusterMutation !== false ||
    manifest.adapterInvocation !== false ||
    manifest.directoryMode !== "0700" ||
    !Array.isArray(files) ||
    files.length !== EXPECTED_FILES.length ||
    JSON.stringify(files.map((file) => file.path).sort()) !== JSON.stringify(EXPECTED_FILES) ||
    files.some((file) => file.mode !== "0600" ||
      JSON.stringify(Object.keys(file).sort()) !== JSON.stringify(["bytes", "mode", "path", "sha256"]))
  ) {
    throw new Error("proof operator packet manifest drifted");
  }
  const sources = {};
  for (const record of files) {
    const source = readPrivateFile(join(packetPath, record.path), `proof packet ${record.path}`);
    if (source.length !== record.bytes || digest(source) !== record.sha256) {
      throw new Error(`proof packet ${record.path} bytes drifted`);
    }
    sources[record.path] = source;
  }
  const planSource = sources["plan.json"].toString("utf8");
  const plan = parseJson(planSource, "proof packet plan");
  if (
    digest(planSource) !== manifest.planSha256 ||
    JSON.stringify(plan.identity) !== JSON.stringify(manifest.identity) ||
    basename(packetPath) !== `${plan.identity?.namespace ?? ""}.packet`
  ) {
    throw new Error("proof operator packet identity drifted");
  }
  const artifactSources = Object.fromEntries(Object.entries(FILES).map(
    ([id, path]) => [id, sources[path].toString("utf8")],
  ));
  const itinerarySource = `${JSON.stringify(buildSessionProofOperatorItinerary({
    planSource,
    artifactSources,
  }), null, 2)}\n`;
  if (!sources["itinerary.json"].equals(Buffer.from(itinerarySource))) {
    throw new Error("proof operator packet itinerary drifted");
  }
  const fileRecord = (path, source) => ({
    path,
    sha256: digest(source),
    bytes: Buffer.byteLength(source),
    mode: "0600",
  });
  const records = [fileRecord("plan.json", planSource)];
  for (const [id, path] of Object.entries(FILES)) {
    records.push(fileRecord(path, artifactSources[id]));
  }
  records.push(fileRecord("itinerary.json", itinerarySource));
  const expectedManifestSource = `${JSON.stringify({
    apiVersion: PACKET_VERSION,
    state: "reviewed-inputs-only",
    liveAccess: false,
    clusterMutation: false,
    adapterInvocation: false,
    planSha256: digest(planSource),
    identity: plan.identity,
    directoryMode: "0700",
    files: records,
  }, null, 2)}\n`;
  if (!manifestSource.equals(Buffer.from(expectedManifestSource))) {
    throw new Error("proof operator packet manifest is not the exact derived inventory");
  }
  return { manifestSource, manifest, planSource };
}

function assertAdmissionPath(admissionPath, packetPath, namespace) {
  if (!isAbsolute(admissionPath ?? "") || resolve(admissionPath) !== admissionPath) {
    throw new Error("proof operator admission path must be absolute and normalized");
  }
  if (
    dirname(admissionPath) !== dirname(packetPath) ||
    basename(admissionPath) !== `${namespace}.admission.json`
  ) {
    throw new Error("proof operator admission path must derive exactly from the packet Namespace");
  }
}

function writeAdmission(path, source) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, source);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function attachSessionProofOperatorAdmission(input) {
  const packet = readAndVerifyPacket(input.packetPath ?? "");
  assertAdmissionPath(
    input.admissionPath ?? "",
    input.packetPath,
    packet.manifest.identity.namespace,
  );
  const admission = createSessionProofAdmission({
    planSource: packet.planSource,
    reviewedPlanSha256: packet.manifest.planSha256,
    operator: input.operator,
    target: input.target,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
  });
  const admissionSource = `${JSON.stringify(admission, null, 2)}\n`;
  writeAdmission(input.admissionPath, admissionSource);
  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-operator-admission-attachment/v1",
    result: "attached-approved-unbound-admission",
    packetPath: input.packetPath,
    admissionPath: input.admissionPath,
    packetManifestSha256: digest(packet.manifestSource),
    admissionSha256: digest(admissionSource),
    planSha256: admission.planSha256,
    identity: admission.identity,
    liveAccess: false,
    clusterMutation: false,
    adapterInvocation: false,
  };
}
