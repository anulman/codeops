import { readFile } from "node:fs/promises";
import { renderSessionProofCodexAuthManifest } from "./codeops-session-proof-codex-auth-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/codex-auth-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(renderSessionProofCodexAuthManifest(template, {
  action: process.env.CODEOPS_AUTH_ACTION ?? "",
  agentDigest: process.env.CODEOPS_AGENT_DIGEST ?? "",
  namespace: process.env.CODEOPS_SESSION_PROOF_NAMESPACE ?? "",
  runId: process.env.CODEOPS_RUN_ID ?? "",
}));
