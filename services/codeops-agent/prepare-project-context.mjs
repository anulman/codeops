import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function canonicalSerialize(value) {
  if (
    value === undefined ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new TypeError("value is not representable as canonical JSON");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`)
    .join(",")}}`;
}

function decode(name) {
  const encoded = required(name);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(`${name} is not canonical base64`);
  }
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

const workspace = await realpath(required("CODEOPS_WORKSPACE"));
const contextDirectory = required("CODEOPS_CONTEXT_DIR");
if (!path.isAbsolute(contextDirectory)) {
  throw new Error("CODEOPS_CONTEXT_DIR must be absolute");
}
await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
const contextMetadata = await lstat(contextDirectory);
if (!contextMetadata.isDirectory() || contextMetadata.isSymbolicLink()) {
  throw new Error("project context output must be a real directory");
}

const projectContext = decode("CODEOPS_PROJECT_CONTEXT_B64");
if (
  projectContext?.version !== "codeops.project-context/v1" ||
  projectContext.baseSha !== required("CODEOPS_BASE_SHA") ||
  !Array.isArray(projectContext.documents) ||
  projectContext.documents.length === 0
) {
  throw new Error("project context identity is invalid");
}
const { digest, ...identity } = projectContext;
const computedContextDigest = `sha256:${createHash("sha256")
  .update(canonicalSerialize(identity))
  .digest("hex")}`;
if (digest !== computedContextDigest) {
  throw new Error("project context digest mismatch");
}

let previousPath = "";
for (const document of projectContext.documents) {
  if (
    typeof document?.path !== "string" ||
    !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/.test(
      document.path,
    ) ||
    document.path <= previousPath ||
    !/^sha256:[0-9a-f]{64}$/.test(document.digest)
  ) {
    throw new Error("project context document manifest is invalid");
  }
  previousPath = document.path;
  const candidate = path.resolve(workspace, document.path);
  const relative = path.relative(workspace, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("project context document escaped the workspace");
  }
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`project context document is not a regular file: ${document.path}`);
  }
  const actualDigest = `sha256:${createHash("sha256")
    .update(await readFile(candidate))
    .digest("hex")}`;
  if (actualDigest !== document.digest) {
    throw new Error(`project context document digest drift: ${document.path}`);
  }
}

const projectContextPath = path.join(contextDirectory, "project-context.json");
await writeFile(projectContextPath, `${JSON.stringify(projectContext)}\n`, {
  mode: 0o400,
  flag: "wx",
});
await chmod(projectContextPath, 0o400);

if (process.env.CODEOPS_RESEARCH_PACKET_B64) {
  const researchPacket = decode("CODEOPS_RESEARCH_PACKET_B64");
  if (
    researchPacket?.version !== "codeops.research-packet/v2" ||
    researchPacket.baseSha !== projectContext.baseSha ||
    researchPacket.projectId !== projectContext.project?.projectId ||
    researchPacket.projectContextDigest !== projectContext.digest
  ) {
    throw new Error("research packet does not match the project context");
  }
  const researchPacketPath = path.join(contextDirectory, "research-packet.json");
  await writeFile(researchPacketPath, `${JSON.stringify(researchPacket)}\n`, {
    mode: 0o400,
    flag: "wx",
  });
  await chmod(researchPacketPath, 0o400);
}
