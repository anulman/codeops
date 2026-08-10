import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/32$/;

export function renderControlGatewayManifest(template, input) {
  for (const key of [
    "controlGatewayDigest",
    "modelProxyDigest",
    "agentDigest",
    "sessionGatewayDigest",
  ]) {
    if (!DIGEST.test(input[key] ?? "")) {
      throw new Error(`${key} must be a lowercase SHA-256 digest`);
    }
  }
  if (!CIDR.test(input.kubernetesApiCidr ?? "")) {
    throw new Error("Kubernetes API CIDR must be one IPv4 /32");
  }
  const replacements = {
    __CODEOPS_CONTROL_GATEWAY_DIGEST__: input.controlGatewayDigest,
    __CODEOPS_MODEL_PROXY_DIGEST__: input.modelProxyDigest,
    __CODEOPS_AGENT_DIGEST__: input.agentDigest,
    __CODEOPS_SESSION_GATEWAY_DIGEST__: input.sessionGatewayDigest,
    __CODEOPS_KUBERNETES_API_CIDR__: input.kubernetesApiCidr,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    if (rendered.split(token).length !== 2) {
      throw new Error(`expected exactly one ${token}`);
    }
    rendered = rendered.replace(token, value);
  }
  if (/__CODEOPS_[A-Z0-9_]+__/.test(rendered)) {
    throw new Error("unresolved control-gateway token");
  }
  const resources = parseAllDocuments(rendered).map((document) =>
    document.toJS(),
  );
  const identities = resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
  const expected = [
    "Deployment/codeops-control-gateway",
    "Deployment/codeops-model-proxy",
    "NetworkPolicy/codeops-control-gateway",
    "NetworkPolicy/codeops-model-proxy",
    "PersistentVolumeClaim/codeops-control-gateway-evidence",
    "Role/codeops-control-gateway",
    "RoleBinding/codeops-control-gateway",
    "Service/codeops-control-gateway",
    "Service/codeops-model-proxy",
    "ServiceAccount/codeops-control-gateway",
    "ServiceAccount/codeops-model-proxy",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) {
    throw new Error("control-gateway resource set drifted");
  }
  const role = resources.find((resource) => resource.kind === "Role");
  const verbs = new Set(role.rules.flatMap((rule) => rule.verbs));
  if (verbs.has("patch") || verbs.has("update") || verbs.has("*")) {
    throw new Error("control gateway may not mutate existing resources");
  }
  const deployment = resources.find(
    (resource) => resource.kind === "Deployment",
  );
  const runtimeCredentials = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "runtime-credentials",
  );
  const dispatchAuth = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "dispatch-auth",
  );
  const repositoryHeadAuth = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "repository-head-auth",
  );
  const sessionBrokerDatabase = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-broker-database",
  );
  const sessionBrokerReadAuth = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-broker-read-auth",
  );
  const sessionBrokerWriteAuth = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-broker-write-auth",
  );
  const sessionRuntimeWorkerAuth = deployment.spec.template.spec.volumes.find(
    (volume) => volume.name === "session-runtime-worker-auth",
  );
  const sessionJobInitializationAuth =
    deployment.spec.template.spec.volumes.find(
      (volume) => volume.name === "session-job-initialization-auth",
    );
  const image = deployment.spec.template.spec.containers[0].image;
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("control gateway image must be immutable");
  }
  if (
    runtimeCredentials?.secret?.secretName !==
      "codeops-agent-source-credentials" ||
    runtimeCredentials.secret.items?.map((item) => item.key).sort().join(",") !==
      "repository-read-token"
  ) {
    throw new Error("control gateway runtime credential binding drifted");
  }
  if (
    dispatchAuth?.secret?.secretName !== "codeops-agent-dispatch-auth" ||
    repositoryHeadAuth?.secret?.secretName !==
      "codeops-repository-head-auth" ||
    dispatchAuth.secret.secretName === repositoryHeadAuth.secret.secretName
  ) {
    throw new Error("control gateway endpoint auth bindings drifted");
  }
  if (
    sessionBrokerDatabase?.secret?.secretName !==
      "codeops-session-broker-database" ||
    sessionBrokerDatabase.secret.items
      ?.map((item) => `${item.key}:${item.path}`)
      .join(",") !== "database-url:database-url"
  ) {
    throw new Error("control gateway session database binding drifted");
  }
  if (
    sessionBrokerReadAuth?.secret?.secretName !==
      "codeops-session-broker-read-auth" ||
    sessionBrokerReadAuth.secret.items
      ?.map((item) => `${item.key}:${item.path}`)
      .join(",") !== "token:token" ||
    sessionBrokerReadAuth.secret.secretName ===
      dispatchAuth.secret.secretName ||
    sessionBrokerReadAuth.secret.secretName ===
      repositoryHeadAuth.secret.secretName
  ) {
    throw new Error("control gateway session read auth binding drifted");
  }
  if (
    sessionBrokerWriteAuth?.secret?.secretName !==
      "codeops-session-broker-write-auth" ||
    sessionBrokerWriteAuth.secret.items
      ?.map((item) => `${item.key}:${item.path}`)
      .join(",") !== "token:token" ||
    sessionBrokerWriteAuth.secret.secretName ===
      sessionBrokerReadAuth.secret.secretName ||
    sessionBrokerWriteAuth.secret.secretName === dispatchAuth.secret.secretName ||
    sessionBrokerWriteAuth.secret.secretName ===
      repositoryHeadAuth.secret.secretName
  ) {
    throw new Error("control gateway session write auth binding drifted");
  }
  if (
    sessionRuntimeWorkerAuth?.secret?.secretName !==
      "codeops-session-runtime-worker-auth" ||
    sessionRuntimeWorkerAuth.secret.items
      ?.map((item) => `${item.key}:${item.path}`)
      .join(",") !== "token:token" ||
    [
      sessionBrokerReadAuth.secret.secretName,
      sessionBrokerWriteAuth.secret.secretName,
      dispatchAuth.secret.secretName,
      repositoryHeadAuth.secret.secretName,
      "codeops-publication-auth",
    ].includes(sessionRuntimeWorkerAuth.secret.secretName)
  ) {
    throw new Error("control gateway runtime worker auth binding drifted");
  }
  if (
    sessionJobInitializationAuth?.secret?.secretName !==
      "codeops-session-job-initialization-auth" ||
    sessionJobInitializationAuth.secret.items
      ?.map((item) => `${item.key}:${item.path}`)
      .join(",") !== "token:token" ||
    [
      sessionRuntimeWorkerAuth.secret.secretName,
      sessionBrokerReadAuth.secret.secretName,
      sessionBrokerWriteAuth.secret.secretName,
      dispatchAuth.secret.secretName,
      repositoryHeadAuth.secret.secretName,
      "codeops-publication-auth",
    ].includes(sessionJobInitializationAuth.secret.secretName)
  ) {
    throw new Error("control gateway session Job initialization auth binding drifted");
  }
  const env = deployment.spec.template.spec.containers[0].env;
  if (
    env.find((item) => item.name === "CODEOPS_MODEL_PROXY_ORIGIN")?.value !==
      "http://codeops-model-proxy:8080" ||
    env.find((item) => item.name === "CODEOPS_MODEL_PROXY_SIGNING_KEY_FILE")
      ?.value !== "/var/run/secrets/codeops-model-proxy/signing-key" ||
    env.some((item) =>
      ["CODEOPS_MODEL_API_KEY_FILE", "CODEOPS_MODEL_AUTH_MODE", "CODEOPS_CODEX_AUTH_CLAIM"].includes(item.name),
    )
  ) {
    throw new Error("control gateway model proxy binding drifted");
  }
  const modelProxy = resources.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.metadata.name === "codeops-model-proxy",
  );
  const proxyContainer = modelProxy.spec.template.spec.containers[0];
  if (
    !/@sha256:[0-9a-f]{64}$/.test(proxyContainer.image) ||
    proxyContainer.env.find((item) => item.name === "OPENAI_API_KEY")?.valueFrom
      ?.secretKeyRef?.name !== "codeops-model-proxy-credentials" ||
    modelProxy.spec.template.spec.automountServiceAccountToken !== false
  ) {
    throw new Error("model proxy credential boundary drifted");
  }
  if (
    env.find((item) => item.name === "CODEOPS_DATABASE_URL_FILE")?.value !==
      "/var/run/secrets/codeops-session-broker/database-url" ||
    env.find(
      (item) => item.name === "CODEOPS_SESSION_BROKER_READ_TOKEN_FILE",
    )?.value !== "/var/run/secrets/codeops-session-read/token" ||
    env.find(
      (item) => item.name === "CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE",
    )?.value !== "/var/run/secrets/codeops-session-write/token" ||
    env.find(
      (item) => item.name === "CODEOPS_SESSION_RUNTIME_WORKER_TOKEN_FILE",
    )?.value !== "/var/run/secrets/codeops-session-runtime-worker/token" ||
    env.find(
      (item) => item.name === "CODEOPS_SESSION_JOB_INITIALIZATION_TOKEN_FILE",
    )?.value !== "/var/run/secrets/codeops-session-job-initialization/token" ||
    env.find(
      (item) => item.name === "CODEOPS_SESSION_RUNTIME_WORKER_ID",
    )?.value !== "acp-worker:primary"
  ) {
    throw new Error("control gateway session secret paths drifted");
  }
  const networkPolicy = resources.find(
    (resource) => resource.kind === "NetworkPolicy",
  );
  const admittedIngressNames = networkPolicy.spec.ingress[0].from.map(
    (source) => source.podSelector?.matchLabels?.["app.kubernetes.io/name"],
  );
  if (
    JSON.stringify(admittedIngressNames) !==
    JSON.stringify([
      "codeops-orchestrator",
      "codeops-plane-controller",
      "codeops-agents-ui",
      "codeops-session-runtime-worker",
    ])
  ) {
    throw new Error("control gateway caller ingress drifted");
  }
  const databaseEgress = networkPolicy.spec.egress.filter((rule) =>
    rule.ports?.some((port) => port.protocol === "TCP" && port.port === 5432),
  );
  if (
    databaseEgress.length !== 1 ||
    JSON.stringify(databaseEgress[0]) !==
      JSON.stringify({
        to: [
          {
            podSelector: {
              matchLabels: {
                "cnpg.io/poolerName":
                  "renoconcierge-postgres-cnpg-pgbouncer",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 5432 }],
      })
  ) {
    throw new Error("control gateway session database egress drifted");
  }
  const serialized = JSON.stringify(resources);
  const proxyPolicy = resources.find(
    (resource) =>
      resource.kind === "NetworkPolicy" &&
      resource.metadata.name === "codeops-model-proxy",
  );
  const proxyCallers = proxyPolicy?.spec?.ingress?.[0]?.from?.[0]
    ?.podSelector?.matchExpressions?.[0];
  if (
    proxyCallers?.key !== "app.kubernetes.io/name" ||
    proxyCallers?.operator !== "In" ||
    JSON.stringify(proxyCallers.values) !==
      JSON.stringify(["codeops-agent", "codeops-session-runtime-worker"])
  ) {
    throw new Error("model proxy caller ingress drifted");
  }
  if (serialized.includes("ClusterRole") || serialized.includes("hostPath")) {
    throw new Error("control gateway must remain namespace scoped");
  }
  return rendered;
}
