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

async function loadJson(encodedName, fileName, fixedPath) {
  const encoded = process.env[encodedName];
  const file = process.env[fileName];
  if (encoded && file) {
    throw new Error(`${encodedName} and ${fileName} are mutually exclusive`);
  }
  if (file) {
    const inputRoot = process.env.CODEOPS_INPUT_ROOT || "/input";
    if (
      !path.isAbsolute(inputRoot) ||
      file !== path.join(inputRoot, path.basename(fixedPath))
    ) {
      throw new Error(`${fileName} must use the fixed run input path`);
    }
    const bytes = await readFile(file);
    if (bytes.length === 0 || bytes.length > 900_000) {
      throw new Error(`${fileName} must contain 1 to 900000 bytes`);
    }
    return JSON.parse(bytes.toString("utf8"));
  }
  return decode(encodedName);
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

const projectContext = await loadJson(
  "CODEOPS_PROJECT_CONTEXT_B64",
  "CODEOPS_PROJECT_CONTEXT_FILE",
  "/input/project-context.json",
);
if (
  projectContext?.version !== "codeops.project-context/v1" ||
  projectContext.baseSha !== required("CODEOPS_BASE_SHA") ||
  projectContext.controlPlaneSha !== required("CODEOPS_CONTROL_PLANE_SHA") ||
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
const documentsRoot = path.join(contextDirectory, "project-documents");
await mkdir(documentsRoot, { recursive: true, mode: 0o700 });
for (const document of projectContext.documents) {
  if (
    typeof document?.path !== "string" ||
    !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/.test(
      document.path,
    ) ||
    document.path <= previousPath ||
    !/^sha256:[0-9a-f]{64}$/.test(document.digest) ||
    typeof document.content !== "string" ||
    document.content.length === 0 ||
    Buffer.byteLength(document.content) > 100_000
  ) {
    throw new Error("project context document manifest is invalid");
  }
  previousPath = document.path;
  const candidate = path.resolve(documentsRoot, document.path);
  const relative = path.relative(documentsRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("project context document escaped its output root");
  }
  const actualDigest = `sha256:${createHash("sha256")
    .update(document.content)
    .digest("hex")}`;
  if (actualDigest !== document.digest) {
    throw new Error(`project context document digest drift: ${document.path}`);
  }
  await mkdir(path.dirname(candidate), { recursive: true, mode: 0o700 });
  await writeFile(candidate, document.content, { mode: 0o400, flag: "wx" });
  await chmod(candidate, 0o400);
}

const projectContextPath = path.join(contextDirectory, "project-context.json");
await writeFile(projectContextPath, `${JSON.stringify(projectContext)}\n`, {
  mode: 0o400,
  flag: "wx",
});
await chmod(projectContextPath, 0o400);

if (
  process.env.CODEOPS_RESEARCH_PACKET_B64 ||
  process.env.CODEOPS_RESEARCH_PACKET_FILE
) {
  const researchPacket = await loadJson(
    "CODEOPS_RESEARCH_PACKET_B64",
    "CODEOPS_RESEARCH_PACKET_FILE",
    "/input/research-packet.json",
  );
  if (
    researchPacket?.version !== "codeops.research-packet/v3" ||
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

if (
  process.env.CODEOPS_RESEARCH_DISPATCH_B64 ||
  process.env.CODEOPS_RESEARCH_DISPATCH_FILE
) {
  const dispatch = await loadJson(
    "CODEOPS_RESEARCH_DISPATCH_B64",
    "CODEOPS_RESEARCH_DISPATCH_FILE",
    "/input/research-dispatch.json",
  );
  if (
    dispatch?.version !== "codeops.agent-job-dispatch/v1" ||
    dispatch.role !== "qa-contract-researcher" ||
    dispatch.baseSha !== projectContext.baseSha ||
    dispatch.workItemId !== dispatch.researchRequest?.workItemId ||
    dispatch.workflowId !== dispatch.researchRequest?.requestId ||
    dispatch.researchRequest?.projectId !== projectContext.project?.projectId ||
    dispatch.researchRequest?.projectContext?.digest !== projectContext.digest ||
    dispatch.researchRequest?.ticketSnapshot?.workItemId !== dispatch.workItemId ||
    !["persona", "synthesis"].includes(dispatch.researchStage?.kind)
  ) {
    throw new Error("research dispatch does not match the project context");
  }
  const researchDispatchPath = path.join(
    contextDirectory,
    "research-dispatch.json",
  );
  await writeFile(researchDispatchPath, `${JSON.stringify(dispatch)}\n`, {
    mode: 0o400,
    flag: "wx",
  });
  await chmod(researchDispatchPath, 0o400);
}
