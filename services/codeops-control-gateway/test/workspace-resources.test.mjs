import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWorkspaceResources,
  buildWorkspaceResources,
} from "../dist/workspace-resources.js";

const sha = "a".repeat(40);
const image = `ghcr.io/anulman/codeops/agent@sha256:${"b".repeat(64)}`;
const contextAttachment = {
  attachmentId: "context-estimator-notes",
  name: "estimator-notes.txt",
  mimeType: "text/plain",
  sizeBytes: 24,
  digest: `sha256:${"d".repeat(64)}`,
};

function config(sources = []) {
  return {
    namespace: "agents-system",
    launchId: "launch-0123456789abcdef01234567",
    principalId: "anulman@gmail.com",
    requestDigest: `sha256:${"c".repeat(64)}`,
    sessionId: "ses_0123456789abcdef01234567",
    workflowId: "workspace-launch",
    runId: "launch-0123456789abcdef01234567",
    displayName: "Investigate the estimator",
    leaseId: "11111111-1111-4111-8111-111111111111",
    policy: {
      version: "codeops.session-policy/v1",
      mode: "implement",
      workspaceAccess: "bounded-writes",
      modelCalls: "allowed",
      modelPolicy: {
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      },
    },
    contextAttachments: [contextAttachment],
    workspace: {
      version: "codeops.workspace/v1",
      sources: sources.map(({ catalogKey, repository }) => ({
        catalogKey,
        repository,
        checkoutPath: `sources/${catalogKey}`,
        requestedRef: "main",
        resolvedSha: sha,
      })),
      scratchPath: "scratch",
    },
    sources: sources.map(({ catalogKey, repository }) => ({
      catalogKey,
      repositoryUrl: `https://github.com/${repository}.git`,
      readToken: `read-token-${catalogKey}-0123456789`,
    })),
    agentImage: image,
    runtimeWorkerImage: image.replace("/agent@", "/session-runtime-worker@"),
    imagePullSecrets: [{ name: "codeops-registry" }],
    nodeSelector: { "codeops.example/codeops": "true" },
    runtimeServiceAccountName: "agents-system-runtime",
    sessionSecretsName: "agents-system-session-secrets",
    sessionGatewayOrigin: "http://agents-system-session-control-gateway:8080",
    modelProxyOrigin: "http://agents-system-model-proxy:8080",
    workspaceStorageSize: "10Gi",
  };
}

