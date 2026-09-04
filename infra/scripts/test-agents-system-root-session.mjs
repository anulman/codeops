import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDocument } from "yaml";
import { renderAgentsSystemRootSession } from "./agents-system-root-session-render.mjs";

const template = await readFile(new URL("../k8s/codeops/agents-system-root-session-template.yaml", import.meta.url), "utf8");
const capabilities = ["acp"];
const capabilityDigest = `sha256:${createHash("sha256").update(JSON.stringify(capabilities)).digest("hex")}`;
const input = {
  agentDigest: `sha256:${"a".repeat(64)}`,
  workerDigest: `sha256:${"b".repeat(64)}`,
  baseSha: "c".repeat(40),
  branch: "feat/agents-ui",
  leaseId: "11111111-1111-4111-8111-111111111111",
  runId: "agents-control-plane-1",
  runtimeProfileId: "standard-v1",
  runtimeReleaseDigest: `sha256:${"7".repeat(64)}`,
  runtimeCapabilityDigest: capabilityDigest,
  runtimeProfile: {
    version: "codeops.runtime-profile/v1",
    profileId: "standard-v1",
    releaseDigest: `sha256:${"7".repeat(64)}`,
    capabilities,
    capabilityDigest,
    resources: { cpuMillis: 3000, memoryMiB: 7168, ephemeralStorageMiB: 5120 },
    authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
    compatibilityPolicyRevision: "compatible-substitution-v1",
    images: {
      agent: `ghcr.io/anulman/codeops/agent@sha256:${"a".repeat(64)}`,
      worker: `ghcr.io/anulman/codeops/session-runtime-worker@sha256:${"b".repeat(64)}`,
      sessionGateway: `ghcr.io/anulman/codeops/session-gateway@sha256:${"c".repeat(64)}`,
    },
  },
  sessionId: "ses_agents_control_plane_1",
  ownerPrincipalId: "codeops:agents-ui",
  sessionSuffix: "agents-control-plane-1",
  workflowId: "agents-control-plane-1",
};

function render(patch = {}) {
  return parseDocument(renderAgentsSystemRootSession(template, { ...input, ...patch })).toJS();
}

function effectiveResources(pod, key) {
  const quantity = (value) => value.endsWith("m")
    ? Number(value.slice(0, -1))
    : Number(value.slice(0, -2)) * (value.endsWith("Gi") ? 1_024 : 1);
  const names = ["cpu", "memory", "ephemeral-storage"];
  const application = Object.fromEntries(names.map((name) => [
    name,
    pod.containers.reduce((total, container) => total + quantity(container.resources[key][name]), 0),
  ]));
  return Object.fromEntries(names.map((name) => [
    name,
    Math.max(application[name], ...pod.initContainers.map((container) =>
      quantity(container.resources[key][name]))),
  ]));
}

test("renders one trusted idempotent root-session runtime Job", () => {
  const job = render();
  assert.equal(job.kind, "Job");
  assert.equal(job.metadata.namespace, "agents-system");
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.template.spec.serviceAccountName, "agents-system-runtime");
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(
    [...job.spec.template.spec.initContainers, ...job.spec.template.spec.containers].map(({ image }) => image),
    [
      `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
      `ghcr.io/anulman/codeops/session-runtime-worker@${input.workerDigest}`,
      `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
    ],
  );
  const pod = job.spec.template.spec;
  const builder = pod.initContainers.find(({ name }) => name === "workspace-builder");
  const worker = pod.containers.find(({ name }) => name === "runtime-worker");
  const runtimeIdentity = Object.fromEntries(worker.env.map((entry) => [entry.name, entry.value]));
  assert.equal(runtimeIdentity.CODEOPS_RUNTIME_PROFILE_ID, input.runtimeProfileId);
  assert.equal(runtimeIdentity.CODEOPS_RUNTIME_RELEASE_DIGEST, input.runtimeReleaseDigest);
  assert.equal(runtimeIdentity.CODEOPS_RUNTIME_CAPABILITY_DIGEST, input.runtimeCapabilityDigest);
  assert.equal(job.metadata.annotations["codeops.example/runtime-release-digest"], input.runtimeReleaseDigest);
  const agent = pod.containers.find(({ name }) => name === "coding-agent");
  assert.match(builder.args[0], /mkdir -p \/workspace\/\.codeops\/codex-home/);
  assert.equal(
    agent.env.find(({ name }) => name === "CODEX_HOME")?.value,
    "/var/lib/codeops-agent/codex-home",
  );
  assert.deepEqual(
    agent.volumeMounts.find(({ mountPath }) => mountPath === "/var/lib/codeops-agent/codex-home"),
    {
      name: "workspace",
      mountPath: "/var/lib/codeops-agent/codex-home",
      subPath: ".codeops/codex-home",
      readOnly: false,
    },
  );
});

