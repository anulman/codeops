import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PERSONA_HANDLES = new Set([
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
]);

const TOKENS = {
  __CODEOPS_ALLOWED_HUMAN_ACTOR_IDS__: "allowedHumanActorIds",
  __CODEOPS_BASE_SHA__: "baseSha",
  __CODEOPS_PERSONA_USER_IDS__: "personaUserIds",
  __CODEOPS_PLANE_CONTROLLER_DIGEST__: "controllerDigest",
  __CODEOPS_PLANE_CONTROLLER_HOST__: "controllerHost",
  __CODEOPS_PLANE_WORKSPACE_SLUG__: "workspaceSlug",
  __CODEOPS_READY_STATE_ID__: "readyStateId",
};

function exactResources(resources) {
  return resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
}

export function renderPlaneControllerManifest(template, input) {
  if (!DIGEST.test(input.controllerDigest ?? "")) {
    throw new Error("controller image must use a lowercase SHA-256 digest");
  }
  if (!SHA.test(input.baseSha ?? "")) {
    throw new Error("base SHA must contain exactly 40 lowercase hex characters");
  }
  if (!WORKSPACE_SLUG.test(input.workspaceSlug ?? "")) {
    throw new Error("Plane workspace slug is invalid");
  }
  const actorIds = (input.allowedHumanActorIds ?? "").split(",");
  if (
    actorIds.length < 1 ||
    actorIds.some((value) => !UUID.test(value)) ||
    new Set(actorIds).size !== actorIds.length
  ) {
    throw new Error("allowed human actor IDs must be unique lowercase UUIDs");
  }
  if (!UUID.test(input.readyStateId ?? "")) {
    throw new Error("Ready state ID must be a lowercase UUID");
  }
  const personaMappings = (input.personaUserIds ?? "")
    .split(",")
    .map((entry) => entry.split("="));
  if (
    personaMappings.length !== PERSONA_HANDLES.size ||
    personaMappings.some(
      ([id, handle, extra]) =>
        !UUID.test(id) ||
        !PERSONA_HANDLES.has(handle) ||
        extra !== undefined,
    ) ||
    new Set(personaMappings.map(([id]) => id)).size !== personaMappings.length ||
    new Set(personaMappings.map(([, handle]) => handle)).size !==
      PERSONA_HANDLES.size
  ) {
    throw new Error(
      "persona user IDs must map seven unique UUIDs to the registered handles",
    );
  }
  const expectedHost = "work.renoconcierge.ca";
  if (input.controllerHost !== expectedHost) {
    throw new Error(`controller host must be ${expectedHost}`);
  }

  let rendered = template;
  for (const [token, key] of Object.entries(TOKENS)) {
    const occurrences = rendered.split(token).length - 1;
    if (occurrences < 1) throw new Error(`expected ${token} token`);
    rendered = rendered.replaceAll(token, input[key]);
  }
  for (const token of Object.keys(TOKENS)) {
    if (rendered.includes(token)) {
      throw new Error(`unresolved ${token} token survived rendering`);
    }
  }

  const resources = parseAllDocuments(rendered).map((document) => {
    if (document.errors.length > 0) {
      throw new Error(`invalid controller YAML: ${document.errors[0].message}`);
    }
    return document.toJS();
  });
  const expectedResources = [
    "Deployment/codeops-plane-controller",
    "Ingress/codeops-plane-controller",
    "NetworkPolicy/codeops-plane-controller",
    "PersistentVolumeClaim/codeops-plane-controller-ledger",
    "Service/codeops-plane-controller",
    "ServiceAccount/codeops-plane-controller",
  ].sort();
  if (
    JSON.stringify(exactResources(resources)) !==
    JSON.stringify(expectedResources)
  ) {
    throw new Error("controller manifest contains an unexpected resource set");
  }

  const deployment = resources.find((resource) => resource.kind === "Deployment");
  const account = resources.find(
    (resource) => resource.kind === "ServiceAccount",
  );
  const claim = resources.find(
    (resource) => resource.kind === "PersistentVolumeClaim",
  );
  const service = resources.find((resource) => resource.kind === "Service");
  const ingress = resources.find((resource) => resource.kind === "Ingress");
  const policy = resources.find(
    (resource) => resource.kind === "NetworkPolicy",
  );
  const pod = deployment.spec.template.spec;
  const container = pod.containers[0];
  const env = Object.fromEntries(
    container.env.map((entry) => [entry.name, entry.value]),
  );
  const expectedEnv = {
    CODEOPS_ALLOWED_HUMAN_ACTOR_IDS: input.allowedHumanActorIds,
    CODEOPS_BASE_SHA: input.baseSha,
    CODEOPS_DEDUP_ROOT: "/var/lib/codeops/dedup",
    CODEOPS_HTTP_HOST: "0.0.0.0",
    CODEOPS_HTTP_PORT: "8080",
    CODEOPS_PERSONA_USER_IDS: input.personaUserIds,
    CODEOPS_READY_STATE_ID: input.readyStateId,
    CODEOPS_PLANE_API_KEY_FILE: "/var/run/secrets/codeops/plane-api-key",
    CODEOPS_PLANE_API_ORIGIN: "https://work.renoconcierge.ca",
    CODEOPS_PLANE_WEBHOOK_SECRET_FILE:
      "/var/run/secrets/codeops/webhook-secret",
    CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE:
      "/var/run/codeops-projection/token",
    CODEOPS_PLANE_WORKSPACE_SLUG: input.workspaceSlug,
    CODEOPS_REPOSITORY_NAME: "renoconcierge",
    CODEOPS_REPOSITORY_OWNER: "anulman",
    CODEOPS_TEMPORAL_ADDRESS: "codeops-temporal:7233",
    CODEOPS_TEMPORAL_NAMESPACE: "codeops",
    CODEOPS_TEMPORAL_TASK_QUEUE: "codeops-trial0",
  };

  if (
    deployment.spec.replicas !== 1 ||
    deployment.spec.strategy?.type !== "Recreate" ||
    pod.automountServiceAccountToken !== false ||
    pod.enableServiceLinks !== false ||
    account.automountServiceAccountToken !== false
  ) {
    throw new Error("controller must be a tokenless single-writer deployment");
  }
  if (
    container.image !==
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-plane-controller@${input.controllerDigest}`
  ) {
    throw new Error("mutable or unexpected controller image survived rendering");
  }
  if (
    claim.spec.accessModes.length !== 1 ||
    claim.spec.accessModes[0] !== "ReadWriteOnce" ||
    claim.spec.resources.requests.storage !== "1Gi"
  ) {
    throw new Error("controller ledger must use one bounded RWO claim");
  }
  if (
    JSON.stringify(Object.keys(env).sort()) !==
      JSON.stringify(Object.keys(expectedEnv).sort()) ||
    Object.entries(expectedEnv).some(([name, value]) => env[name] !== value)
  ) {
    throw new Error("controller identity or credential-file binding drifted");
  }
  if (container.env.some((entry) => entry.valueFrom !== undefined)) {
    throw new Error("controller credentials must be mounted files");
  }
  const secretVolume = pod.volumes.find(
    (volume) => volume.name === "controller-secrets",
  );
  const ledgerVolume = pod.volumes.find((volume) => volume.name === "ledger");
  const projectionVolume = pod.volumes.find(
    (volume) => volume.name === "projection-auth",
  );
  if (
    secretVolume?.secret?.secretName !== "codeops-plane-controller-secrets" ||
    secretVolume.secret.defaultMode !== 288 ||
    secretVolume.secret.items?.length !== 2 ||
    projectionVolume?.secret?.secretName !==
      "codeops-research-projection-auth" ||
    projectionVolume.secret.defaultMode !== 256 ||
    ledgerVolume?.persistentVolumeClaim?.claimName !==
      "codeops-plane-controller-ledger"
  ) {
    throw new Error("controller secret or ledger volume binding drifted");
  }
  if (
    service.spec.type !== undefined ||
    service.spec.ports.length !== 1 ||
    service.spec.ports[0].port !== 8080
  ) {
    throw new Error("controller service must remain cluster-internal");
  }
  if (
    ingress.spec.rules.length !== 1 ||
    ingress.spec.rules[0].host !== input.controllerHost ||
    ingress.spec.rules[0].http.paths.length !== 1 ||
    ingress.spec.rules[0].http.paths[0].path !== "/webhooks/plane" ||
    ingress.spec.rules[0].http.paths[0].pathType !== "Exact" ||
    ingress.spec.tls[0].hosts[0] !== input.controllerHost ||
    ingress.spec.tls[0].secretName !== "codeops-plane-work-tls"
  ) {
    throw new Error("controller ingress must expose only the exact webhook path");
  }
  if (
    policy.spec.policyTypes.join(",") !== "Ingress,Egress" ||
    policy.spec.ingress.length !== 2 ||
    !policy.spec.ingress.some((rule) =>
      rule.from?.some(
        (source) =>
          source.podSelector?.matchLabels?.["app.kubernetes.io/name"] ===
          "codeops-orchestrator",
      ),
    ) ||
    !policy.spec.egress.some((rule) =>
      rule.ports?.some((port) => port.port === 7233),
    ) ||
    !policy.spec.egress.some((rule) =>
      rule.ports?.some((port) => port.port === 443),
    )
  ) {
    throw new Error("controller network isolation contract drifted");
  }
  if (
    !container.securityContext?.readOnlyRootFilesystem ||
    container.securityContext?.allowPrivilegeEscalation !== false ||
    pod.securityContext?.runAsNonRoot !== true
  ) {
    throw new Error("controller pod security contract drifted");
  }
  return rendered;
}
