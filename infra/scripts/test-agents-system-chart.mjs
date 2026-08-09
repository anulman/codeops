import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = "infra/charts/agents-system";
const digestSets = [
  "missionControl.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "gateway.image.digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "githubController.image.digest=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "githubController.controlPlaneSha=1111111111111111111111111111111111111111",
  "postgresql.image.digest=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "runtime.workerImage.digest=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "runtime.agentImage.digest=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "missionControl.access.issuer=https://renoconcierge.cloudflareaccess.com",
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
    "template", "mission-control", chart,
    "--namespace", "agents-system",
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

test("renders one independent agents-system package with immutable images", () => {
  const resources = render();
  assert.ok(resources.length >= 21);
  for (const candidate of resources) {
    assert.equal(candidate.metadata?.namespace, "agents-system");
    assert.notEqual(candidate.kind, "Secret");
  }

  const images = resources.flatMap((candidate) => [
    ...(candidate.spec?.template?.spec?.containers ?? []),
    ...(candidate.spec?.template?.spec?.initContainers ?? []),
  ]).map((container) => container.image).filter(Boolean);
  assert.equal(images.length, 4);
  assert.ok(images.every((image) => /@sha256:[0-9a-f]{64}$/.test(image)));

  resource(resources, "StatefulSet", "agents-system-postgresql");
  resource(resources, "Deployment", "agents-system-session-gateway");
  resource(resources, "Deployment", "agents-system-github-controller");
  resource(resources, "Deployment", "agents-system-mission-control");
  resource(resources, "PersistentVolumeClaim", "agents-system-codex-auth");
  resource(resources, "PersistentVolumeClaim", "agents-system-controller-state");
  resource(resources, "ConfigMap", "agents-system-runtime-images");
  for (const name of ["mission-control", "session-gateway", "github-controller", "runtime"]) {
    const account = resource(resources, "ServiceAccount", `agents-system-${name}`);
    assert.equal(account.automountServiceAccountToken, false);
  }
});

test("exposes only Mission Control and requires signed Access configuration", () => {
  const resources = render();
  const ingresses = resources.filter(({ kind }) => kind === "Ingress");
  assert.equal(ingresses.length, 1);
  assert.deepEqual(ingresses[0].spec.rules.map(({ host }) => host), [
    "agents.renoconcierge.ca",
  ]);
  assert.deepEqual(ingresses[0].spec.rules[0].http.paths.map(({ path }) => path), [
    "/webhooks/github",
    "/webhooks/plane",
    "/",
  ]);

  const deployment = resource(
    resources,
    "Deployment",
    "agents-system-mission-control",
  );
  const env = new Map(
    deployment.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(env.get("AGENTS_UI_ACCESS_REQUIRED").value, "true");
  assert.equal(
    env.get("AGENTS_UI_ACCESS_ISSUER").value,
    "https://renoconcierge.cloudflareaccess.com",
  );
  assert.equal(
    env.get("AGENTS_UI_ACCESS_AUDIENCE").valueFrom.secretKeyRef.name,
    "agents-system-access",
  );
  assert.equal(
    env.get("AGENTS_UI_ACCESS_ALLOWED_EMAILS_FILE").value,
    "/var/run/secrets/agents-system-access/allowed-emails",
  );
  assert.equal(JSON.stringify(deployment).includes("cf-access-authenticated-user-email"), false);

  const controller = resource(
    resources,
    "Deployment",
    "agents-system-github-controller",
  );
  const controllerEnv = new Map(
    controller.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry]),
  );
  assert.equal(
    controllerEnv.get("CODEOPS_GITHUB_SESSION_STEERING_ORIGIN").value,
    "http://agents-session-control-gateway:8080",
  );
  assert.equal(
    controllerEnv.get("CODEOPS_GITHUB_WEBHOOK_SECRET_FILE").value,
    "/var/run/secrets/agents-system-controller/github-webhook-secret",
  );
});

test("defaults to deny and opens only explicit component paths", () => {
  const resources = render();
  const policies = resources.filter(({ kind }) => kind === "NetworkPolicy");
  assert.equal(policies.length, 6);
  const deny = resource(resources, "NetworkPolicy", "agents-system-default-deny");
  assert.deepEqual(deny.spec.podSelector, {});
  assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"]);

  const postgresql = resource(resources, "NetworkPolicy", "agents-system-postgresql");
  assert.deepEqual(postgresql.spec.egress, []);
  const gateway = resource(resources, "NetworkPolicy", "agents-system-session-gateway");
  assert.ok(JSON.stringify(gateway).includes("github-controller"));
  assert.ok(JSON.stringify(gateway).includes("agents-system-postgresql"));
  const controller = resource(resources, "NetworkPolicy", "agents-system-github-controller");
  assert.ok(JSON.stringify(controller).includes("agents-system-session-gateway"));
});

test("fails closed on the wrong namespace, host, issuer, or mutable image", () => {
  const cases = [
    ["--namespace", "renoconcierge"],
    ["--namespace", "agents-system", "--set", "ingress.host=other.example.com"],
    ["--namespace", "agents-system", "--set", "missionControl.access.issuer=https://example.com"],
    ["--namespace", "agents-system", "--set", "gateway.image.digest=latest"],
  ];
  for (const extra of cases) {
    assert.throws(() => helm([
      "template", "mission-control", chart,
      ...digestSets.flatMap((value) => ["--set", value]),
      ...extra,
    ]));
  }
});
