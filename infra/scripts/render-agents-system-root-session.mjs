import { readFile } from "node:fs/promises";
import { renderAgentsSystemRootSession } from "./agents-system-root-session-render.mjs";

const template = await readFile(new URL("../k8s/codeops/agents-system-root-session-template.yaml", import.meta.url), "utf8");
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
process.stdout.write(renderAgentsSystemRootSession(template, {
  agentDigest: required("CODEOPS_AGENT_DIGEST"),
  workerDigest: required("CODEOPS_SESSION_RUNTIME_WORKER_DIGEST"),
  baseSha: required("CODEOPS_BASE_SHA"),
  branch: required("CODEOPS_BRANCH"),
  leaseId: required("CODEOPS_LEASE_ID"),
  runId: required("CODEOPS_RUN_ID"),
  sessionId: required("CODEOPS_SESSION_ID"),
  sessionSuffix: required("CODEOPS_SESSION_SUFFIX"),
  workflowId: required("CODEOPS_WORKFLOW_ID"),
}));
