import { readFile } from "node:fs/promises";
import { renderSessionProofGatewayManifest } from "./codeops-session-proof-gateway-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/session-proof-gateway-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(renderSessionProofGatewayManifest(
  template,
  {
    gatewayDigest: process.env.CODEOPS_SESSION_CONTROL_GATEWAY_DIGEST ?? "",
    agentDigest: process.env.CODEOPS_AGENT_DIGEST ?? "",
    workerDigest: process.env.CODEOPS_SESSION_RUNTIME_WORKER_DIGEST ?? "",
    runtimeReleaseDigest: process.env.CODEOPS_RUNTIME_RELEASE_DIGEST ?? "",
  },
));
