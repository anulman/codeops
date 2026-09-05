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
  "runtime.releaseDigest=sha256:7878787878787878787878787878787878787878787878787878787878787878",
  "modelProxy.image.digest=sha256:9999999999999999999999999999999999999999999999999999999999999999",
  "gateway.secretName=team-a-codeops-session-secrets",
  "gateway.repositorySteeringRegistrySecretName=team-a-codeops-repository-steering",
  "controlGateway.secretName=team-a-codeops-control-gateway-secrets",
  "controlGateway.repositoryAuthoritySecretName=team-a-codeops-repository-runtime-authority",
  "controlGateway.kubernetesApiCidrs[0]=10.43.0.1/32",
  "modelProxy.secretName=team-a-codeops-model-proxy-credentials",
  "githubController.configSecretName=team-a-codeops-controller-config",
  "githubController.secretName=team-a-codeops-controller-secrets",
  "githubController.repositoryAuthoritySecretName=team-a-codeops-repository-controller-authority",
  "githubController.repositoryContexts[0].directory=example-repository",
  "githubController.repositoryContexts[0].secretName=team-a-example-repository-context",
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

function render(extra = []) {
  const output = helm([
    "template", "team-a", chart,
    "--namespace", "engineering",
    ...digestSets.flatMap((value) => ["--set", value]),
    ...extra,
  ]);
  return parseAllDocuments(output)
    .map((document) => document.toJSON())
    .filter(Boolean);
}

function renderUpgrade(extra = []) {
  const output = helm([
    "template", "team-a", chart,
    "--namespace", "engineering",
    "--is-upgrade",
    ...digestSets.flatMap((value) => ["--set", value]),
    ...extra,
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
  assert.equal(images.length, 11); // Relay no longer duplicates the migration container.
  assert.equal(new Set(images).size, 7);
  assert.ok(images.every((image) => /@sha256:[0-9a-f]{64}$/.test(image)));

  resource(resources, "StatefulSet", "team-a-codeops-postgresql");
  const sessionGateway = resource(resources, "Deployment", "team-a-codeops-session-gateway");
  assert.deepEqual(sessionGateway.spec.strategy, {
    type: "RollingUpdate",
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
  });
  const githubControllerDeployment = resource(
    resources,
    "Deployment",
    "team-a-codeops-github-controller",
  );
  resource(resources, "Deployment", "team-a-codeops-agents-ui");
  const controlGateway = resource(resources, "Deployment", "team-a-codeops-control-gateway");
  assert.deepEqual(controlGateway.spec.strategy, {
    type: "RollingUpdate",
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
  });
  const orchestrator = resource(resources, "Deployment", "team-a-codeops-orchestrator");
  resource(resources, "Service", "team-a-codeops-control-gateway");
  resource(resources, "PersistentVolumeClaim", "team-a-codeops-control-gateway-evidence");
  resource(resources, "Role", "team-a-codeops-control-gateway");
  resource(resources, "RoleBinding", "team-a-codeops-control-gateway");
  assert.match(JSON.stringify(controlGateway), /team-a-codeops-repository-runtime-authority/);
  const controlGatewayEnv = Object.fromEntries(
    controlGateway.spec.template.spec.containers[0].env.map(({ name, value }) => [name, value]),
  );
  assert.equal(controlGatewayEnv.CODEOPS_MODEL_PROXY_ORIGIN, "http://team-a-codeops-model-proxy:8080");
  const githubControllerEnv = Object.fromEntries(
    githubControllerDeployment.spec.template.spec.containers[0].env.map(
      ({ name, value }) => [name, value],
    ),
  );
  assert.equal(
    githubControllerEnv.CODEOPS_MODEL_PROXY_ORIGIN,
    "http://team-a-codeops-model-proxy:8080",
  );
  assert.match(JSON.stringify(githubControllerDeployment), /model-proxy\/signing-key/);
  assert.equal(controlGatewayEnv.CODEOPS_AGENT_MODEL_PROXY_SERVICE_NAME, "team-a-codeops-model-proxy");
  assert.equal(controlGatewayEnv.CODEOPS_AGENT_MODEL_PROXY_POD_NAME, "team-a-codeops-model-proxy");
  assert.equal(controlGatewayEnv.CODEOPS_AGENT_EVIDENCE_CLAIM_NAME, "team-a-codeops-control-gateway-evidence");
  assert.deepEqual(JSON.parse(controlGatewayEnv.CODEOPS_AGENT_IMAGE_PULL_SECRETS), []);
  assert.deepEqual(JSON.parse(controlGatewayEnv.CODEOPS_AGENT_NODE_SELECTOR), {});
  assert.doesNotMatch(JSON.stringify(controlGateway), /CODEOPS_REPOSITORY_(URL|READ_TOKEN|WRITE_TOKEN)/);
  assert.match(JSON.stringify(orchestrator), /codeops-temporal-frontend:7233/);
  const modelProxy = resource(resources, "Deployment", "team-a-codeops-model-proxy");
  const proxySource = JSON.stringify(modelProxy);
  assert.match(proxySource, /team-a-codeops-model-proxy-credentials/);
  assert.match(proxySource, /openai-api-key/);
  assert.match(proxySource, /signing-key/);
  assert.match(proxySource, /CODEOPS_MODEL_PROXY_DATABASE_URL/);
  assert.match(proxySource, /database-url/);
  assert.equal(
    modelProxy.spec.template.spec.containers[0].env.find(
      ({ name }) => name === "CODEOPS_MODEL_PROXY_PRIVACY_MODE",
    ).value,
    "strict-v1",
  );
  const migration = resource(resources, "Job", "team-a-codeops-session-migrate");
  assert.equal(migration.metadata.annotations?.["helm.sh/hook"], undefined);
  assert.equal(
    migration.metadata.annotations?.["helm.sh/hook-delete-policy"],
    undefined,
  );
  assert.equal(migration.spec.backoffLimit, 0);
  assert.equal(migration.spec.template.spec.serviceAccountName, "team-a-codeops-session-migration");
  assert.equal(resource(resources, "ServiceAccount", "team-a-codeops-session-migration").metadata.annotations["helm.sh/hook-weight"], "-13");
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
    ["runtime-database-role", "runtime-database-url"],
  );
  assert.deepEqual(
    migration.spec.template.spec.volumes.find(({ name }) => name === "relay-authority").secret.items.map(({ key }) => key).sort(),
    ["database-role", "database-url"],
  );
  assert.deepEqual(
    migration.spec.template.spec.volumes.find(({ name }) => name === "model-proxy-authority").secret.items.map(({ key }) => key).sort(),
    ["database-role", "database-url"],
  );
  const relay = resource(resources, "Deployment", "team-a-codeops-lifecycle-relay");
  assert.equal(relay.spec.template.spec.containers[0].image, controlGateway.spec.template.spec.containers[0].image);
  assert.equal(relay.spec.template.spec.initContainers, undefined);
  assert.equal(relay.spec.template.spec.volumes.some(({name}) => name === "migration-authority"), false);
  const ownerSecret = migration.spec.template.spec.volumes.find(({name}) => name === "migration-authority").secret;
  assert.equal(ownerSecret.secretName, "codeops-migration-secrets");
  assert.deepEqual(ownerSecret.items, [{key: "database-url", path: "database-url"}]);
  for (const app of resources.filter(item => item.kind === "Deployment")) {
    assert.equal((app.spec.template.spec.volumes ?? []).some(volume => volume.secret?.secretName === ownerSecret.secretName), false);
  }
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
  const runtimeImages = resources.find(
    ({ kind, metadata }) =>
      kind === "ConfigMap" &&
      metadata?.labels?.["app.kubernetes.io/component"] === "runtime",
  );
  assert.ok(runtimeImages);
  assert.match(runtimeImages.metadata.name, /^team-a-codeops-runtime-images-[0-9a-f]{12}$/);
  assert.ok(runtimeImages.metadata.name.length <= 63);
  assert.equal(runtimeImages.immutable, true);
  const profileRegistry = JSON.parse(runtimeImages.data["profile-registry.json"]);
  assert.equal(profileRegistry.profiles[0].releaseDigest, `sha256:${"78".repeat(32)}`);
  assert.equal(
    profileRegistry.profiles[0].images.sessionGateway,
    `ghcr.io/anulman/codeops/session-gateway@sha256:${"56".repeat(32)}`,
  );
  const sessionGatewayEnv = Object.fromEntries(
    sessionGateway.spec.template.spec.containers[0].env.map(({ name, value }) => [name, value]),
  );
  assert.equal(sessionGatewayEnv.CODEOPS_RUNTIME_PROFILE_REGISTRY_FILE, "/var/run/codeops-runtime/profile-registry.json");
  assert.equal(sessionGatewayEnv.CODEOPS_RUNTIME_COMPATIBILITY_POLICY_REVISION, "compatible-substitution-v1");
  assert.equal(
    sessionGateway.spec.template.spec.volumes.find(({ name }) => name === "runtime-profile-registry").configMap.name,
    runtimeImages.metadata.name,
  );
  for (const [key, value] of Object.entries(runtimeImages.data)) {
    if (key === "profile-registry.json") continue;
    if (value.includes("ghcr.io/")) assert.match(value, /@sha256:[0-9a-f]{64}$/);
  }
  for (const name of ["agents-ui", "session-gateway", "github-controller", "orchestrator", "runtime", "model-proxy"]) {
    const account = resource(resources, "ServiceAccount", `team-a-codeops-${name}`);
    assert.equal(account.automountServiceAccountToken, false);
  }
  const controlGatewayAccount = resource(resources, "ServiceAccount", "team-a-codeops-control-gateway");
  assert.notEqual(controlGatewayAccount.automountServiceAccountToken, false);
});

