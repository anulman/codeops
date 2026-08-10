import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseDocument } from "yaml";
import { renderAgentsSystemRootSession } from "./agents-system-root-session-render.mjs";

const template = await readFile(new URL("../k8s/codeops/agents-system-root-session-template.yaml", import.meta.url), "utf8");
const input = {
  agentDigest: `sha256:${"a".repeat(64)}`,
  workerDigest: `sha256:${"b".repeat(64)}`,
  baseSha: "c".repeat(40),
  branch: "feat/agents-ui",
  leaseId: "11111111-1111-4111-8111-111111111111",
  runId: "agents-control-plane-1",
  sessionId: "ses_agents_control_plane_1",
  sessionSuffix: "agents-control-plane-1",
  workflowId: "agents-control-plane-1",
};

function render(patch = {}) {
  return parseDocument(renderAgentsSystemRootSession(template, { ...input, ...patch })).toJS();
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
      `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-agent@${input.agentDigest}`,
      `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-session-runtime-worker@${input.workerDigest}`,
      `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-agent@${input.agentDigest}`,
    ],
  );
});

test("gives the root Job only source, initialization, worker, and receipt authority", () => {
  const source = JSON.stringify(render());
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
  ]) {
    assert.throws(() => render(patch));
  }
});
