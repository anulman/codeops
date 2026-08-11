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
const parsedCreationReceipt = JSON.parse(creationReceipt);
const revocationReceiptSource = parsedCreationReceipt.result === "created-and-uid-bound"
  ? await readBoundedFile(
      process.env.CODEOPS_SESSION_PROOF_REVOCATION_RECEIPT,
      "proof credential-revocation receipt",
    )
  : undefined;
const revocationEvidenceSource = parsedCreationReceipt.result === "created-and-uid-bound"
  ? await readBoundedFile(
      process.env.CODEOPS_SESSION_PROOF_REVOCATION_EVIDENCE,
      "proof credential-revocation evidence",
    )
  : undefined;
const result = await deleteSessionProofNamespace({
  planSource,
  creationReceipt,
  revocationReceiptSource,
  revocationEvidenceSource,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.proceed) process.exitCode = 1;
