import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertWorkspaceResources,
  buildWorkspaceResources,
} from "../dist/workspace-resources.js";

const sha = "a".repeat(40);
const image = `ghcr.io/anulman/codeops/agent@sha256:${"b".repeat(64)}`;

function config(sources = []) {
  return {
    namespace: "agents-system",
    launchId: "launch-0123456789abcdef01234567",
    principalId: "anulman@gmail.com",
    requestDigest: `sha256:${"c".repeat(64)}`,
    sessionId: "ses_0123456789abcdef01234567",
    workflowId: "workspace-launch",
    runId: "launch-0123456789abcdef01234567",
    leaseId: "11111111-1111-4111-8111-111111111111",
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
  assert.equal(materializer.spec.template.spec.containers[0].name, "workspace-builder");
  assert.equal(JSON.stringify(runtime).includes("https://github.com/"), false);
  assert.equal(JSON.stringify(runtime).includes("read-token-codeops"), false);
  assert.match(JSON.stringify(runtime), /ephemeral-storage/);
});

test("puts exact source authority only in the init-only immutable Secret", () => {
  const resources = buildWorkspaceResources(config([
    { catalogKey: "renoconcierge", repository: "anulman/RenoConcierge" },
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
