import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { buildSessionProofOperatorItinerary } from "./codeops-session-proof-operator-itinerary.mjs";

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

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function writeDurableFile(path, source) {
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
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertPacketPath(packetPath, identity) {
  if (!isAbsolute(packetPath ?? "") || resolve(packetPath) !== packetPath) {
    throw new Error("proof operator packet path must be absolute and normalized");
  }
  if (basename(packetPath) !== `${identity.namespace}.packet`) {
    throw new Error("proof operator packet name must derive exactly from the Namespace");
  }
  const parent = dirname(packetPath);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) {
    throw new Error("proof operator packet parent must be a real directory");
  }
  try {
    lstatSync(packetPath);
    throw new Error("proof operator packet already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return parent;
}

function fileRecord(path, source) {
  return { path, sha256: digest(source), bytes: Buffer.byteLength(source), mode: "0600" };
}

export function persistSessionProofOperatorPacket(input) {
  const itinerary = buildSessionProofOperatorItinerary(input);
  const packetPath = input.packetPath ?? "";
  const parent = assertPacketPath(packetPath, itinerary.identity);
  const temporaryPath = join(parent, `.${basename(packetPath)}.${randomUUID()}.tmp`);
  const itinerarySource = `${JSON.stringify(itinerary, null, 2)}\n`;
  const records = [fileRecord("plan.json", input.planSource)];
  for (const [id, path] of Object.entries(FILES)) {
    records.push(fileRecord(path, input.artifactSources[id]));
  }
  records.push(fileRecord("itinerary.json", itinerarySource));
  const manifest = {
    apiVersion: "codeops.renoconcierge.ca/session-proof-operator-packet/v1",
    state: "reviewed-inputs-only",
    liveAccess: false,
    clusterMutation: false,
    adapterInvocation: false,
    planSha256: itinerary.planSha256,
    identity: itinerary.identity,
    directoryMode: "0700",
    files: records,
  };
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;

  mkdirSync(temporaryPath, { mode: 0o700 });
  try {
    mkdirSync(join(temporaryPath, "artifacts"), { mode: 0o700 });
    writeDurableFile(join(temporaryPath, "plan.json"), input.planSource);
    for (const [id, path] of Object.entries(FILES)) {
      writeDurableFile(join(temporaryPath, path), input.artifactSources[id]);
    }
    writeDurableFile(join(temporaryPath, "itinerary.json"), itinerarySource);
    writeDurableFile(join(temporaryPath, "packet-manifest.json"), manifestSource);
    syncDirectory(join(temporaryPath, "artifacts"));
    syncDirectory(temporaryPath);
    renameSync(temporaryPath, packetPath);
    syncDirectory(parent);
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    throw error;
  }

  return {
    apiVersion: manifest.apiVersion,
    result: "persisted-reviewed-inputs-only",
    packetPath,
    planSha256: itinerary.planSha256,
    fileCount: records.length + 1,
    liveAccess: false,
    clusterMutation: false,
    adapterInvocation: false,
  };
}