test("isolates subscription auth in the model proxy and keeps API fallback", () => {
  const resources = render([
    "--set", "modelProxy.provider.primary=chatgpt-primary",
    "--set", "modelProxy.provider.apiKeyFallback=true",
    "--set", "modelProxy.provider.chatgptAuthClaimName=agents-system-codex-auth",
  ]);
  const modelProxy = resource(resources, "Deployment", "team-a-codeops-model-proxy");
  const container = modelProxy.spec.template.spec.containers[0];
  const env = Object.fromEntries(container.env.map(({ name, value }) => [name, value]));
  assert.equal(modelProxy.spec.strategy.type, "Recreate");
  assert.equal(modelProxy.spec.template.spec.securityContext.fsGroup, 1000);
  assert.equal(
    modelProxy.spec.template.spec.securityContext.fsGroupChangePolicy,
    "OnRootMismatch",
  );
  assert.equal(env.CODEOPS_MODEL_PROVIDER_PRIMARY, "chatgpt-primary");
  assert.equal(env.CODEOPS_MODEL_API_KEY_FALLBACK, "true");
  assert.equal(env.CODEOPS_CHATGPT_AUTH_FILE, "/var/lib/codeops-codex/auth.json");
  assert.deepEqual(container.volumeMounts, [
    { name: "chatgpt-auth", mountPath: "/var/lib/codeops-codex" },
  ]);
  assert.deepEqual(modelProxy.spec.template.spec.volumes, [{
    name: "chatgpt-auth",
    persistentVolumeClaim: { claimName: "agents-system-codex-auth" },
  }]);
  const serialized = JSON.stringify(resources);
  assert.equal(serialized.match(/agents-system-codex-auth/g)?.length, 1);
  assert.match(JSON.stringify(container.env), /openai-api-key/);

  for (const extra of [
    ["--set", "modelProxy.provider.primary=chatgpt-primary"],
    [
      "--set", "modelProxy.provider.primary=chatgpt-primary",
      "--set", "modelProxy.provider.chatgptAuthClaimName=agents-system-codex-auth",
      "--set", "modelProxy.replicas=2",
    ],
  ]) {
    assert.throws(() => render(extra));
  }
  assert.throws(
    () => render(["--set", "modelProxy.provider.primary=unknown"]),
    /modelProxy\.provider\.primary must be api-key or chatgpt-primary/,
  );
});

