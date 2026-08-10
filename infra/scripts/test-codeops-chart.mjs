import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = "infra/charts/codeops";
const digestSets = [
  "agentsUi.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gateway.image.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "githubController.image.digest=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "githubController.controlPlaneSha=1111111111111111111111111111111111111111",
  "postgresql.image.digest=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "runtime.workerImage.digest=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "runtime.agentImage.digest=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "modelProxy.image.digest=sha256:9999999999999999999999999999999999999999999999999999999999999999",
  "agentsUi.access.issuer=https://example.cloudflareaccess.com",
  "ingress.host=codeops.example.net",
  "agentsUi.access.secretName=team-a-codeops-access",
  "gateway.secretName=team-a-codeops-session-secrets",
  "modelProxy.secretName=team-a-codeops-model-proxy-credentials",
  "githubController.configSecretName=team-a-codeops-controller-config",
  "githubController.secretName=team-a-codeops-controller-secrets",
  "githubController.repositoryWebhookRegistrySecretName=team-a-codeops-repository-webhooks",
  "postgresql.secretName=team-a-codeops-postgres",
];

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

function resource(resources, kind, name) {
  const match = resources.find(
    (candidate) => candidate.kind === kind && candidate.metadata?.name === name,
  );
  assert.ok(match, `${kind}/${name} must render`);
  return match;
}

test("renders one portable CodeOps package with immutable images", () => {
  const resources = render();
  assert.ok(resources.length >= 21);
  for (const candidate of resources) {
    assert.equal(candidate.metadata?.namespace, "engineering");
    assert.notEqual(candidate.kind, "Secret");
  }

  const images = resources.flatMap((candidate) => [
    ...(candidate.spec?.template?.spec?.containers ?? []),
    ...(candidate.spec?.template?.spec?.initContainers ?? []),
  ]).map((container) => container.image).filter(Boolean);
  assert.equal(images.length, 6);
  assert.ok(images.every((image) => /@sha256:[0-9a-f]{64}$/.test(image)));

  resource(resources, "StatefulSet", "team-a-codeops-postgresql");
  resource(resources, "Deployment", "team-a-codeops-session-gateway");
  resource(resources, "Deployment", "team-a-codeops-github-controller");
  resource(resources, "Deployment", "team-a-codeops-agents-ui");
  const modelProxy = resource(resources, "Deployment", "team-a-codeops-model-proxy");
  const proxySource = JSON.stringify(modelProxy);
  assert.match(proxySource, /team-a-codeops-model-proxy-credentials/);
  assert.match(proxySource, /openai-api-key/);
  assert.match(proxySource, /signing-key/);
  const migration = resource(resources, "Job", "team-a-codeops-session-migrate");
  assert.equal(migration.metadata.annotations["helm.sh/hook"], "pre-upgrade");
  assert.equal(migration.metadata.annotations["helm.sh/hook-delete-policy"], "before-hook-creation");
  assert.equal(migration.spec.backoffLimit, 0);
  assert.equal(migration.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(migration.spec.template.spec.containers[0].command, [
    "node",
    "services/codeops-control-gateway/dist/session-migrate-main.js",
  ]);
  assert.deepEqual(
    migration.spec.template.spec.volumes.find(({ name }) => name === "secrets").secret.items.map(({ key }) => key).sort(),
    ["database-url", "runtime-database-role", "runtime-database-url"],
  );
  assert.equal(resources.some(({ metadata }) => metadata?.name === "team-a-codeops-codex-auth"), false);
  resource(resources, "PersistentVolumeClaim", "team-a-codeops-controller-state");
  resource(resources, "ConfigMap", "team-a-codeops-runtime-images");
  for (const name of ["agents-ui", "session-gateway", "github-controller", "runtime", "model-proxy"]) {
    const account = resource(resources, "ServiceAccount", `team-a-codeops-${name}`);
    assert.equal(account.automountServiceAccountToken, false);
  }
});

test("exposes only the Agents UI and requires signed Access configuration", () => {
  const resources = render();
  const ingresses = resources.filter(({ kind }) => kind === "Ingress");
  assert.equal(ingresses.length, 1);
  assert.deepEqual(ingresses[0].spec.rules.map(({ host }) => host), [
    "codeops.example.net",
  ]);
  assert.deepEqual(ingresses[0].spec.rules[0].http.paths.map(({ path }) => path), [
    "/webhooks/github",
    "/webhooks/plane",
    "/",
  ]);

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
    controllerEnv.get("CODEOPS_REPOSITORY_REGISTRY_FILE").value,
    "/var/run/secrets/team-a-codeops-repositories/registry.json",
  );
  assert.equal(controllerEnv.has("CODEOPS_GITHUB_WEBHOOK_SECRET_FILE"), false);
  const registryVolume = controller.spec.template.spec.volumes.find(
    ({ name }) => name === "repository-registry",
  );
  assert.equal(
    registryVolume.secret.secretName,
    "team-a-codeops-repository-webhooks",
  );
  assert.equal(
    JSON.stringify(controller).includes("github-webhook-secret"),
    false,
  );
});

test("defaults to deny and opens only explicit component paths", () => {
  const resources = render();
  const policies = resources.filter(({ kind }) => kind === "NetworkPolicy");
  assert.equal(policies.length, 8);
  const deny = resource(resources, "NetworkPolicy", "team-a-codeops-default-deny");
  assert.deepEqual(deny.spec.podSelector, {});
  assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"]);

  const postgresql = resource(resources, "NetworkPolicy", "team-a-codeops-postgresql");
  assert.deepEqual(postgresql.spec.egress, []);
  const gateway = resource(resources, "NetworkPolicy", "team-a-codeops-session-gateway");
  assert.ok(JSON.stringify(gateway).includes("github-controller"));
  assert.ok(JSON.stringify(gateway).includes("team-a-codeops-postgresql"));
  const controller = resource(resources, "NetworkPolicy", "team-a-codeops-github-controller");
  assert.ok(JSON.stringify(controller).includes("team-a-codeops-session-gateway"));
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
    ["--namespace", "engineering", "--set", "githubController.repositoryWebhookRegistrySecretName=Invalid_Name"],
  ];
  for (const extra of cases) {
    assert.throws(() => helm([
      "template", "team-a", chart,
      ...digestSets.flatMap((value) => ["--set", value]),
      ...extra,
    ]));
  }
});
