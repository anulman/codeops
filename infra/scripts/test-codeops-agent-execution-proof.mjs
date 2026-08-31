import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_EXECUTION_POD_SCRIPT,
  buildAgentExecutionProofResources,
  resolveAgentExecutionIdentity,
  validateAgentExecutionProof,
} from "./codeops-agent-execution-proof.mjs";

const sourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const agentImage = `ghcr.io/anulman/codeops/agent@${digest}`;

function manifest() {
  return {
    version: "codeops.release-images/v1",
    sourceSha,
    images: { agent: { repository: "ghcr.io/anulman/codeops/agent", digest, immutableRef: agentImage } },
  };
}

function succeededPod() {
  return {
    metadata: {
      namespace: "proof-system",
      labels: { "app.kubernetes.io/instance": "codeops-agent-execution-proof" },
    },
    spec: {
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{
        image: agentImage,
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
      }],
    },
    status: {
      phase: "Succeeded",
      containerStatuses: [{
        imageID: `ghcr.io/anulman/codeops/agent@sha256:${"c".repeat(64)}`,
        state: { terminated: { exitCode: 0 } },
      }],
    },
  };
}

test("renders a provider-free Agent proof with the production security boundary", () => {
  assert.deepEqual(resolveAgentExecutionIdentity(manifest()), { sourceSha, agentImage });
  const resources = buildAgentExecutionProofResources({
    namespace: "proof-system",
    name: "codeops-agent-execution-proof",
    agentImage,
  });
  const configMap = resources.items.find(({ kind }) => kind === "ConfigMap");
  const policy = resources.items.find(({ kind }) => kind === "NetworkPolicy");
  const job = resources.items.find(({ kind }) => kind === "Job");
  const pod = job.spec.template.spec;
  const container = pod.containers[0];

  assert.equal(configMap.data["proof.mjs"], AGENT_EXECUTION_POD_SCRIPT);
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.equal("ingress" in policy.spec, false);
  assert.equal("egress" in policy.spec, false);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, "RuntimeDefault");
  assert.equal(container.image, agentImage);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.deepEqual(
    container.volumeMounts.find(({ name }) => name === "codex-home"),
    { name: "codex-home", mountPath: "/var/lib/codeops-agent/codex-home" },
  );
  assert.deepEqual(
    pod.volumes.find(({ name }) => name === "codex-home"),
    { name: "codex-home", emptyDir: {} },
  );
  assert.match(AGENT_EXECUTION_POD_SCRIPT, /CODEX_HOME: "\/var\/lib\/codeops-agent\/codex-home"/);
  assert.doesNotMatch(AGENT_EXECUTION_POD_SCRIPT, /CODEX_HOME: "\/tmp/);
  assert.match(AGENT_EXECUTION_POD_SCRIPT, /durable SQLite state/);
  assert.match(AGENT_EXECUTION_POD_SCRIPT, /INITIAL_AGENT_MODE: "agent-full-access"/);
  assert.match(AGENT_EXECUTION_POD_SCRIPT, /DEFAULT_AUTH_REQUEST: '\{"methodId":"api-key"\}'/);
  assert.match(AGENT_EXECUTION_POD_SCRIPT, /CODEX_API_KEY: "provider-free-proof-key"/);
  assert.match(AGENT_EXECUTION_POD_SCRIPT, /OPENAI_BASE_URL: "http:\/\/127\.0\.0\.1:9\/v1"/);
  assert.match(AGENT_EXECUTION_POD_SCRIPT, /providerDelivery: false/);
  assert.doesNotMatch(AGENT_EXECUTION_POD_SCRIPT, /session\.prompt/);
});

test("binds successful proof output to the exact released Agent image", () => {
  const evidence = validateAgentExecutionProof({
    pod: succeededPod(),
    output: {
      version: "codeops.agent-execution-proof/v1",
      mode: "agent-full-access",
      sqliteState: "initialized",
      shellStatus: "passed",
      providerDelivery: false,
    },
    namespace: "proof-system",
    name: "codeops-agent-execution-proof",
    agentImage,
    sourceSha,
  });
  assert.equal(evidence.sourceSha, sourceSha);
  assert.equal(evidence.agentImage, agentImage);
  assert.equal(evidence.mode, "agent-full-access");
  assert.equal(evidence.sqliteState, "initialized");
  assert.equal(evidence.shellStatus, "passed");
  assert.equal(evidence.providerDelivery, false);
  assert.equal(evidence.networkPolicy, "deny-all");
  assert.equal(evidence.cleanupStatus, "pending");
});

test("rejects release identity, security, mode, shell, and provider-delivery drift", () => {
  const badManifest = manifest();
  badManifest.images.agent.immutableRef = "ghcr.io/anulman/codeops/agent:mutable";
  assert.throws(() => resolveAgentExecutionIdentity(badManifest), /image identity/);

  for (const mutate of [
    (pod, output) => { pod.spec.automountServiceAccountToken = true; },
    (pod, output) => { pod.spec.containers[0].securityContext.readOnlyRootFilesystem = false; },
    (pod, output) => { output.mode = "agent"; },
    (pod, output) => { output.shellStatus = "failed"; },
    (pod, output) => { output.providerDelivery = true; },
  ]) {
    const pod = succeededPod();
    const output = {
      version: "codeops.agent-execution-proof/v1",
      mode: "agent-full-access",
      sqliteState: "initialized",
      shellStatus: "passed",
      providerDelivery: false,
    };
    mutate(pod, output);
    assert.throws(() => validateAgentExecutionProof({
      pod, output, namespace: "proof-system", name: "codeops-agent-execution-proof", agentImage, sourceSha,
    }), /security boundary|output is invalid/);
  }
});
