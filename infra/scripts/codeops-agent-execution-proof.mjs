#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const AGENT_REPOSITORY = "ghcr.io/anulman/codeops/agent";
const PROOF_VERSION = "codeops.agent-execution-proof/v1";

export const AGENT_EXECUTION_POD_SCRIPT = String.raw`#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

const acp = await import("file:///opt/codeops-agent/node_modules/@agentclientprotocol/sdk/dist/acp.js");
await mkdir("/tmp/home", { recursive: true });
await mkdir("/tmp/codex", { recursive: true });

const child = spawn("/opt/codeops-agent/node_modules/.bin/codex-acp", [], {
  cwd: "/workspace",
  env: {
    ...process.env,
    CODEX_HOME: "/tmp/codex",
    CODEX_API_KEY: "provider-free-proof-key",
    DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}',
    HOME: "/tmp/home",
    INITIAL_AGENT_MODE: "agent-full-access",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });

try {
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const session = await acp.client({ name: "codeops-agent-execution-proof" })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .connectWith(stream, async (agent) => {
      await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "codeops-agent-execution-proof", version: "1" },
      });
      return agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
    });
  if (session?.modes?.currentModeId !== "agent-full-access") {
    throw new Error("ACP session did not select agent-full-access mode");
  }

  const shell = spawnSync(
    "/bin/sh",
    ["-c", "printf provider-free-shell-proof > /workspace/proof.txt"],
    { encoding: "utf8" },
  );
  if (shell.status !== 0) throw new Error("Agent container could not execute /bin/sh");
  if ((await readFile("/workspace/proof.txt", "utf8")) !== "provider-free-shell-proof") {
    throw new Error("Agent container shell evidence is invalid");
  }
  process.stdout.write(JSON.stringify({
    version: "${PROOF_VERSION}",
    mode: session.modes.currentModeId,
    shellStatus: "passed",
    providerDelivery: false,
  }) + "\n");
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(stderr ? detail + "; codex-acp: " + stderr : detail);
} finally {
  child.kill("SIGTERM");
}
`;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

export function resolveAgentExecutionIdentity(manifest) {
  object(manifest, "release manifest");
  if (manifest.version !== "codeops.release-images/v1" || !SHA.test(manifest.sourceSha ?? "")) {
    throw new Error("release manifest identity is invalid");
  }
  const agent = object(object(manifest.images, "release images").agent, "agent release image");
  if (
    agent.repository !== AGENT_REPOSITORY ||
    !DIGEST.test(agent.digest ?? "") ||
    agent.immutableRef !== `${AGENT_REPOSITORY}@${agent.digest}`
  ) {
    throw new Error("agent release image identity is invalid");
  }
  return { sourceSha: manifest.sourceSha, agentImage: agent.immutableRef };
}

export function buildAgentExecutionProofResources({ namespace, name, agentImage }) {
  if (!namespace || !name || !agentImage) throw new Error("proof resource identity is required");
  const labels = {
    "app.kubernetes.io/name": "codeops-agent-execution-proof",
    "app.kubernetes.io/instance": name,
  };
  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace, labels },
        data: { "proof.mjs": AGENT_EXECUTION_POD_SCRIPT },
      },
      {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name, namespace, labels },
        spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"] },
      },
      {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, namespace, labels },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: 120,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: { labels },
            spec: {
              automountServiceAccountToken: false,
              restartPolicy: "Never",
              nodeSelector: { "codeops.dev/operator": "true" },
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                fsGroup: 1000,
                seccompProfile: { type: "RuntimeDefault" },
              },
              containers: [{
                name: "proof",
                image: agentImage,
                imagePullPolicy: "IfNotPresent",
                command: ["node", "/proof/proof.mjs"],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [
                  { name: "proof", mountPath: "/proof", readOnly: true },
                  { name: "workspace", mountPath: "/workspace" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              }],
              volumes: [
                { name: "proof", configMap: { name, defaultMode: 0o444 } },
                { name: "workspace", emptyDir: {} },
                { name: "tmp", emptyDir: {} },
              ],
            },
          },
        },
      },
    ],
  };
}

