import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = "infra/charts/codeops";
const digestSets = [
  "agentsUi.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gateway.image.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "controlGateway.image.digest=sha256:1212121212121212121212121212121212121212121212121212121212121212",
  "lifecycleRelay.image.digest=sha256:1212121212121212121212121212121212121212121212121212121212121212",
  "orchestrator.image.digest=sha256:3434343434343434343434343434343434343434343434343434343434343434",
  "githubController.image.digest=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "githubController.controlPlaneSha=1111111111111111111111111111111111111111",
  "postgresql.image.digest=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "runtime.workerImage.digest=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "runtime.agentImage.digest=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "runtime.sessionGatewayImage.digest=sha256:5656565656565656565656565656565656565656565656565656565656565656",
  "modelProxy.image.digest=sha256:9999999999999999999999999999999999999999999999999999999999999999",
  "agentsUi.access.issuer=https://example.cloudflareaccess.com",
  "ingress.host=codeops.example.net",
  "agentsUi.access.secretName=team-a-codeops-access",
  "gateway.secretName=team-a-codeops-session-secrets",
  "gateway.repositorySteeringRegistrySecretName=team-a-codeops-repository-steering",
  "controlGateway.secretName=team-a-codeops-control-gateway-secrets",
  "controlGateway.repositoryAuthoritySecretName=team-a-codeops-repository-runtime-authority",
  "controlGateway.kubernetesApiCidrs[0]=10.43.0.1/32",
  "modelProxy.secretName=team-a-codeops-model-proxy-credentials",
  "githubController.configSecretName=team-a-codeops-controller-config",
  "githubController.secretName=team-a-codeops-controller-secrets",
  "githubController.repositoryAuthoritySecretName=team-a-codeops-repository-controller-authority",
  "githubController.repositoryContexts[0].directory=renoconcierge",
  "githubController.repositoryContexts[0].secretName=team-a-renoconcierge-context",
  "githubController.repositoryContexts[1].directory=codeops",
  "githubController.repositoryContexts[1].secretName=team-a-codeops-context",
  "postgresql.secretName=team-a-codeops-postgres",
  "temporal.address=codeops-temporal-frontend:7233",
  "plane.adapter.enabled=true",
  "plane.adapter.onboardingRequired=false",
];
const quickstartSets = digestSets.filter(
  (value) =>
    !value.toLowerCase().includes("secretname=") &&
    !value.includes("repositoryContexts["),
);

function helm(args) {
  const result = spawnSync("helm", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `helm exited with ${result.status}`);
  }
  return result.stdout;
}

function render() {
  const output = helm([
    "template", "team-a", chart,
    "--namespace", "engineering",
    ...digestSets.flatMap((value) => ["--set", value]),
  ]);
  return parseAllDocuments(output)
    .map((document) => document.toJSON())
    .filter(Boolean);
}

function renderQuickstart(extra = []) {
  const output = helm([
    "template", "codeops", chart,
    "--namespace", "codeops",
    "--values", "infra/fixtures/helm/quickstart-values.yaml",
    ...quickstartSets.flatMap((value) => ["--set", value]),
    ...extra,
  ]);
  return parseAllDocuments(output)
    .map((document) => document.toJSON())
    .filter(Boolean);
}

function resource(resources, kind, name) {
  const match = resources.find(
    (candidate) => candidate.kind === kind && candidate.metadata?.name === name,
  );
  assert.ok(match, `${kind}/${name} must render`);
  return match;
}

