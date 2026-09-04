import { readFile } from "node:fs/promises";
import { renderSessionRuntimeWorkerManifest } from "./codeops-session-runtime-worker-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/session-runtime-worker-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(renderSessionRuntimeWorkerManifest(template, {
  agentDigest: process.env.CODEOPS_AGENT_DIGEST ?? "",
  workerDigest: process.env.CODEOPS_SESSION_RUNTIME_WORKER_DIGEST ?? "",
  baseSha: process.env.CODEOPS_BASE_SHA ?? "",
  branch: process.env.CODEOPS_BRANCH ?? "",
  leaseId: process.env.CODEOPS_LEASE_ID ?? "",
  repository: process.env.CODEOPS_REPOSITORY ?? "",
  runId: process.env.CODEOPS_RUN_ID ?? "",
  runtimeProfileId: process.env.CODEOPS_RUNTIME_PROFILE_ID ?? "",
  runtimeReleaseDigest: process.env.CODEOPS_RUNTIME_RELEASE_DIGEST ?? "",
  runtimeCapabilityDigest: process.env.CODEOPS_RUNTIME_CAPABILITY_DIGEST ?? "",
  runtimeProfile: JSON.parse(process.env.CODEOPS_RUNTIME_PROFILE_JSON ?? "null"),
  sessionId: process.env.CODEOPS_SESSION_ID ?? "",
  ownerPrincipalId: process.env.CODEOPS_SESSION_OWNER_PRINCIPAL_ID ?? "",
  sessionSuffix: process.env.CODEOPS_SESSION_SUFFIX ?? "",
  workflowId: process.env.CODEOPS_WORKFLOW_ID ?? "",
}));