export function validateAgentExecutionProof({ pod, output, namespace, name, agentImage, sourceSha }) {
  const spec = object(pod?.spec, "proof Pod spec");
  const status = object(pod?.status, "proof Pod status");
  const container = spec.containers?.[0];
  const containerStatus = status.containerStatuses?.[0];
  if (
    pod.metadata?.namespace !== namespace ||
    pod.metadata?.labels?.["app.kubernetes.io/instance"] !== name ||
    status.phase !== "Succeeded" ||
    spec.automountServiceAccountToken !== false ||
    spec.securityContext?.runAsNonRoot !== true ||
    spec.securityContext?.seccompProfile?.type !== "RuntimeDefault" ||
    container?.image !== agentImage ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    container?.securityContext?.capabilities?.drop?.join(",") !== "ALL" ||
    containerStatus?.state?.terminated?.exitCode !== 0
  ) {
    throw new Error("Agent execution proof Pod did not preserve the required security boundary");
  }
  if (
    output?.version !== PROOF_VERSION ||
    output.mode !== "agent-full-access" ||
    output.shellStatus !== "passed" ||
    output.providerDelivery !== false
  ) {
    throw new Error("Agent execution proof output is invalid");
  }
  return {
    version: PROOF_VERSION,
    sourceSha,
    agentImage,
    runtimeImageId: containerStatus.imageID,
    namespace,
    mode: output.mode,
    shellStatus: output.shellStatus,
    providerDelivery: false,
    networkPolicy: "deny-all",
    serviceAccountToken: false,
    seccompProfile: "RuntimeDefault",
    readOnlyRootFilesystem: true,
    droppedCapabilities: ["ALL"],
    cleanupStatus: "pending",
  };
}

function kubectl(args, options = {}) {
  return execFileSync("kubectl", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

export async function runAgentExecutionProof({ manifestPath, namespace, name, outputPath }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const identity = resolveAgentExecutionIdentity(manifest);
  const resources = buildAgentExecutionProofResources({ namespace, name, agentImage: identity.agentImage });
  let evidence;
  try {
    kubectl(["get", "namespace", namespace]);
    kubectl(["apply", "--filename", "-"], { input: `${JSON.stringify(resources)}\n` });
    kubectl(["wait", "--namespace", namespace, "--for=condition=complete", `job/${name}`, "--timeout=180s"]);
    const logs = kubectl(["logs", "--namespace", namespace, `job/${name}`]).trim().split("\n");
    const output = JSON.parse(logs.at(-1));
    const pods = JSON.parse(kubectl([
      "get", "pods", "--namespace", namespace,
      "--selector", `app.kubernetes.io/instance=${name}`,
      "--output", "json",
    ]));
    if (pods.items?.length !== 1) throw new Error("Agent execution proof expected exactly one Pod");
    evidence = validateAgentExecutionProof({
      pod: pods.items[0],
      output,
      namespace,
      name,
      agentImage: identity.agentImage,
      sourceSha: identity.sourceSha,
    });
  } catch (error) {
    try {
      const logs = kubectl(["logs", "--namespace", namespace, `job/${name}`]);
      process.stderr.write(logs);
    } catch {
      // The Job can fail before Kubernetes creates its Pod.
    }
    throw error;
  } finally {
    kubectl([
      "delete", "job,networkpolicy,configmap", name,
      "--namespace", namespace, "--ignore-not-found", "--wait=true", "--timeout=120s",
    ]);
  }
  const remaining = kubectl([
    "get", "job,networkpolicy,configmap", "--namespace", namespace,
    "--selector", `app.kubernetes.io/instance=${name}`,
    "--output", "name",
  ]).trim();
  if (remaining !== "") throw new Error("Agent execution proof resources were not removed");
  evidence.cleanupStatus = "passed";
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return evidence;
}

async function main() {
  const [manifestPath, outputPath, namespace = "proof-system", name = "codeops-agent-execution-proof"] = process.argv.slice(2);
  if (!manifestPath || !outputPath) {
    throw new Error("usage: codeops-agent-execution-proof <release-manifest.json> <output.json> [namespace] [name]");
  }
  process.stdout.write(`${JSON.stringify(await runAgentExecutionProof({ manifestPath, outputPath, namespace, name }))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
