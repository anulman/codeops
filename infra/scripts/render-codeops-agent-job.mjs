import { readFile } from "node:fs/promises";
import { renderAgentJobManifest } from "./codeops-agent-job-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agent-job-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(
  renderAgentJobManifest(template, {
    runId: process.env.CODEOPS_RUN_ID ?? "",
    role: process.env.CODEOPS_AGENT_ROLE ?? "",
    baseSha: process.env.CODEOPS_BASE_SHA ?? "",
    prompt: process.env.CODEOPS_PROMPT ?? "",
    repository: process.env.CODEOPS_REPOSITORY ?? "",
    agentDigest: process.env.CODEOPS_AGENT_DIGEST ?? "",
    sessionGatewayDigest: process.env.CODEOPS_SESSION_GATEWAY_DIGEST ?? "",
  }),
);
