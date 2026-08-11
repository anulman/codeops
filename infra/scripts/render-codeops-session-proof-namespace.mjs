import { readFile } from "node:fs/promises";
import { renderSessionProofNamespaceManifest } from "./codeops-session-proof-namespace-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/session-proof-namespace-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(renderSessionProofNamespaceManifest(template, {
  namespace: process.env.CODEOPS_SESSION_PROOF_NAMESPACE ?? "",
  runId: process.env.CODEOPS_RUN_ID ?? "",
  baseSha: process.env.CODEOPS_BASE_SHA ?? "",
}));
