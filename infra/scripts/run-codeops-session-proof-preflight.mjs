import { lstat, readFile } from "node:fs/promises";
import { runSessionProofPreflight } from "./codeops-session-proof-preflight.mjs";

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
const admissionSource = await readBoundedFile(
  process.env.CODEOPS_SESSION_PROOF_ADMISSION,
  "proof admission",
);
let admission;
try {
  admission = JSON.parse(admissionSource);
} catch {
  throw new Error("proof admission must be valid JSON");
}
const observedAt = new Date().toISOString();
const result = runSessionProofPreflight({ planSource, admission, observedAt });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
