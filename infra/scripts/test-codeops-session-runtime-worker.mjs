import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderSessionRuntimeWorkerManifest } from "./codeops-session-runtime-worker-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/session-runtime-worker-template.yaml", import.meta.url),
  "utf8",
);
const grants = await readFile(
  new URL("../k8s/codeops/trial0/session-runtime-worker-grants.sql", import.meta.url),
  "utf8",
);
const input = {
  agentDigest: `sha256:${"a".repeat(64)}`,
  workerDigest: `sha256:${"b".repeat(64)}`,
  baseSha: "c".repeat(40),
  branch: "feat/agents-ui",
  leaseId: "11111111-1111-4111-8111-111111111111",
  repository: "https://github.com/example-org/example-repository",
  runId: "video-proof-1",
  sessionId: "ses_video_1",
  ownerPrincipalId: "codeops:agents-ui",
  sessionSuffix: "video-1",
  workflowId: "video-proof-1",
};

function resources(source = template, values = input) {
  return parseAllDocuments(renderSessionRuntimeWorkerManifest(source, values))
    .map((document) => document.toJS());
}

test("packages one immutable non-retrying disposable session Job", () => {
  const values = resources();
  assert.deepEqual(values.map((value) => value.kind).sort(), [
    "Job", "NetworkPolicy", "ServiceAccount",
  ]);
  const job = values.find((value) => value.kind === "Job");
  const pod = job.spec.template.spec;
  const worker = pod.containers.find((container) => container.name === "runtime-worker");
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 3600);
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.terminationGracePeriodSeconds, 960);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(worker.readinessProbe.exec.command, [
    "node",
    "-e",
    "process.exit(require('node:fs').existsSync('/run/codeops/ready') ? 0 : 1)",
  ]);
  assert.deepEqual(
    [...pod.initContainers, ...pod.containers].map((container) => container.image),
    [
      `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
      `ghcr.io/anulman/codeops/session-runtime-worker@${input.workerDigest}`,
      `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
    ],
  );
});

test("mounts separate initialization, worker, and database authorities", () => {
  const pod = resources().find((value) => value.kind === "Job").spec.template.spec;
  const volumes = Object.fromEntries(pod.volumes.map((volume) => [volume.name, volume]));
  assert.equal(volumes["session-runtime-worker-auth"].secret.secretName, "codeops-session-runtime-worker-auth");
  assert.equal(volumes["session-job-initialization-auth"].secret.secretName, "codeops-session-job-initialization-auth");
  assert.equal(volumes["session-runtime-database"].secret.secretName, "codeops-session-runtime-worker-database");
  assert.equal(pod.volumes.filter((volume) => volume.persistentVolumeClaim).length, 0);
  assert.equal(JSON.stringify(pod).includes("codex-auth"), false);
  assert.equal(JSON.stringify(pod).includes("codeops-session-broker-database"), false);
});

test("shares only workspace and the pod-local ACP socket across runtime containers", () => {
  const pod = resources().find((value) => value.kind === "Job").spec.template.spec;
  const worker = pod.containers.find((container) => container.name === "runtime-worker");
  const agent = pod.containers.find((container) => container.name === "coding-agent");
  assert.equal(worker.env.find((entry) => entry.name === "CODEOPS_SESSION_RUNTIME_ACP_SOCKET_PATH").value, "/run/codeops/agent.sock");
  assert.equal(agent.env.find((entry) => entry.name === "CODEOPS_ACP_SOCKET").value, "/run/codeops/agent.sock");
  assert.ok(worker.volumeMounts.some((mount) => mount.name === "workspace"));
  assert.ok(agent.volumeMounts.some((mount) => mount.name === "workspace"));
  assert.ok(worker.volumeMounts.some((mount) => mount.name === "session"));
  assert.ok(agent.volumeMounts.some((mount) => mount.name === "session"));
});

test("denies ingress and permits only proof gateway, proof database, model proxy, DNS, and public HTTPS", () => {
  const policy = resources().find((value) => value.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(
    policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b)),
    [53, 53, 443, 5432, 8080, 8080],
  );
  assert.equal(policy.spec.egress[0].to[0].podSelector.matchLabels["app.kubernetes.io/name"], "codeops-control-gateway");
  assert.equal(policy.spec.egress[1].to[0].podSelector.matchLabels["app.kubernetes.io/name"], "codeops-session-proof-database");
  assert.equal(policy.spec.egress[2].to[0].podSelector.matchLabels["app.kubernetes.io/name"], "codeops-model-proxy");
});

test("rejects mutable images, unsafe identity, broad authority, and resource drift", () => {
  for (const patch of [
    { workerDigest: "latest" },
    { agentDigest: `sha256:${"A".repeat(64)}` },
    { baseSha: "abc" },
    { branch: "feat/unsafe\nvalue" },
    { branch: "feat//unsafe" },
    { repository: "https://github.com/other/repository" },
    { leaseId: "not-a-uuid" },
    { sessionId: `s${"x".repeat(63)}` },
    { sessionSuffix: "UPPER" },
    { sessionSuffix: `s${"x".repeat(40)}` },
  ]) {
    assert.throws(() => renderSessionRuntimeWorkerManifest(template, { ...input, ...patch }));
  }
  for (const drifted of [
    template.replace("kind: NetworkPolicy", "kind: ConfigMap"),
    template.replace("secretName: codeops-session-runtime-worker-database", "secretName: codeops-session-broker-database"),
    template.replace("backoffLimit: 0", "backoffLimit: 1"),
    template.replace("/run/codeops/ready", "/tmp/unbound-ready"),
    template.replace("app.kubernetes.io/name: codeops-control-gateway", "app.kubernetes.io/name: broad-gateway"),
    `${template}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: forbidden\n`,
  ]) {
    assert.throws(() => renderSessionRuntimeWorkerManifest(drifted, input));
  }
});

test("grants the worker only receipt read, reserve, and completion columns", () => {
  assert.match(grants, /ALTER ROLE :"worker_role"[\s\S]*NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION/);
  assert.match(grants, /REVOKE ALL ON ALL TABLES IN SCHEMA codeops/);
  assert.match(grants, /GRANT SELECT \(dispatch_id, dispatch_digest, status, result_json\)[\s\S]*session_runtime_execution_receipts/);
  assert.match(grants, /GRANT INSERT \(dispatch_id, dispatch_digest, status\)[\s\S]*session_runtime_execution_receipts/);
  assert.match(grants, /GRANT UPDATE \(status, result_json, completed_at\)[\s\S]*session_runtime_execution_receipts/);
  assert.doesNotMatch(grants, /session_runtime_outbox/);
  assert.doesNotMatch(grants, /\bDELETE\b|\bTRUNCATE\b|GRANT ALL|\bCREATE\b/);
});
