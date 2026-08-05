import { lstat, readFile } from "node:fs/promises";
import { createSessionProofNamespace } from "./codeops-session-proof-namespace-create.mjs";

async function readBoundedFile(path, label) {
  if (!path) throw new Error(`${label} path is required`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) {
    throw new Error(`${label} must be one bounded regular file`);
  }
  return readFile(path, "utf8");
}

const planSource = await readBoundedFile(process.env.CODEOPS_SESSION_PROOF_PLAN, "proof plan");
const admissionSource = await readBoundedFile(
  process.env.CODEOPS_SESSION_PROOF_ADMISSION,
  "proof admission",
);
const namespaceManifestSource = await readBoundedFile(
  process.env.CODEOPS_SESSION_PROOF_NAMESPACE_MANIFEST,
  "proof namespace manifest",
);
let admission;
try {
  admission = JSON.parse(admissionSource);
} catch {
  throw new Error("proof admission must be valid JSON");
}
const result = createSessionProofNamespace({
  planSource,
  admission,
  namespaceManifestSource,
  observedAt: new Date().toISOString(),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.proceed) process.exitCode = 1;