test("builds isolated materializer and runtime Jobs on bounded persistent storage", () => {
  const resources = buildWorkspaceResources(config());
  assert.doesNotThrow(() => assertWorkspaceResources(resources));
  const secret = resources[0];
  const storage = resources[1];
  const materializer = resources[2];
  const runtime = resources[3];
  assert.equal(secret.immutable, true);
  assert.equal(storage.spec.resources.requests.storage, "10Gi");
  assert.equal(materializer.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(runtime.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(runtime.metadata.labels["codeops.example/run-id"], config().runId);
  assert.equal(
    runtime.spec.template.metadata.labels["codeops.example/run-id"],
    config().runId,
  );
  assert.equal(materializer.spec.template.spec.containers[0].name, "workspace-builder");
  assert.equal(JSON.stringify(runtime).includes("https://github.com/"), false);
  assert.equal(JSON.stringify(runtime).includes("read-token-codeops"), false);
  assert.match(JSON.stringify(runtime), /ephemeral-storage/);
  assert.deepEqual(
    runtime.spec.template.spec.volumes.find(({ name }) => name === "temp")?.emptyDir,
    { sizeLimit: "2Gi" },
  );
  const runtimeEnvironment = runtime.spec.template.spec.containers[0].env;
  assert.equal(
    runtimeEnvironment.find((entry) => entry.name === "CODEOPS_SESSION_DISPLAY_NAME")?.value,
    "Investigate the estimator",
  );
  assert.deepEqual(
    JSON.parse(runtimeEnvironment.find((entry) => entry.name === "CODEOPS_SESSION_CONTEXT_ATTACHMENTS_JSON")?.value),
    [contextAttachment],
  );
  assert.equal(JSON.stringify(resources).includes("RXhhY3QgY29udGV4dCBwYXlsb2Fk"), false);
});

test("binds workspace mounts and Codex configuration to the immutable session policy", () => {
  const implementRuntime = buildWorkspaceResources(config())[3];
  for (const container of implementRuntime.spec.template.spec.containers) {
    assert.equal(
      container.volumeMounts.find((mount) => mount.name === "workspace")?.readOnly,
      false,
    );
  }
  const implementAgent = implementRuntime.spec.template.spec.containers[1];
  assert.equal(
    implementAgent.env.find((entry) => entry.name === "INITIAL_AGENT_MODE")?.value,
    "agent-full-access",
  );
  const implementCodexConfig = JSON.parse(
    implementAgent.env.find((entry) => entry.name === "CODEX_CONFIG")?.value,
  );
  assert.equal(implementCodexConfig.model, "gpt-5.6-sol");
  assert.equal(implementCodexConfig.model_reasoning_effort, "medium");

  const review = config();
  review.policy = {
    version: "codeops.session-policy/v1",
    mode: "review",
    workspaceAccess: "read-only",
    modelCalls: "allowed",
    modelPolicy: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    },
  };
  const reviewRuntime = buildWorkspaceResources(review)[3];
  for (const container of reviewRuntime.spec.template.spec.containers) {
    assert.equal(
      container.volumeMounts.find((mount) => mount.name === "workspace")?.readOnly,
      true,
    );
  }
  const reviewAgent = reviewRuntime.spec.template.spec.containers[1];
  assert.equal(
    reviewAgent.env.find((entry) => entry.name === "INITIAL_AGENT_MODE")?.value,
    "agent-full-access",
  );
  const reviewCodexConfig = JSON.parse(
    reviewAgent.env.find((entry) => entry.name === "CODEX_CONFIG")?.value,
  );
  assert.equal(reviewCodexConfig.model, "gpt-5.6-sol");
  assert.equal(reviewCodexConfig.model_reasoning_effort, "high");
});

test("routes runtime HTTP traffic through only the exact internal egress proxy", () => {
  const proxied = config();
  proxied.runtimeEgressProxyOrigin = "http://agents-system-runtime-egress-proxy:3128";
  proxied.runtimeEgressProxyServiceName = "agents-system-runtime-egress-proxy";
  const runtime = buildWorkspaceResources(proxied)[3];
  for (const container of runtime.spec.template.spec.containers) {
    const env = Object.fromEntries(container.env.map(({ name, value }) => [name, value]));
    assert.equal(env.HTTP_PROXY, proxied.runtimeEgressProxyOrigin);
    assert.equal(env.HTTPS_PROXY, proxied.runtimeEgressProxyOrigin);
    assert.equal(env.http_proxy, proxied.runtimeEgressProxyOrigin);
    assert.equal(env.https_proxy, proxied.runtimeEgressProxyOrigin);
    assert.equal(env.NO_PROXY, env.no_proxy);
    assert.match(env.NO_PROXY, /agents-system-session-control-gateway/);
    assert.match(env.NO_PROXY, /agents-system-model-proxy/);
  }
  assert.throws(
    () => buildWorkspaceResources({
      ...proxied,
      runtimeEgressProxyOrigin: "http://attacker.example:3128",
    }),
    /exact internal service/,
  );
  assert.throws(
    () => buildWorkspaceResources({
      ...config(),
      runtimeEgressProxyOrigin: proxied.runtimeEgressProxyOrigin,
    }),
    /authority is incomplete/,
  );
});

test("puts exact source authority only in the init-only immutable Secret", () => {
  const resources = buildWorkspaceResources(config([
    { catalogKey: "example-app", repository: "example-org/Example-App" },
    { catalogKey: "codeops", repository: "anulman/CodeOps" },
  ]));
  assert.doesNotThrow(() => assertWorkspaceResources(resources));
  const sources = JSON.parse(Buffer.from(resources[0].data["sources.json"], "base64").toString("utf8"));
  assert.equal(sources.sources.length, 2);
  assert.equal(sources.sources[0].resolvedSha, sha);
  const materializer = resources[2];
  const runtime = resources[3];
  assert.equal(JSON.stringify(materializer).includes(sources.sources[0].readToken), false);
  assert.equal(JSON.stringify(runtime).includes(sources.sources[0].readToken), false);
  assert.equal(runtime.spec.template.spec.containers[0].volumeMounts.some((mount) => mount.name === "source"), false);
  assert.equal(runtime.spec.template.spec.containers[1].volumeMounts.some((mount) => mount.name === "source"), false);
  assert.match(resources[0].metadata.name, /-source-[0-9a-f]{10}$/);
});

test("rejects authority drift and mutable runtime images", () => {
  assert.throws(() => buildWorkspaceResources({ ...config([{ catalogKey: "codeops", repository: "anulman/CodeOps" }]), sources: [] }), /match the manifest/);
  assert.throws(() => buildWorkspaceResources({ ...config(), agentImage: "ghcr.io/anulman/codeops/agent:latest" }), /immutable digests/);
  assert.throws(() => buildWorkspaceResources({ ...config(), displayName: " padded " }), /display name/);
});

test("binds the immutable Secret name to principal, request, workspace, and authority", () => {
  const base = config([{ catalogKey: "codeops", repository: "anulman/CodeOps" }]);
  const name = buildWorkspaceResources(base)[0].metadata.name;
  assert.notEqual(
    buildWorkspaceResources({ ...base, principalId: "other@example.com" })[0].metadata.name,
    name,
  );
  assert.notEqual(
    buildWorkspaceResources({ ...base, requestDigest: `sha256:${"d".repeat(64)}` })[0].metadata.name,
    name,
  );
  assert.notEqual(
    buildWorkspaceResources({
      ...base,
      sources: base.sources.map((source) => ({ ...source, readToken: `${source.readToken}-rotated` })),
    })[0].metadata.name,
    name,
  );
});
