import { lstat, readFile } from "node:fs/promises";
import { deleteSessionProofNamespace } from "./codeops-session-proof-namespace-delete.mjs";

async function readBoundedFile(path, label) {
  if (!path) throw new Error(`${label} path is required`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) {
    throw new Error(`${label} must be one bounded regular file`);
  }
  return readFile(path, "utf8");
}

const planSource = await readBoundedFile(
  process.env.CODEOPS_SESSION_PROOF_PLAN,
  "proof plan",
);
const creationReceipt = await readBoundedFile(
  process.env.CODEOPS_SESSION_PROOF_NAMESPACE_RECEIPT,
  "proof Namespace creation receipt",
);
const result = await deleteSessionProofNamespace({ planSource, creationReceipt });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.proceed) process.exitCode = 1;
