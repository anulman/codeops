import { readFile } from "node:fs/promises";
import { renderSessionProofUiManifest } from "./codeops-session-proof-ui-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agents-ui-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(
  renderSessionProofUiManifest(template, {
    agentsUiDigest: process.env.CODEOPS_AGENTS_UI_DIGEST ?? "",
    namespace: process.env.CODEOPS_SESSION_PROOF_NAMESPACE ?? "",
    runId: process.env.CODEOPS_RUN_ID ?? "",
  }),
);
