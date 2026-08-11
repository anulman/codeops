import { lstat, readFile } from "node:fs/promises";
import { persistSessionProofOperatorPacket } from "./codeops-session-proof-operator-packet.mjs";

async function readBoundedFile(path, label) {
  if (!path) throw new Error(`${label} path is required`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) {
    throw new Error(`${label} must be one bounded regular file`);
  }
  return readFile(path, "utf8");
}

const artifactPaths = {
  namespace: process.env.CODEOPS_SESSION_PROOF_NAMESPACE_MANIFEST,
  database: process.env.CODEOPS_SESSION_PROOF_DATABASE_MANIFEST,
  gateway: process.env.CODEOPS_SESSION_PROOF_GATEWAY_MANIFEST,
  grants: process.env.CODEOPS_SESSION_PROOF_GRANTS_MANIFEST,
  "codex-login": process.env.CODEOPS_SESSION_PROOF_CODEX_LOGIN_MANIFEST,
  "codex-smoke": process.env.CODEOPS_SESSION_PROOF_CODEX_SMOKE_MANIFEST,
  ui: process.env.CODEOPS_SESSION_PROOF_UI_MANIFEST,
  runtime: process.env.CODEOPS_SESSION_PROOF_RUNTIME_MANIFEST,
};
const planSource = await readBoundedFile(process.env.CODEOPS_SESSION_PROOF_PLAN, "proof plan");
const artifactSources = Object.fromEntries(await Promise.all(Object.entries(artifactPaths).map(
  async ([id, path]) => [id, await readBoundedFile(path, `${id} proof artifact`)],
)));
const result = persistSessionProofOperatorPacket({
  packetPath: process.env.CODEOPS_SESSION_PROOF_PACKET,
  planSource,
  artifactSources,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