test("renders one portable CodeOps package with immutable images", () => {
  const resources = render();
  assert.ok(resources.length >= 30);
  const codeopsResources = resources.filter(
    (candidate) => candidate.metadata?.labels?.["app.kubernetes.io/part-of"] === "codeops",
  );
  for (const candidate of codeopsResources) {
    assert.equal(candidate.metadata?.namespace, "engineering");
    assert.notEqual(candidate.kind, "Secret");
  }
  const images = codeopsResources.flatMap((candidate) => [
    ...(candidate.spec?.template?.spec?.containers ?? []),
    ...(candidate.spec?.template?.spec?.initContainers ?? []),
  ]).map((container) => container.image).filter(Boolean);
  assert.equal(images.length, 11);
  assert.equal(new Set(images).size, 7);
  assert.ok(images.every((image) => /@sha256:[0-9a-f]{64}$/.test(image)));

  resource(resources, "StatefulSet", "team-a-codeops-postgresql");
  resource(resources, "Deployment", "team-a-codeops-session-gateway");
  resource(resources, "Deployment", "team-a-codeops-github-controller");
  resource(resources, "Deployment", "team-a-codeops-agents-ui");
  const controlGateway = resource(resources, "Deployment", "team-a-codeops-control-gateway");
  const orchestrator = resource(resources, "Deployment", "team-a-codeops-orchestrator");
  resource(resources, "Service", "team-a-codeops-control-gateway");
  resource(resources, "PersistentVolumeClaim", "team-a-codeops-control-gateway-evidence");
  resource(resources, "Role", "team-a-codeops-control-gateway");
  resource(resources, "RoleBinding", "team-a-codeops-control-gateway");
  assert.match(JSON.stringify(controlGateway), /team-a-codeops-repository-runtime-authority/);
  assert.doesNotMatch(JSON.stringify(controlGateway), /CODEOPS_REPOSITORY_(URL|READ_TOKEN|WRITE_TOKEN)/);
  assert.match(JSON.stringify(orchestrator), /codeops-temporal-frontend:7233/);
  const modelProxy = resource(resources, "Deployment", "team-a-codeops-model-proxy");
  const proxySource = JSON.stringify(modelProxy);
  assert.match(proxySource, /team-a-codeops-model-proxy-credentials/);
  assert.match(proxySource, /openai-api-key/);
  assert.match(proxySource, /signing-key/);
  const migration = resource(resources, "Job", "team-a-codeops-session-migrate");
  assert.equal(
    migration.metadata.annotations["helm.sh/hook"],
    "post-install,pre-upgrade",
  );
  assert.equal(
    migration.metadata.annotations["helm.sh/hook-delete-policy"],
    "before-hook-creation,hook-succeeded",
  );
  assert.equal(migration.spec.backoffLimit, 0);
  assert.equal(migration.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(
    migration.spec.template.spec.initContainers[0].image,
    "postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  );
  assert.match(
    migration.spec.template.spec.initContainers[0].command.at(-1),
    /until pg_isready -h codeops-database -p 5432 -U agents/,
  );
  assert.deepEqual(migration.spec.template.spec.containers[0].command, [
    "node",
    "services/codeops-control-gateway/dist/session-migrate-main.js",
  ]);
  assert.deepEqual(
    migration.spec.template.spec.volumes.find(({ name }) => name === "secrets").secret.items.map(({ key }) => key).sort(),
    ["database-url", "runtime-database-role", "runtime-database-url"],
  );
  assert.deepEqual(
    migration.spec.template.spec.volumes.find(({ name }) => name === "relay-authority").secret.items.map(({ key }) => key).sort(),
    ["database-role", "database-url"],
  );
  const relay = resource(resources, "Deployment", "team-a-codeops-lifecycle-relay");
  assert.equal(relay.spec.template.spec.containers[0].image, controlGateway.spec.template.spec.containers[0].image);
  assert.equal(
    relay.spec.template.spec.initContainers[0].image,
    "ghcr.io/anulman/codeops/session-control-gateway@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.deepEqual(
    relay.spec.template.spec.volumes.find(({ name }) => name === "migration-authority").secret.items.map(({ key }) => key).sort(),
    ["database-url", "runtime-database-role", "runtime-database-url"],
  );
  assert.deepEqual(
    relay.spec.template.spec.volumes.find(({ name }) => name === "relay-authority").secret.items.map(({ key }) => key).sort(),
    ["database-role", "database-url", "nats-token"],
  );
  assert.equal(
    relay.spec.template.spec.containers[0].volumeMounts.some(({ name }) => name === "migration-authority"),
    false,
  );
  assert.match(JSON.stringify(relay), /CODEOPS_JETSTREAM_MANAGE_STREAM/);
  assert.equal(resources.some(({ metadata }) => metadata?.name === "team-a-codeops-codex-auth"), false);
  resource(resources, "PersistentVolumeClaim", "team-a-codeops-controller-state");
  const runtimeImages = resource(resources, "ConfigMap", "team-a-codeops-runtime-images");
  for (const value of Object.values(runtimeImages.data)) {
    if (value.includes("ghcr.io/")) assert.match(value, /@sha256:[0-9a-f]{64}$/);
  }
  for (const name of ["agents-ui", "session-gateway", "github-controller", "orchestrator", "runtime", "model-proxy"]) {
    const account = resource(resources, "ServiceAccount", `team-a-codeops-${name}`);
    assert.equal(account.automountServiceAccountToken, false);
  }
  const controlGatewayAccount = resource(resources, "ServiceAccount", "team-a-codeops-control-gateway");
  assert.notEqual(controlGatewayAccount.automountServiceAccountToken, false);
});

test("exposes only the Agents UI and requires signed Access configuration", () => {
  const resources = render();
  const ingresses = resources.filter(
    ({ kind, metadata }) =>
      kind === "Ingress" && metadata?.labels?.["app.kubernetes.io/part-of"] === "codeops",
  );
  assert.equal(ingresses.length, 1);
  assert.deepEqual(ingresses[0].spec.rules.map(({ host }) => host), [
    "codeops.example.net",
  ]);
  assert.deepEqual(ingresses[0].spec.rules[0].http.paths.map(({ path }) => path), [
    "/webhooks/github",
    "/webhooks/plane",
    "/",
  ]);
  assert.equal(
    ingresses[0].spec.rules[0].http.paths.find(
      ({ path }) => path === "/webhooks/plane",
    ).pathType,
    "Prefix",
  );

  const deployment = resource(
    resources,
    "Deployment",
    "team-a-codeops-agents-ui",
  );
  const env = new Map(
    deployment.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(env.get("AGENTS_UI_ACCESS_REQUIRED").value, "true");
  assert.equal(
    env.get("AGENTS_UI_ACCESS_ISSUER").value,
    "https://example.cloudflareaccess.com",
  );
  assert.equal(env.get("AGENTS_UI_ORIGIN").value, "https://codeops.example.net");
  assert.equal(
    env.get("AGENTS_UI_ACCESS_AUDIENCE").valueFrom.secretKeyRef.name,
    "team-a-codeops-access",
  );
  assert.equal(
    env.get("AGENTS_UI_ACCESS_ALLOWED_EMAILS_FILE").value,
    "/var/run/secrets/team-a-codeops-access/allowed-emails",
  );
  assert.equal(JSON.stringify(deployment).includes("cf-access-authenticated-user-email"), false);

  const gateway = resource(resources, "Deployment", "team-a-codeops-session-gateway");
  const gatewaySource = JSON.stringify(gateway);
  assert.match(gatewaySource, /initialization-token/);
  assert.match(gatewaySource, /team-a-codeops-model-proxy-credentials/);
  assert.match(gatewaySource, /signing-key/);
  assert.doesNotMatch(gatewaySource, /model-proxy-signing-key/);
  assert.doesNotMatch(gatewaySource, /github-steering-token/);
  assert.match(gatewaySource, /team-a-codeops-repository-steering/);
  assert.match(gatewaySource, /CODEOPS_REPOSITORY_STEERING_REGISTRY_FILE/);
  assert.equal(JSON.stringify(deployment).includes("initialization-token"), false);

  const controller = resource(
    resources,
    "Deployment",
    "team-a-codeops-github-controller",
  );
  const controllerEnv = new Map(
    controller.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(
    controllerEnv.get("CODEOPS_GITHUB_SESSION_STEERING_ORIGIN").value,
    "http://team-a-codeops-session-control-gateway:8080",
  );
  assert.equal(
    controllerEnv.get("CODEOPS_REPOSITORY_HEAD_ORIGIN").value,
    "http://team-a-codeops-control-gateway:8080",
  );
  assert.equal(
    controllerEnv.get("CODEOPS_REPOSITORY_REGISTRY_FILE").value,
    "/var/run/secrets/team-a-codeops-repositories/registry.json",
  );
  assert.equal(controllerEnv.has("CODEOPS_GITHUB_WEBHOOK_SECRET_FILE"), false);
  assert.equal(controllerEnv.has("CODEOPS_PLANE_API_KEY_FILE"), false);
  assert.equal(controllerEnv.has("CODEOPS_PLANE_WEBHOOK_SECRET_FILE"), false);
  const registryVolume = controller.spec.template.spec.volumes.find(
    ({ name }) => name === "repository-registry",
  );
  assert.equal(
    registryVolume.secret.secretName,
    "team-a-codeops-repository-controller-authority",
  );
  assert.equal(
    JSON.stringify(controller).includes("github-webhook-secret"),
    false,
  );
  assert.equal(
    JSON.stringify(controller).includes("github-steering-token"),
    false,
  );
  assert.equal(JSON.stringify(controller).includes("plane-api-key"), false);
  assert.equal(
    JSON.stringify(controller).includes("plane-webhook-secret"),
    false,
  );
  const contexts = controller.spec.template.spec.volumes.find(
    ({ name }) => name === "repository-contexts",
  );
  assert.deepEqual(
    contexts.projected.sources.map(({ secret }) => secret.name),
    ["team-a-renoconcierge-context", "team-a-codeops-context"],
  );
  assert.equal(
    contexts.projected.sources.every(
      ({ secret }) =>
        secret.items.length === 7 &&
        secret.items.every(({ path }) =>
          path.startsWith(
            secret.name.includes("renoconcierge")
              ? "renoconcierge/"
              : "codeops/",
          ),
        ),
    ),
    true,
  );
});

test("defaults to deny and opens only explicit component paths", () => {
  const resources = render();
  const policies = resources.filter(({ kind }) => kind === "NetworkPolicy");
  assert.equal(policies.length, 11);
  const deny = resource(resources, "NetworkPolicy", "team-a-codeops-default-deny");
  assert.deepEqual(deny.spec.podSelector, {
    matchLabels: { "app.kubernetes.io/part-of": "codeops" },
  });
  assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"]);

  const postgresql = resource(resources, "NetworkPolicy", "team-a-codeops-postgresql");
  assert.deepEqual(postgresql.spec.egress, []);
  assert.ok(JSON.stringify(postgresql.spec.ingress).includes("session-migration"));
  const gateway = resource(resources, "NetworkPolicy", "team-a-codeops-session-gateway");
  assert.ok(JSON.stringify(gateway).includes("github-controller"));
  assert.ok(JSON.stringify(gateway).includes("team-a-codeops-postgresql"));
  const controller = resource(resources, "NetworkPolicy", "team-a-codeops-github-controller");
  assert.ok(JSON.stringify(controller).includes("team-a-codeops-session-gateway"));
  assert.ok(JSON.stringify(controller).includes("team-a-codeops-control-gateway"));
  const controlGateway = resource(resources, "NetworkPolicy", "team-a-codeops-control-gateway");
  assert.ok(JSON.stringify(controlGateway).includes("10.43.0.1/32"));
  assert.ok(JSON.stringify(controlGateway.spec.ingress).includes("orchestrator"));
  const orchestrator = resource(resources, "NetworkPolicy", "team-a-codeops-orchestrator");
  assert.ok(JSON.stringify(orchestrator).includes("team-a-codeops-control-gateway"));
  const migration = resource(resources, "NetworkPolicy", "team-a-codeops-session-migration");
  assert.ok(JSON.stringify(migration).includes("team-a-codeops-postgresql"));
  assert.deepEqual(
    migration.spec.egress.flatMap(({ ports = [] }) => ports.map(({ protocol, port }) => `${protocol}:${port}`)).sort(),
    ["TCP:53", "TCP:5432", "UDP:53"],
  );
  const modelProxy = resource(resources, "NetworkPolicy", "team-a-codeops-model-proxy");
  assert.ok(JSON.stringify(modelProxy.spec.ingress).includes("runtime"));
  assert.deepEqual(
    modelProxy.spec.ingress.flatMap(({ ports = [] }) => ports.map(({ protocol, port }) => `${protocol}:${port}`)),
    ["TCP:8080"],
  );
  const relay = resource(resources, "NetworkPolicy", "team-a-codeops-lifecycle-relay");
  assert.match(JSON.stringify(relay), /TCP.*4222/);
});

test("creates a complete one-repository quickstart from one values file", () => {
  const resources = renderQuickstart();
  const secrets = resources.filter(({ kind }) => kind === "Secret");
  assert.equal(secrets.length, 18);
  assert.equal(
    secrets.every((secret) => secret.metadata.annotations["helm.sh/resource-policy"] === "keep"),
    true,
  );

  const postgresql = resource(resources, "Secret", "codeops-postgres");
  assert.match(postgresql.stringData.password, /^[A-Za-z0-9]{48}$/);
  const session = resource(resources, "Secret", "codeops-session-secrets");
  assert.match(
    session.stringData["database-url"],
    /^postgresql:\/\/agents:[A-Za-z0-9]{48}@codeops-database:5432\/agents$/,
  );
  assert.match(
    session.stringData["runtime-database-url"],
    /^postgresql:\/\/codeops_runtime_receipts:[A-Za-z0-9]{48}@codeops-database:5432\/agents$/,
  );
  assert.equal(session.stringData["runtime-database-role"], "codeops_runtime_receipts");
  const registryPull = resource(resources, "Secret", "codeops-registry");
  assert.equal(registryPull.type, "kubernetes.io/dockerconfigjson");
  const dockerConfig = JSON.parse(registryPull.stringData[".dockerconfigjson"]);
  assert.equal(dockerConfig.auths["ghcr.io"].username, "fixture-user");
  assert.equal(
    Buffer.from(dockerConfig.auths["ghcr.io"].auth, "base64").toString("utf8"),
    "fixture-user:fixture-registry-token-0000000000000001",
  );

  const runtime = resource(resources, "Secret", "codeops-repository-runtime-authority");
  const controller = resource(resources, "Secret", "codeops-repository-controller-authority");
  const steering = resource(resources, "Secret", "codeops-repository-steering");
  const controllerConfig = resource(resources, "Secret", "codeops-controller-config");
  assert.deepEqual(controllerConfig.stringData, {
    CODEOPS_TEMPORAL_ADDRESS: "codeops-temporal-frontend:7233",
    CODEOPS_TEMPORAL_NAMESPACE: "codeops",
    CODEOPS_TEMPORAL_TASK_QUEUE: "codeops",
  });
  assert.deepEqual(Object.keys(runtime.stringData).sort(), [
    "github-read-token", "github-write-token", "registry.json",
  ]);
  assert.deepEqual(Object.keys(steering.stringData).sort(), [
    "github-steering-token", "registry.json",
  ]);
  assert.deepEqual(Object.keys(controller.stringData).sort(), [
    "github-steering-token",
    "github-webhook-secret",
    "plane-api-key",
    "plane-webhook-secret",
    "registry.json",
  ]);
  const runtimeRegistry = JSON.parse(runtime.stringData["registry.json"]);
  const controllerRegistry = JSON.parse(controller.stringData["registry.json"]);
  const steeringRegistry = JSON.parse(steering.stringData["registry.json"]);
  assert.equal(runtimeRegistry.version, "codeops.repository-registry/v1");
  assert.equal(runtimeRegistry.repositories.length, 1);
  assert.equal(runtimeRegistry.repositories[0].repository, "example/codeops-demo");
  assert.deepEqual(Object.keys(runtimeRegistry.repositories[0]).sort(), [
    "readTokenFile", "repository", "repositoryUrl", "writeTokenFile",
  ]);
  assert.equal(
    steeringRegistry.repositories[0].githubSteeringTokenFile,
    "/var/run/secrets/codeops-steering/github-steering-token",
  );
  assert.equal(steeringRegistry.repositories[0].plane, undefined);
  assert.equal(
    controllerRegistry.repositories[0].githubWebhookSecretFile,
    "/var/run/secrets/codeops-repositories/github-webhook-secret",
  );
  assert.equal(
    controllerRegistry.repositories[0].githubSteeringTokenFile,
    "/var/run/secrets/codeops-repositories/github-steering-token",
  );
  assert.deepEqual(controllerRegistry.repositories[0].policy.githubReviewerIds, [12345678]);
  assert.equal(
    controllerRegistry.repositories[0].policy.projectContextRoot,
    "/var/run/secrets/codeops-contexts/codeops-demo",
  );
  assert.equal(controllerRegistry.repositories[0].policy.planePersonas.length, 7);

  const context = resource(resources, "Secret", "codeops-context");
  assert.deepEqual(Object.keys(context.stringData).sort(), [
    "AGENTS.md",
    "CURRENT-STATE.md",
    "DECISIONS.md",
    "DOMAIN.md",
    "PRODUCT.md",
    "SOUL.md",
    "SOURCE-MAP.md",
  ]);
  const deployment = resource(resources, "Deployment", "codeops-github-controller");
  assert.deepEqual(deployment.spec.template.spec.imagePullSecrets, [{ name: "codeops-registry" }]);
  const contexts = deployment.spec.template.spec.volumes.find(
    ({ name }) => name === "repository-contexts",
  );
  assert.deepEqual(
    contexts.projected.sources.map(({ secret }) => secret.name),
    ["codeops-context"],
  );
});

test("quickstart fails before render when required authority is missing or reused", () => {
  assert.throws(
    () => helm([
      "template", "codeops", chart,
      "--namespace", "codeops",
      ...quickstartSets.flatMap((value) => ["--set", value]),
      "--set", "quickstart.enabled=true",
    ]),
    /quickstart\.repository\.identity/,
  );
  assert.throws(
    () => helm([
      "template", "codeops", chart,
      "--namespace", "codeops",
      "--values", "infra/fixtures/helm/quickstart-values.yaml",
      ...quickstartSets.flatMap((value) => ["--set", value]),
      "--set", "quickstart.repository.plane.apiKey=fixture-github-read-token-0000000000001",
    ]),
    /authority-scoped and unique/,
  );
  assert.throws(
    () => helm([
      "template", "codeops", chart,
      "--namespace", "codeops",
      "--values", "infra/fixtures/helm/quickstart-values.yaml",
      ...quickstartSets.flatMap((value) => ["--set", value]),
      "--set-string", "quickstart.repository.github.reviewerIds[0]=not-a-user-id",
    ]),
    /positive numeric GitHub user IDs/,
  );
});

test("accepts arbitrary namespaces and fails closed on invalid configuration", () => {
  assert.doesNotThrow(() => helm([
    "template", "team-a", chart,
    "--namespace", "another-namespace",
    ...digestSets.flatMap((value) => ["--set", value]),
  ]));
  const cases = [
    ["--namespace", "engineering", "--set", "ingress.host=UPPER.example.com"],
    ["--namespace", "engineering", "--set", "agentsUi.access.issuer=https://example.com"],
    ["--namespace", "engineering", "--set", "gateway.image.digest=latest"],
    ["--namespace", "engineering", "--set", "githubController.controlPlaneSha=main"],
    ["--namespace", "engineering", "--set", "githubController.repositoryAuthoritySecretName=Invalid_Name"],
    ["--namespace", "engineering", "--set", "gateway.repositorySteeringRegistrySecretName=Invalid_Name"],
    ["--namespace", "engineering", "--set", "controlGateway.kubernetesApiCidrs={}"],
    ["--namespace", "engineering", "--set", "controlGateway.kubernetesApiCidrs[0]=not-a-cidr"],
    ["--namespace", "engineering", "--set", "temporal.address=missing-port"],
    ["--namespace", "engineering", "--set", "githubController.repositoryContexts[0].directory=../escape"],
  ];
  for (const extra of cases) {
    assert.throws(() => helm([
      "template", "team-a", chart,
      ...digestSets.flatMap((value) => ["--set", value]),
      ...extra,
    ]));
  }
});
