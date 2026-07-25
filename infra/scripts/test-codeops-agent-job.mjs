import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderAgentJobManifest } from "./codeops-agent-job-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agent-job-template.yaml", import.meta.url),
  "utf8",
);
const input = {
  runId: "routing-matrix-2fdebb4c",
  baseSha: "a".repeat(40),
  prompt: "Inspect the routing matrix and propose a bounded implementation plan.",
  repository: "https://github.com/anulman/renoconcierge",
  agentDigest: `sha256:${"b".repeat(64)}`,
  sessionGatewayDigest: `sha256:${"c".repeat(64)}`,
};

function resources(rendered = renderAgentJobManifest(template, input)) {
  return parseAllDocuments(rendered).map((document) => document.toJS());
}

test("renders one tokenless, bounded, ephemeral Agent Job", () => {
  const rendered = renderAgentJobManifest(template, input);
  const manifests = resources(rendered);
  assert.deepEqual(
    manifests.map((resource) => resource.kind),
    ["ServiceAccount", "Job", "NetworkPolicy"],
  );
  const job = manifests[1];
  const pod = job.spec.template.spec;
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 3600);
  assert.equal(job.spec.ttlSecondsAfterFinished, 3600);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.deepEqual(pod.imagePullSecrets, [{ name: "ghcr-renoconcierge" }]);
  assert.deepEqual(pod.nodeSelector, { "renoconcierge.ca/codeops": "true" });
  assert.equal(pod.volumes.every((volume) => volume.emptyDir), true);
  assert.equal(rendered.includes("hostPath"), false);
  assert.equal(rendered.includes("PersistentVolumeClaim"), false);
});

test("keeps ACP pod-local and exposes no Service or Ingress", () => {
  const manifests = resources();
  const pod = manifests[1].spec.template.spec;
  assert.deepEqual(
    pod.containers.map((container) => container.name),
    ["session-gateway", "coding-agent"],
  );
  assert.equal(
    pod.containers[0].env.find((entry) => entry.name === "CODEOPS_ACP_SOCKET")
      .value,
    "/run/codeops/agent.sock",
  );
  assert.equal(pod.containers[1].args, undefined);
  assert.equal(
    manifests.some((resource) => ["Service", "Ingress"].includes(resource.kind)),
    false,
  );
});

test("uses an exact source SHA and only immutable images", () => {
  const rendered = renderAgentJobManifest(template, input);
  assert.equal(rendered.includes(input.baseSha), true);
  assert.equal(rendered.includes(input.repository), true);
  const pod = resources(rendered)[1].spec.template.spec;
  const images = [...pod.initContainers, ...pod.containers].map(
    (container) => container.image,
  );
  assert.deepEqual(images, [
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-agent@${input.agentDigest}`,
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-session-gateway@${input.sessionGatewayDigest}`,
    `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-agent@${input.agentDigest}`,
  ]);
});

test("scopes repository-read and model secrets to separate containers", () => {
  const job = resources()[1];
  const builder = job.spec.template.spec.initContainers[0];
  const agent = job.spec.template.spec.containers.find(
    (container) => container.name === "coding-agent",
  );
  const gateway = job.spec.template.spec.containers.find(
    (container) => container.name === "session-gateway",
  );
  const secret = agent.env.find(
    (entry) => entry.name === "CODEX_API_KEY",
  );
  assert.deepEqual(secret.valueFrom.secretKeyRef, {
    name: "codeops-run-routing-matrix-2fdebb4c",
    key: "model-api-key",
  });
  assert.deepEqual(
    builder.env.find(
      (entry) => entry.name === "CODEOPS_REPOSITORY_READ_TOKEN",
    ).valueFrom.secretKeyRef,
    {
      name: "codeops-run-routing-matrix-2fdebb4c",
      key: "repository-read-token",
    },
  );
  assert.equal(
    agent.env.some((entry) => entry.name === "CODEOPS_REPOSITORY_READ_TOKEN"),
    false,
  );
  assert.equal(
    gateway.env.some((entry) => entry.name === "DEFAULT_AUTH_REQUEST"),
    false,
  );
  assert.equal(
    agent.env.find((entry) => entry.name === "DEFAULT_AUTH_REQUEST").value,
    '{"methodId":"api-key"}',
  );
  assert.equal(JSON.stringify(job).includes("value: sk-"), false);
});

test("denies ingress and private-network egress while allowing DNS and public HTTPS", () => {
  const policy = resources()[2];
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(policy.spec.ingress, []);
  const publicHttps = policy.spec.egress.find((rule) =>
    rule.ports?.some((port) => port.port === 443),
  );
  assert.equal(publicHttps.to[0].ipBlock.cidr, "0.0.0.0/0");
  assert.ok(publicHttps.to[0].ipBlock.except.includes("10.0.0.0/8"));
  assert.ok(publicHttps.to[0].ipBlock.except.includes("172.16.0.0/12"));
  assert.ok(publicHttps.to[0].ipBlock.except.includes("192.168.0.0/16"));
});

test("fails closed on malformed identity, source, image, or template drift", () => {
  for (const patch of [
    { runId: "UPPER" },
    { runId: "-bad" },
    { baseSha: "abc" },
    { repository: "git@github.com:anulman/renoconcierge.git" },
    { prompt: "" },
    { agentDigest: "latest" },
    { sessionGatewayDigest: `sha256:${"C".repeat(64)}` },
  ]) {
    assert.throws(() => renderAgentJobManifest(template, { ...input, ...patch }));
  }
  assert.throws(() =>
    renderAgentJobManifest(
      template.replace("kind: NetworkPolicy", "kind: Service"),
      input,
    ),
  );
  assert.throws(() =>
    renderAgentJobManifest(
      template.replace("emptyDir: {}", "hostPath: { path: / }"),
      input,
    ),
  );
  assert.throws(() =>
    renderAgentJobManifest(
      template.replace(
        "automountServiceAccountToken: false",
        "automountServiceAccountToken: true",
      ),
      input,
    ),
  );
});
