import { readFile } from "node:fs/promises";
import { renderCodexAuthManifest } from "./codeops-codex-auth-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/codex-auth-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(
  renderCodexAuthManifest(template, {
    action: process.env.CODEOPS_AUTH_ACTION ?? "",
    agentDigest: process.env.CODEOPS_AGENT_DIGEST ?? "",
  }),
);
