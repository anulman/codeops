import { readFile } from "node:fs/promises";
import { buildSessionProofPlan } from "./codeops-session-proof-plan.mjs";

const paths = {
  namespace: process.env.CODEOPS_SESSION_PROOF_NAMESPACE_MANIFEST,
  database: process.env.CODEOPS_SESSION_PROOF_DATABASE_MANIFEST,
  gateway: process.env.CODEOPS_SESSION_PROOF_GATEWAY_MANIFEST,
  grants: process.env.CODEOPS_SESSION_PROOF_GRANTS_MANIFEST,
  "codex-login": process.env.CODEOPS_SESSION_PROOF_CODEX_LOGIN_MANIFEST,
  "codex-smoke": process.env.CODEOPS_SESSION_PROOF_CODEX_SMOKE_MANIFEST,
  ui: process.env.CODEOPS_SESSION_PROOF_UI_MANIFEST,
  runtime: process.env.CODEOPS_SESSION_PROOF_RUNTIME_MANIFEST,
};
for (const [id, path] of Object.entries(paths)) {
  if (!path) throw new Error(`${id} manifest path is required`);
}
const files = Object.fromEntries(
  await Promise.all(
    Object.entries(paths).map(async ([id, path]) => [
      id,
      { path, source: await readFile(path, "utf8") },
    ]),
  ),
);

const plan = buildSessionProofPlan({
  namespace: process.env.CODEOPS_SESSION_PROOF_NAMESPACE ?? "",
  runId: process.env.CODEOPS_RUN_ID ?? "",
  baseSha: process.env.CODEOPS_BASE_SHA ?? "",
  sessionSuffix: process.env.CODEOPS_SESSION_SUFFIX ?? "",
  files,
});
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
