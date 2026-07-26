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
    agentDigest: process.env.CODEOPS_AGENT_DIGEST ?? "",
    sessionGatewayDigest: process.env.CODEOPS_SESSION_GATEWAY_DIGEST ?? "",
    kubernetesApiCidr: process.env.CODEOPS_KUBERNETES_API_CIDR ?? "",
  }),
);