test("renders the signed Astra profile only through dedicated OAuth with no API fallback", () => {
  const settings = [
    "--set", "runtime.profileId=gpt-6-astra",
    "--set", "runtime.model=gpt-6-astra",
    "--set", "modelProxy.provider.primary=chatgpt-primary",
    "--set", "modelProxy.provider.apiKeyFallback=false",
    "--set", "modelProxy.provider.chatgptAuthClaimName=agents-system-codex-auth",
  ];
  for (const resources of [render(settings), renderUpgrade(settings)]) {
    const modelProxy = resource(resources, "Deployment", "team-a-codeops-model-proxy");
    const container = modelProxy.spec.template.spec.containers[0];
    const env = Object.fromEntries(container.env.map(({ name, value }) => [name, value]));
    assert.equal(env.CODEOPS_MODEL_PROVIDER_PRIMARY, "chatgpt-primary");
    assert.equal(env.CODEOPS_MODEL_API_KEY_FALLBACK, "false");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(JSON.stringify(container.env).includes("openai-api-key"), false);
    assert.equal(modelProxy.spec.template.spec.volumes[0]
      .persistentVolumeClaim.claimName, "agents-system-codex-auth");
    const runtime = resources.find(({ kind, metadata }) => kind === "ConfigMap" &&
      metadata?.labels?.["app.kubernetes.io/component"] === "runtime");
    const profile = JSON.parse(runtime.data["profile-registry.json"]).profiles[0];
    assert.equal(profile.profileId, "gpt-6-astra");
    assert.ok(profile.capabilities.includes("api-key-fallback:false"));
    assert.ok(profile.capabilities.includes("model:gpt-6-astra"));
    assert.ok(profile.capabilities.includes("provider-route:chatgpt-primary"));
  }
  for (const invalid of [
    ["--set", "runtime.profileId=gpt-6-astra", "--set", "runtime.model=gpt-6-astra"],
    [...settings, "--set", "modelProxy.provider.apiKeyFallback=true"],
    [...settings, "--set", "modelProxy.provider.chatgptAuthClaimName="],
  ]) assert.throws(() => render(invalid));
});

test("runs migration as an ordinary install Job and a pre-upgrade hook", () => {
  const resources = renderUpgrade();
  const migration = resource(
    resources,
    "Job",
    "team-a-codeops-session-migrate",
  );
  assert.equal(migration.metadata.annotations["helm.sh/hook"], "pre-upgrade");
  assert.equal(
    migration.metadata.annotations["helm.sh/hook-delete-policy"],
    "before-hook-creation,hook-succeeded",
  );
  assert.equal(migration.metadata.annotations["helm.sh/hook-weight"], "-10");
  assert.equal(migration.spec.template.spec.serviceAccountName,
    "team-a-codeops-session-migration");
  assert.equal(migration.spec.template.spec.automountServiceAccountToken, true);
  const env = Object.fromEntries(migration.spec.template.spec.containers[0].env
    .map(({ name, value }) => [name, value]));
  assert.equal(env.CODEOPS_MIGRATION_QUIESCE_WRITERS, "true");
  assert.equal(env.CODEOPS_NAMESPACE, "engineering");
  assert.deepEqual(JSON.parse(env.CODEOPS_MIGRATION_WRITER_DEPLOYMENTS), [
    "team-a-codeops-session-gateway",
  ]);
  const controlGateway = resource(resources, "Deployment",
    "team-a-codeops-control-gateway");
  assert.deepEqual(controlGateway.spec.strategy, {
    type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
  });
  const apiVolumes = controlGateway.spec.template.spec.volumes;
  assert.equal(apiVolumes.some((volume) => volume.persistentVolumeClaim !== undefined), false,
    "the rolling DB-backed API must not mount file-backed evidence");
  const apiEnv = Object.fromEntries(controlGateway.spec.template.spec.containers[0].env
    .map(({ name, value }) => [name, value]));
  assert.equal(apiEnv.CODEOPS_CONTROL_GATEWAY_RUNTIME_ROLE, "api");
  const dispatcher = resource(resources, "Deployment",
    "team-a-codeops-control-gateway-dispatcher");
  assert.equal(dispatcher.spec.replicas, 1);
  assert.deepEqual(dispatcher.spec.strategy, { type: "Recreate" });
  assert.equal(dispatcher.spec.template.spec.volumes.filter(
    (volume) => volume.persistentVolumeClaim?.claimName ===
      "team-a-codeops-control-gateway-evidence").length, 1);
  const dispatcherEnv = Object.fromEntries(dispatcher.spec.template.spec.containers[0].env
    .map(({ name, value }) => [name, value]));
  assert.equal(dispatcherEnv.CODEOPS_CONTROL_GATEWAY_RUNTIME_ROLE, "file-dispatcher");
  assert.equal(dispatcherEnv.CODEOPS_RUNTIME_PROFILE_REGISTRY_FILE,
    "/var/run/codeops-runtime/profile-registry.json");
  assert.equal(dispatcherEnv.CODEOPS_RUNTIME_COMPATIBILITY_POLICY_REVISION,
    "compatible-substitution-v1");
  assert.match(dispatcher.spec.template.spec.volumes.find(
    ({ name }) => name === "runtime-profile-registry").configMap.name,
  /^team-a-codeops-runtime-images-[0-9a-f]{12}$/);
  assert.equal(dispatcher.spec.template.spec.containers[0].volumeMounts.some(
    ({ name, mountPath, readOnly }) => name === "runtime-profile-registry" &&
      mountPath === "/var/run/codeops-runtime" && readOnly === true), true);
  const dispatcherService = resource(resources, "Service",
    "team-a-codeops-control-gateway-dispatcher");
  assert.deepEqual(dispatcherService.spec.selector,
    { "app.kubernetes.io/name": "team-a-codeops-control-gateway-dispatcher" });
  const orchestrator = resource(resources, "Deployment", "team-a-codeops-orchestrator");
  const orchestratorEnv = Object.fromEntries(orchestrator.spec.template.spec.containers[0].env
    .map(({ name, value }) => [name, value]));
  assert.equal(orchestratorEnv.CODEOPS_AGENT_DISPATCH_ORIGIN,
    "http://team-a-codeops-control-gateway-dispatcher:8080");
  assert.ok(!JSON.parse(env.CODEOPS_MIGRATION_WRITER_DEPLOYMENTS)
    .includes("team-a-codeops-control-gateway"),
  "an active runtime Job keeps claim, renewal, and completion service during migration");
  const role = resource(resources, "Role",
    "team-a-codeops-session-migration-quiesce");
  assert.equal(role.metadata.annotations["helm.sh/hook-weight"], "-12");
  assert.deepEqual(role.rules, [
    { apiGroups: ["apps"], resources: ["deployments", "deployments/scale"],
      resourceNames: ["team-a-codeops-session-gateway"], verbs: ["get", "patch"] },
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
  ]);
  const binding = resource(resources, "RoleBinding",
    "team-a-codeops-session-migration-quiesce");
  assert.equal(binding.metadata.annotations["helm.sh/hook-weight"], "-11");
  assert.equal(binding.subjects[0].name, "team-a-codeops-session-migration");
  const migrationPolicy = resource(resources, "NetworkPolicy",
    "team-a-codeops-session-migration");
  assert.ok(JSON.stringify(migrationPolicy).includes("10.43.0.1/32"));
  assert.deepEqual(
    migrationPolicy.spec.egress.flatMap(({ ports = [] }) =>
      ports.map(({ protocol, port }) => `${protocol}:${port}`)).sort(),
    ["TCP:443", "TCP:53", "TCP:5432", "TCP:6443", "UDP:53"],
  );
});

