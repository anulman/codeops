import { readFile } from "node:fs/promises";
import { renderControlGatewayManifest } from "./codeops-control-gateway-render.mjs";

const template = await readFile(
  new URL(
    "../k8s/codeops/trial0/control-gateway-template.yaml",
    import.meta.url,
  ),
  "utf8",
);

process.stdout.write(
  renderControlGatewayManifest(template, {
    controlGatewayDigest: process.env.CODEOPS_CONTROL_GATEWAY_DIGEST ?? "",
    modelProxyDigest: process.env.CODEOPS_MODEL_PROXY_DIGEST ?? "",
    agentDigest: process.env.CODEOPS_AGENT_DIGEST ?? "",
    workerDigest: process.env.CODEOPS_SESSION_RUNTIME_WORKER_DIGEST ?? "",
    sessionGatewayDigest: process.env.CODEOPS_SESSION_GATEWAY_DIGEST ?? "",
    runtimeReleaseDigest: process.env.CODEOPS_RUNTIME_RELEASE_DIGEST ?? "",
    kubernetesApiCidr: process.env.CODEOPS_KUBERNETES_API_CIDR ?? "",
  }),
);
