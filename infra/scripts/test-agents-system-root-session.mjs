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
  ownerPrincipalId: "codeops:agents-ui",
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
      `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
      `ghcr.io/anulman/codeops/session-runtime-worker@${input.workerDigest}`,
      `ghcr.io/anulman/codeops/agent@${input.agentDigest}`,
    ],
  );
  const pod = job.spec.template.spec;
  const builder = pod.initContainers.find(({ name }) => name === "workspace-builder");
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