test("keeps a multi-node API rollout off the singleton RWO file dispatcher", () => {
  const resources = renderUpgrade();
  const api = resource(resources, "Deployment", "team-a-codeops-control-gateway");
  const dispatcher = resource(resources, "Deployment",
    "team-a-codeops-control-gateway-dispatcher");
  const claim = resource(resources, "PersistentVolumeClaim",
    "team-a-codeops-control-gateway-evidence");
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"]);
  assert.deepEqual(api.spec.strategy,
    { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } });
  assert.equal(api.spec.template.spec.volumes.some(
    (volume) => volume.persistentVolumeClaim?.claimName === claim.metadata.name), false);
  assert.equal(dispatcher.spec.replicas, 1);
  assert.deepEqual(dispatcher.spec.strategy, { type: "Recreate" });
  assert.equal(dispatcher.spec.template.spec.volumes.some(
    (volume) => volume.persistentVolumeClaim?.claimName === claim.metadata.name), true);
});

test("wires Web Push only from an explicit public configuration and private Secret", () => {
  const resources = render([
    "--set", "controlGateway.webPush.enabled=true",
    "--set", `controlGateway.webPush.publicKey=${"A".repeat(87)}`,
    "--set", "controlGateway.webPush.subject=mailto:ops@example.com",
    "--set", "controlGateway.webPush.secretName=team-a-web-push",
  ]);
  const deployment = resource(resources, "Deployment", "team-a-codeops-control-gateway");
  const container = deployment.spec.template.spec.containers[0];
  const env = Object.fromEntries(container.env.map(({ name, value }) => [name, value]));
  assert.equal(env.CODEOPS_WEB_PUSH_PUBLIC_KEY, "A".repeat(87));
  assert.equal(env.CODEOPS_WEB_PUSH_SUBJECT, "mailto:ops@example.com");
  assert.equal(env.CODEOPS_WEB_PUSH_PRIVATE_KEY_FILE, "/var/run/secrets/codeops-web-push/private-key");
  const volume = deployment.spec.template.spec.volumes.find(({ name }) => name === "web-push-auth");
  assert.equal(volume.secret.secretName, "team-a-web-push");
  assert.equal(volume.secret.items[0].key, "private-key");
  assert.equal(JSON.stringify(deployment).includes("privateKey"), false);
});