test("gives the root Job only source, initialization, worker, and receipt authority", () => {
  const job = render();
  const source = JSON.stringify(job);
  assert.match(source, /agents-system-runtime-source/);
  assert.match(source, /initialization-token/);
  assert.match(source, /runtime-worker-token/);
  assert.match(source, /runtime-database-url/);
  assert.doesNotMatch(source, /key":"database-url"/);
  assert.doesNotMatch(source, /write-token|github-steering-token|plane-api-key|kubeconfig/i);
  assert.doesNotMatch(source, /codex-auth|chat-gpt|openai-api-key/i);
  assert.match(source, /model-proxy-token/);
  assert.match(source, /agents-system-model-proxy:8080/);
  assert.match(source, /approvals_reviewer/);
  assert.match(source, /auto_review/);
  assert.match(source, /web_search/);
  assert.match(source, /cached/);
  const agent = job.spec.template.spec.containers.find(({ name }) => name === "coding-agent");
  const env = Object.fromEntries(agent.env.map(({ name, value }) => [name, value]));
  assert.equal(env.MODEL_PROVIDER, JSON.parse(env.CODEX_CONFIG).model_provider);
  assert.equal(env.MODEL_PROVIDER, "codeops_proxy");
});

test("renders exact profile resource bounds including ephemeral storage", () => {
  const job = render();
  const pod = job.spec.template.spec;
  const builder = pod.initContainers.find(({ name }) => name === "workspace-builder");
  const containers = [...pod.initContainers, ...pod.containers];
  for (const container of containers) {
    for (const key of ["cpu", "memory", "ephemeral-storage"]) {
      assert.ok(container.resources.requests[key]);
      assert.ok(container.resources.limits[key]);
    }
  }
  assert.deepEqual(
    pod.containers.find(({ name }) => name === "coding-agent").resources.limits,
    { cpu: "2000m", memory: "6144Mi", "ephemeral-storage": "4096Mi" },
  );
  assert.deepEqual(effectiveResources(pod, "requests"), {
    cpu: 600,
    memory: 1_280,
    "ephemeral-storage": 1_280,
  });
  assert.deepEqual(effectiveResources(pod, "limits"), {
    cpu: input.runtimeProfile.resources.cpuMillis,
    memory: input.runtimeProfile.resources.memoryMiB,
    "ephemeral-storage": input.runtimeProfile.resources.ephemeralStorageMiB,
  });
  assert.equal(builder.resources.requests["ephemeral-storage"], "1280Mi");
  assert.equal(builder.resources.limits["ephemeral-storage"], "5120Mi");
  assert.equal(pod.volumes.find(({ name }) => name === "workspace").emptyDir.sizeLimit, "5120Mi");
  assert.equal(pod.volumes.find(({ name }) => name === "temp").emptyDir.sizeLimit, "2Gi");
});

test("rejects incomplete, unbounded, and restricted runtime profiles", () => {
  assert.throws(() => render({ runtimeProfile: { ...input.runtimeProfile, extra: true } }), /complete trusted schema/);
  assert.throws(() => render({ runtimeProfile: {
    ...input.runtimeProfile,
    resources: { cpuMillis: 1200, memoryMiB: 1800, ephemeralStorageMiB: 1800 },
  } }), /cannot bound coding-agent/);
  for (const authority of [
    { workspaceAccess: "read-only" },
    { publicNetwork: false },
    { brokeredProviderEffects: false },
  ]) {
    assert.throws(() => render({ runtimeProfile: {
      ...input.runtimeProfile,
      authority: { ...input.runtimeProfile.authority, ...authority },
    } }), /does not render authority denied/);
  }
});

test("rejects mutable images and unsafe root identities", () => {
  for (const patch of [
    { agentDigest: "latest" },
    { workerDigest: `sha256:${"A".repeat(64)}` },
    { baseSha: "main" },
    { branch: "feat//unsafe" },
    { leaseId: "not-a-uuid" },
    { sessionId: "unsafe:value" },
    { sessionSuffix: "UPPER" },
    { runtimeProfileId: " unsafe" },
    { runtimeReleaseDigest: `sha256:${"A".repeat(64)}` },
    { agentDigest: `sha256:${"d".repeat(64)}` },
  ]) {
    assert.throws(() => render(patch));
  }
  for (const drifted of [
    template.replace('            - { name: MODEL_PROVIDER, value: codeops_proxy }\n', ""),
    template.replace("MODEL_PROVIDER, value: codeops_proxy", "MODEL_PROVIDER, value: openai"),
    template.replace("CODEOPS_MODEL_PROXY_ORIGIN, value: http://agents-system-model-proxy:8080", "CODEOPS_MODEL_PROXY_ORIGIN, value: http://other-proxy:8080"),
    template.replace('"model_provider":"codeops_proxy"', '"model_provider":"openai"'),
    template.replace('"base_url":"http://agents-system-model-proxy:8080/v1"', '"base_url":"http://other-proxy:8080/v1"'),
    template.replace('"env_key":"CODEX_API_KEY"', '"env_key":"OPENAI_API_KEY"'),
    template.replace('"wire_api":"responses"', '"wire_api":"chat"'),
    template.replace("/run/codeops/model-proxy-token", "/run/codeops/other-token"),
    template.replace(
      "            - { name: CODEOPS_MODEL_PROXY_TOKEN_FILE, value: /run/codeops/model-proxy-token }",
      "            - { name: CODEX_API_KEY, value: literal-reusable-key }",
    ),
    template.replace(
      "            - { name: CODEOPS_MODEL_PROXY_TOKEN_FILE, value: /run/codeops/model-proxy-token }",
      "            - { name: OPENAI_API_KEY, value: '' }\n            - { name: CODEOPS_MODEL_PROXY_TOKEN_FILE, value: /run/codeops/model-proxy-token }",
    ),
    template.replace("name: session, emptyDir: { medium: Memory", "name: session, secret: { secretName: alternate }, unused: { medium: Memory"),
    template.replace("- { name: session, mountPath: /run/codeops }", "- { name: temp, mountPath: /run/codeops }"),
  ]) {
    assert.throws(() => renderAgentsSystemRootSession(drifted, input), /model proxy/);
  }
});