test("isolates the optional S3 proof publisher credential", () => {
  const resources = render([
    "--set", "proofPublisher.enabled=true",
    "--set", "proofPublisher.destinationId=s3:test-region:codeops-proofs",
    "--set", "proofPublisher.s3.endpoint=https://s3.region-1.example.test/",
    "--set", "proofPublisher.s3.publicBaseUrl=https://codeops-proofs.s3.region-1.example.test/",
    "--set", "proofPublisher.s3.bucket=codeops-proofs",
    "--set", "proofPublisher.s3.region=region-1",
    "--set", "proofPublisher.s3.credentialSecretName=team-a-proof-s3",
    "--set", "proofPublisher.auth.secretName=team-a-proof-auth",
  ]);
  const publisher = resource(resources, "Deployment", "team-a-codeops-proof-publisher");
  const container = publisher.spec.template.spec.containers[0];
  assert.equal(publisher.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(
    container.image,
    "ghcr.io/anulman/codeops/control-gateway@sha256:1212121212121212121212121212121212121212121212121212121212121212",
  );
  assert.deepEqual(container.command, [
    "node",
    "services/codeops-control-gateway/dist/proof-publisher-main.js",
  ]);
  const s3 = publisher.spec.template.spec.volumes.find(({ name }) => name === "s3-credentials");
  assert.equal(s3.secret.secretName, "team-a-proof-s3");
  assert.deepEqual(s3.secret.items, [
    { key: "access-key-id", path: "access-key-id" },
    { key: "secret-access-key", path: "secret-access-key" },
  ]);
  const serializedOtherWorkloads = JSON.stringify(resources.filter(({ kind, metadata }) =>
    ["Deployment", "Job", "StatefulSet"].includes(kind) &&
    metadata?.name !== "team-a-codeops-proof-publisher"
  ));
  assert.doesNotMatch(serializedOtherWorkloads, /team-a-proof-s3|CODEOPS_PROOF_PUBLISHER_ACCESS_KEY/);
  const gateway = resource(resources, "Deployment", "team-a-codeops-control-gateway");
  const gatewayContainer = gateway.spec.template.spec.containers[0];
  assert.equal(
    gatewayContainer.env.find(({ name }) => name === "CODEOPS_PROOF_PUBLISHER_ORIGIN").value,
    "http://team-a-codeops-proof-publisher:8080",
  );
  assert.equal(
    gatewayContainer.env.find(({ name }) => name === "CODEOPS_PROOF_PUBLISHER_PUBLIC_BASE_URL").value,
    "https://codeops-proofs.s3.region-1.example.test/",
  );
  assert.equal(
    gateway.spec.template.spec.volumes.find(({ name }) => name === "proof-publisher-auth").secret.secretName,
    "team-a-proof-auth",
  );
  const policy = resource(resources, "NetworkPolicy", "team-a-codeops-proof-publisher");
  assert.deepEqual(
    policy.spec.ingress[0].from[0].podSelector.matchLabels,
    { "app.kubernetes.io/name": "team-a-codeops-control-gateway" },
  );
  assert.deepEqual(
    policy.spec.egress.flatMap(({ ports = [] }) => ports.map(({ protocol, port }) => `${protocol}:${port}`)).sort(),
    ["TCP:443", "TCP:53", "UDP:53"],
  );
  resource(resources, "Service", "team-a-codeops-proof-publisher");

  assert.throws(() => render(["--set", "proofPublisher.enabled=true"]));
  assert.throws(() => render([
    "--set", "proofPublisher.enabled=true",
    "--set", "proofPublisher.destinationId=s3:test-region:codeops-proofs",
    "--set", "proofPublisher.s3.endpoint=https://s3.region-1.example.test/",
    "--set", "proofPublisher.s3.publicBaseUrl=https://codeops-proofs.s3.region-1.example.test/",
    "--set", "proofPublisher.s3.bucket=codeops-proofs",
    "--set", "proofPublisher.s3.region=region-1",
    "--set", "proofPublisher.s3.credentialSecretName=same-secret",
    "--set", "proofPublisher.auth.secretName=same-secret",
  ]));
});

test("renders the optional runtime egress proxy as one fail-closed boundary", () => {
  const resources = render([
    "--set", "runtimeEgressProxy.enabled=true",
    "--set", `runtimeEgressProxy.image.digest=sha256:${"6".repeat(64)}`,
    "--set", "runtimeEgressProxy.allowedDomains[0]=registry.npmjs.org",
    "--set", "runtimeEgressProxy.allowedDomains[1]=pypi.org",
  ]);
  const proxy = resource(resources, "Deployment", "team-a-codeops-runtime-egress-proxy");
  assert.equal(
    proxy.spec.template.spec.containers[0].image,
    `ubuntu/squid@sha256:${"6".repeat(64)}`,
  );
  assert.equal(proxy.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(
    proxy.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem,
    true,
  );
  const config = resource(resources, "ConfigMap", "team-a-codeops-runtime-egress-proxy");
  assert.match(config.data["squid.conf"], /http_access allow runtime_clients allowed_domains/);
  assert.match(config.data["squid.conf"], /http_access deny all\s*$/m);
  assert.doesNotMatch(
    config.data["squid.conf"].match(/^\s*logformat\s+codeops_json\s+(.+)$/m)?.[1] ?? "",
    /Authorization|Cookie|request_body|reply_body|%ru/,
  );
  assert.match(config.data["squid.conf"], /%\"\.16rm/);
  assert.match(config.data["squid.conf"], /%\"\.320>rd/);
  const proxyPolicy = resource(
    resources,
    "NetworkPolicy",
    "team-a-codeops-runtime-egress-proxy",
  );
  assert.match(JSON.stringify(proxyPolicy), /100\.64\.0\.0\/10/);
  assert.match(JSON.stringify(proxyPolicy), /169\.254\.0\.0\/16/);
  const runtimePolicy = resource(resources, "NetworkPolicy", "team-a-codeops-runtime");
  const runtimePolicyText = JSON.stringify(runtimePolicy);
  assert.match(runtimePolicyText, /team-a-codeops-runtime-egress-proxy/);
  assert.doesNotMatch(runtimePolicyText, /"cidr":"0\.0\.0\.0\/0"/);
  const controlGateway = resource(resources, "Deployment", "team-a-codeops-control-gateway");
  const env = Object.fromEntries(
    controlGateway.spec.template.spec.containers[0].env.map(({ name, value }) => [name, value]),
  );
  assert.equal(
    env.CODEOPS_RUNTIME_EGRESS_PROXY_ORIGIN,
    "http://team-a-codeops-runtime-egress-proxy:3128",
  );
  assert.equal(
    env.CODEOPS_RUNTIME_EGRESS_PROXY_SERVICE_NAME,
    "team-a-codeops-runtime-egress-proxy",
  );
});

test("keeps the documented direct runtime HTTPS policy when the proxy is disabled", () => {
  const resources = render();
  assert.equal(
    resources.some(({ metadata }) =>
      metadata?.name === "team-a-codeops-runtime-egress-proxy"
    ),
    false,
  );
  const runtimePolicy = resource(resources, "NetworkPolicy", "team-a-codeops-runtime");
  assert.match(JSON.stringify(runtimePolicy), /"cidr":"0\.0\.0\.0\/0"/);
  const controlGateway = resource(resources, "Deployment", "team-a-codeops-control-gateway");
  const environment = new Map(
    controlGateway.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(environment.has("CODEOPS_RUNTIME_EGRESS_PROXY_ORIGIN"), false);
  assert.equal(environment.has("CODEOPS_RUNTIME_EGRESS_PROXY_SERVICE_NAME"), false);
});

test("changes the immutable runtime image ConfigMap identity with image content", () => {
  const baseline = render();
  const changed = render([
    "--set",
    `runtime.workerImage.digest=sha256:${"7".repeat(64)}`,
  ]);
  const runtimeName = (resources) =>
    resources.find(
      ({ kind, metadata }) =>
        kind === "ConfigMap" &&
        metadata?.labels?.["app.kubernetes.io/component"] === "runtime",
    ).metadata.name;
  assert.notEqual(runtimeName(baseline), runtimeName(changed));
});

test("keeps the Agents UI private", () => {
  const resources = render();
  assert.equal(resources.some(({ kind }) => kind === "Ingress"), false);

  const deployment = resource(
    resources,
    "Deployment",
    "team-a-codeops-agents-ui",
  );
  const env = new Map(
    deployment.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(
    env.get("CODEOPS_SESSION_BROKER_URL").value,
    "http://team-a-codeops-session-control-gateway.engineering.svc.cluster.local:8080",
  );
  assert.equal(
    env.get("CODEOPS_SESSION_NOTIFICATION_URL").value,
    "http://team-a-codeops-control-gateway.engineering.svc.cluster.local:8080",
  );

  const gateway = resource(resources, "Deployment", "team-a-codeops-session-gateway");
  const gatewaySource = JSON.stringify(gateway);
  assert.match(gatewaySource, /initialization-token/);
  assert.match(gatewaySource, /team-a-codeops-model-proxy-credentials/);
  assert.match(gatewaySource, /signing-key/);
  assert.doesNotMatch(gatewaySource, /model-proxy-signing-key/);
  assert.doesNotMatch(gatewaySource, /github-steering-token/);
  assert.match(gatewaySource, /team-a-codeops-repository-steering/);
  assert.match(gatewaySource, /CODEOPS_REPOSITORY_STEERING_REGISTRY_FILE/);
  const gatewayEnv = new Map(
    gateway.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(
    gatewayEnv.get("CODEOPS_GITHUB_READ_PROVIDER_ORIGIN").value,
    "http://team-a-codeops-control-gateway:8080",
  );
  assert.equal(
    gatewayEnv.get("CODEOPS_GITHUB_READ_PROVIDER_TOKEN_FILE").value,
    "/var/run/secrets/team-a-codeops-github-reads/repository-head-token",
  );
  assert.equal(
    gatewayEnv.get("CODEOPS_GITHUB_MUTATION_PROVIDER_ORIGIN").value,
    "http://team-a-codeops-control-gateway:8080",
  );
  assert.equal(
    gatewayEnv.get("CODEOPS_GITHUB_MUTATION_PROVIDER_TOKEN_FILE").value,
    "/var/run/secrets/team-a-codeops-github-mutations/github-mutation-token",
  );
  const githubReadAuthority = gateway.spec.template.spec.volumes.find(
    ({ name }) => name === "github-read-provider-auth",
  );
  assert.equal(
    githubReadAuthority.secret.secretName,
    "team-a-codeops-control-gateway-secrets",
  );
  assert.deepEqual(githubReadAuthority.secret.items, [
    { key: "repository-head-token", path: "repository-head-token" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(githubReadAuthority),
    /repository-registry|read-token|write-token/,
  );
  const githubMutationAuthority = gateway.spec.template.spec.volumes.find(
    ({ name }) => name === "github-mutation-provider-auth",
  );
  assert.equal(
    githubMutationAuthority.secret.secretName,
    "team-a-codeops-control-gateway-secrets",
  );
  assert.deepEqual(githubMutationAuthority.secret.items, [
    { key: "github-mutation-token", path: "github-mutation-token" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(githubMutationAuthority),
    /repository-registry|github-read-token|github-write-token/,
  );
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
    ["team-a-example-repository-context", "team-a-codeops-context"],
  );
  assert.equal(
    contexts.projected.sources.every(
      ({ secret }) =>
        secret.items.length === 7 &&
        secret.items.every(({ path }) =>
          path.startsWith(
            secret.name.includes("example-repository")
              ? "example-repository/"
              : "codeops/",
          ),
        ),
    ),
    true,
  );
});

test("routes repository-qualified Plane webhooks through the stable controller Service", () => {
  const ingressSets = [
    "githubController.webhookIngress.enabled=true",
    "githubController.webhookIngress.className=nginx",
    "githubController.webhookIngress.host=work.example.com",
    "githubController.webhookIngress.tlsSecretName=codeops-plane-webhook-tls",
    "githubController.webhookIngress.annotations.cert-manager\\.io/cluster-issuer=letsencrypt",
    "githubController.webhookIngress.repositories[0]=anulman/renoconcierge",
    "githubController.webhookIngress.repositories[1]=anulman/codeops",
  ];
  const resources = render(ingressSets.flatMap((value) => ["--set", value]));
  const ingress = resource(
    resources,
    "Ingress",
    "team-a-codeops-github-controller",
  );
  assert.equal(ingress.metadata.namespace, "engineering");
  assert.equal(
    ingress.metadata.annotations["cert-manager.io/cluster-issuer"],
    "letsencrypt",
  );
  assert.equal(ingress.spec.ingressClassName, "nginx");
  assert.deepEqual(ingress.spec.tls, [{
    hosts: ["work.example.com"],
    secretName: "codeops-plane-webhook-tls",
  }]);
  assert.deepEqual(
    ingress.spec.rules[0].http.paths.map((path) => ({
      path: path.path,
      pathType: path.pathType,
      service: path.backend.service.name,
      port: path.backend.service.port.name,
    })),
    [
      {
        path: "/webhooks/plane/anulman/renoconcierge",
        pathType: "Exact",
        service: "team-a-codeops-github-controller",
        port: "http",
      },
      {
        path: "/webhooks/plane/anulman/codeops",
        pathType: "Exact",
        service: "team-a-codeops-github-controller",
        port: "http",
      },
    ],
  );
  assert.equal(
    ingress.spec.rules[0].http.paths.some(
      ({ path }) => path === "/webhooks/plane",
    ),
    false,
  );

  const upgraded = renderUpgrade([
    ...ingressSets.flatMap((value) => ["--set", value]),
    "--set",
    `githubController.image.digest=sha256:${"7".repeat(64)}`,
  ]);
  assert.deepEqual(
    resource(upgraded, "Ingress", "team-a-codeops-github-controller"),
    ingress,
  );
});

test("defaults to deny and opens only explicit component paths", () => {
  const resources = render();
  const policies = resources.filter(({ kind }) => kind === "NetworkPolicy");
  assert.equal(policies.length, 16);
  const deny = resource(resources, "NetworkPolicy", "team-a-codeops-default-deny");
  assert.deepEqual(deny.spec.podSelector, {
    matchLabels: { "app.kubernetes.io/part-of": "codeops" },
  });
  assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"]);

  for (const [name, appName] of [
    ["managed-temporal", "temporal"],
    ["managed-jetstream", "jetstream"],
    ["managed-plane", "plane"],
  ]) {
    const dependency = resource(resources, "NetworkPolicy", `team-a-codeops-${name}`);
    assert.equal(dependency.spec.podSelector.matchLabels["app.kubernetes.io/instance"], "team-a");
    assert.equal(dependency.spec.podSelector.matchLabels["app.kubernetes.io/name"], appName);
    assert.deepEqual(dependency.spec.policyTypes, ["Ingress", "Egress"]);
    assert.ok(dependency.spec.ingress.some(({ from }) =>
      from.some(({ podSelector }) => JSON.stringify(podSelector) === "{}")
    ));
  }
  const planeBucket = resource(
    resources,
    "NetworkPolicy",
    "team-a-codeops-managed-plane-minio-bucket",
  );
  assert.equal(
    planeBucket.spec.podSelector.matchLabels["batch.kubernetes.io/job-name"],
    "team-a-minio-bucket-1",
  );
  assert.deepEqual(planeBucket.spec.ingress, []);
  assert.deepEqual(
    planeBucket.spec.egress.flatMap(({ ports = [] }) => ports.map(({ port }) => port)).sort(),
    [53, 53, 9000],
  );

  const postgresql = resource(resources, "NetworkPolicy", "team-a-codeops-postgresql");
  assert.deepEqual(postgresql.spec.egress, []);
  const postgresqlComponents = postgresql.spec.ingress[0].from
    .find(({ podSelector }) => podSelector?.matchLabels?.["app.kubernetes.io/part-of"] === "codeops")
    .podSelector.matchExpressions
    .find(({ key }) => key === "app.kubernetes.io/component").values;
  assert.deepEqual(postgresqlComponents.sort(), [
    "control-gateway",
    "lifecycle-relay",
    "model-proxy",
    "runtime",
    "session-gateway",
    "session-migration",
  ]);
  const gateway = resource(resources, "NetworkPolicy", "team-a-codeops-session-gateway");
  assert.ok(JSON.stringify(gateway).includes("github-controller"));
  assert.ok(JSON.stringify(gateway).includes("team-a-codeops-postgresql"));
  assert.ok(JSON.stringify(gateway.spec.egress).includes("team-a-codeops-control-gateway"));
  const controller = resource(resources, "NetworkPolicy", "team-a-codeops-github-controller");
  assert.ok(JSON.stringify(controller).includes("team-a-codeops-session-gateway"));
  assert.ok(JSON.stringify(controller).includes("team-a-codeops-control-gateway"));
  assert.ok(JSON.stringify(controller).includes("team-a-codeops-model-proxy"));
  const controlGateway = resource(resources, "NetworkPolicy", "team-a-codeops-control-gateway");
  assert.ok(JSON.stringify(controlGateway).includes("10.43.0.1/32"));
  assert.ok(JSON.stringify(controlGateway.spec.ingress).includes("orchestrator"));
  assert.ok(JSON.stringify(controlGateway.spec.ingress).includes("session-gateway"));
  const orchestrator = resource(resources, "NetworkPolicy", "team-a-codeops-orchestrator");
  assert.ok(JSON.stringify(orchestrator).includes("team-a-codeops-control-gateway"));
  const migration = resource(resources, "NetworkPolicy", "team-a-codeops-session-migration");
  assert.ok(JSON.stringify(migration).includes("team-a-codeops-postgresql"));
  assert.ok(JSON.stringify(migration).includes("10.43.0.1/32"));
  assert.deepEqual(
    migration.spec.egress.flatMap(({ ports = [] }) => ports.map(({ protocol, port }) => `${protocol}:${port}`)).sort(),
    ["TCP:443", "TCP:53", "TCP:5432", "TCP:6443", "UDP:53"],
  );
  const modelProxy = resource(resources, "NetworkPolicy", "team-a-codeops-model-proxy");
  assert.deepEqual(modelProxy.spec.ingress[0].from, [
    {
      podSelector: {
        matchExpressions: [
          {
            key: "app.kubernetes.io/component",
            operator: "In",
            values: ["github-controller", "runtime"],
          },
        ],
      },
    },
    {
      podSelector: {
        matchLabels: { "app.kubernetes.io/name": "codeops-agent" },
      },
    },
  ]);
  assert.deepEqual(
    modelProxy.spec.ingress.flatMap(({ ports = [] }) => ports.map(({ protocol, port }) => `${protocol}:${port}`)),
    ["TCP:8080"],
  );
  assert.deepEqual(
    modelProxy.spec.egress.flatMap(({ ports = [] }) => ports.map(({ protocol, port }) => `${protocol}:${port}`)).sort(),
    ["TCP:443", "TCP:53", "TCP:5432", "UDP:53"],
  );
  const materializer = resource(
    resources,
    "NetworkPolicy",
    "team-a-codeops-workspace-materializer",
  );
  assert.deepEqual(materializer.spec.ingress, []);
  assert.deepEqual(materializer.spec.podSelector, {
    matchLabels: { "app.kubernetes.io/component": "workspace-materializer" },
  });
  assert.deepEqual(
    materializer.spec.egress.flatMap(({ ports = [] }) =>
      ports.map(({ protocol, port }) => `${protocol}:${port}`)
    ).sort(),
    ["TCP:443", "TCP:53", "UDP:53"],
  );
  const relay = resource(resources, "NetworkPolicy", "team-a-codeops-lifecycle-relay");
  assert.match(JSON.stringify(relay), /TCP.*4222/);
});

test("creates a complete one-repository quickstart from one values file", () => {
  const resources = renderQuickstart();
  const secrets = resources.filter(({ kind }) => kind === "Secret");
  assert.equal(secrets.length, 19); // Owner and staged application credentials.
  assert.equal(
    secrets.every((secret) => secret.metadata.annotations["helm.sh/resource-policy"] === "keep"),
    true,
  );

  const postgresql = resource(resources, "Secret", "codeops-postgres");
  assert.match(postgresql.stringData.password, /^[A-Za-z0-9]{48}$/);
  const session = resource(resources, "Secret", "codeops-session-secrets");
  assert.match(
    session.stringData["database-url"],
    /^postgresql:\/\/codeops_app:[A-Za-z0-9]{48}@codeops-database:5432\/agents$/,
  );
  assert.match(
    session.stringData["runtime-database-url"],
    /^postgresql:\/\/codeops_runtime_receipts:[A-Za-z0-9]{48}@codeops-database:5432\/agents$/,
  );
  assert.equal(session.stringData["runtime-database-role"], "codeops_runtime_receipts");
  const migrationSecret = resource(resources, "Secret", "codeops-migration-secrets");
  assert.match(migrationSecret.stringData["database-url"], /^postgresql:\/\/agents:[A-Za-z0-9]{48}@codeops-database:5432\/agents$/);
  assert.notEqual(migrationSecret.stringData["database-url"], session.stringData["database-url"]);
  const modelProxy = resource(resources, "Secret", "codeops-model-proxy-credentials");
  assert.match(
    modelProxy.stringData["database-password"],
    /^[A-Za-z0-9]{48}$/,
  );
  assert.equal(
    modelProxy.stringData["database-url"],
    `postgresql://codeops_model_proxy:${modelProxy.stringData["database-password"]}@codeops-database:5432/agents`,
  );
  assert.equal(modelProxy.stringData["database-role"], "codeops_model_proxy");
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
  const controllerSecrets = resource(resources, "Secret", "codeops-controller-secrets");
  assert.match(controllerSecrets.stringData["work-item-mutation-token"], /^[A-Za-z0-9]{48}$/);
  assert.notEqual(
    controllerSecrets.stringData["work-item-mutation-token"],
    controllerSecrets.stringData["research-projection-token"],
  );
  const controlGatewaySecrets = resource(
    resources,
    "Secret",
    "codeops-control-gateway-secrets",
  );
  assert.match(
    controlGatewaySecrets.stringData["github-mutation-token"],
    /^[A-Za-z0-9]{48}$/,
  );
  assert.notEqual(
    controlGatewaySecrets.stringData["github-mutation-token"],
    controlGatewaySecrets.stringData["repository-head-token"],
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
    ["--namespace", "engineering", "--set", "gateway.image.digest=latest"],
    ["--namespace", "engineering", "--set", "githubController.controlPlaneSha=main"],
    ["--namespace", "engineering", "--set", "githubController.repositoryAuthoritySecretName=Invalid_Name"],
    ["--namespace", "engineering", "--set", "gateway.repositorySteeringRegistrySecretName=Invalid_Name"],
    ["--namespace", "engineering", "--set", "controlGateway.kubernetesApiCidrs={}"],
    ["--namespace", "engineering", "--set", "controlGateway.kubernetesApiCidrs[0]=not-a-cidr"],
    ["--namespace", "engineering", "--set", "temporal.address=missing-port"],
    ["--namespace", "engineering", "--set", "githubController.repositoryContexts[0].directory=../escape"],
    ["--namespace", "engineering", "--set", "agentsUi.authentication.fixedPrincipal=", "--set", "agentsUi.authentication.principalHeader="],
    ["--namespace", "engineering", "--set", "agentsUi.authentication.principalHeader=x-authenticated-principal"],
    ["--namespace", "engineering", "--set", "agentsUi.authentication.fixedPrincipal=", "--set", "agentsUi.authentication.principalHeader=X-Authenticated-Principal"],
    ["--namespace", "engineering", "--set", "githubController.webhookIngress.enabled=true"],
    ["--namespace", "engineering", "--set", "githubController.webhookIngress.enabled=true", "--set", "githubController.webhookIngress.host=*.example.com"],
    ["--namespace", "engineering", "--set", "githubController.webhookIngress.enabled=true", "--set", "githubController.webhookIngress.host=work.example.com", "--set", "githubController.webhookIngress.tlsSecretName=Invalid_Name", "--set", "githubController.webhookIngress.repositories[0]=anulman/renoconcierge"],
    ["--namespace", "engineering", "--set", "plane.adapter.enabled=false", "--set", "githubController.webhookIngress.enabled=true", "--set", "githubController.webhookIngress.host=work.example.com", "--set", "githubController.webhookIngress.tlsSecretName=codeops-webhook-tls", "--set", "githubController.webhookIngress.repositories[0]=anulman/renoconcierge"],
    ["--namespace", "engineering", "--set", "githubController.webhookIngress.enabled=true", "--set", "githubController.webhookIngress.host=work.example.com", "--set", "githubController.webhookIngress.tlsSecretName=codeops-webhook-tls", "--set", "githubController.webhookIngress.repositories[0]=not-a-repository"],
    ["--namespace", "engineering", "--set", "githubController.webhookIngress.enabled=true", "--set", "githubController.webhookIngress.host=work.example.com", "--set", "githubController.webhookIngress.tlsSecretName=codeops-webhook-tls", "--set", "githubController.webhookIngress.repositories[0]=anulman/renoconcierge", "--set", "githubController.webhookIngress.repositories[1]=anulman/renoconcierge"],
  ];
  for (const extra of cases) {
    assert.throws(() => helm([
      "template", "team-a", chart,
      ...digestSets.flatMap((value) => ["--set", value]),
      ...extra,
    ]));
  }
  for (const extra of [
    ["--set", "runtimeEgressProxy.enabled=true"],
    [
      "--set", "runtimeEgressProxy.enabled=true",
      "--set", `runtimeEgressProxy.image.digest=sha256:${"6".repeat(64)}`,
      "--set", "runtimeEgressProxy.allowedDomains[0]=*",
    ],
  ]) {
    assert.throws(() => helm([
      "template", "team-a", chart,
      "--namespace", "engineering",
      ...digestSets.flatMap((value) => ["--set", value]),
      ...extra,
    ]));
  }
});

test("rejects a shared migration and application secret", () => {
  assert.throws(() => render(["--set", "migration.secretName=team-a-codeops-session-secrets"]), /must be separate/);
});


test("stages new quickstart credentials before migration without rotating old runtime secrets", () => {
  const resources = renderQuickstart(["--is-upgrade"]);
  const migration = resource(resources, "Job", "codeops-session-migrate");
  const owner = resource(resources, "Secret", "codeops-migration-secrets");
  const application = resource(resources, "Secret", "codeops-application-database");
  const gateway = resource(resources, "Secret", "codeops-session-secrets");
  for (const secret of [owner, application]) {
    assert.equal(secret.metadata.annotations["helm.sh/hook"], "pre-install,pre-upgrade");
    assert.ok(Number(secret.metadata.annotations["helm.sh/hook-weight"]) <
      Number(migration.metadata.annotations["helm.sh/hook-weight"]));
    assert.equal(secret.metadata.annotations["helm.sh/hook-delete-policy"], "before-hook-creation");
  }
  assert.equal(gateway.metadata.annotations["helm.sh/hook"], undefined);
  assert.equal(application.stringData["database-url"], gateway.stringData["database-url"]);
  assert.notEqual(owner.stringData["database-url"], application.stringData["database-url"]);
  const volumes = migration.spec.template.spec.volumes;
  assert.equal(volumes.find(v => v.name === "application-authority").secret.secretName,
    application.metadata.name);
  assert.equal(volumes.find(v => v.name === "secrets").secret.items.some(i => i.key === "database-url"), false);
  // The only pre-upgrade Secrets must be new names. In particular no
  // credential consumed by the prior gateway is a pre-upgrade replacement.
  const staged = resources.filter(r => r.kind === "Secret" && r.metadata.annotations?.["helm.sh/hook"]?.includes("pre-upgrade"));
  assert.deepEqual(staged.map(r => r.metadata.name).sort(), ["codeops-application-database", "codeops-migration-secrets"]);
  for (const name of ["codeops-session-secrets", "codeops-lifecycle-relay", "codeops-model-proxy-credentials", "codeops-postgres"]) {
    assert.equal(resource(resources, "Secret", name).metadata.annotations["helm.sh/hook"], undefined);
  }
});


test("protected external database egress selects namespace and database Pods together", () => {
  const resources = render(["--set", "profile=custom", "--set", "postgresql.deployment=external",
    "--set", "postgresql.external.host=codeops-database.codeops-database-owner.svc",
    "--set", "postgresql.external.namespace=codeops-database-owner",
    "--set-string", "postgresql.external.podSelector.fixture-db=true"]);
  const policies = resources.filter(r => r.kind === "NetworkPolicy");
  const targets = policies.flatMap(p => (p.spec.egress ?? []).flatMap(e => e.to ?? []))
    .filter(t => t.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "codeops-database-owner");
  assert.ok(targets.length > 0);
  for (const target of targets) assert.deepEqual(target.podSelector, {matchLabels: {"fixture-db": "true"}});
});
