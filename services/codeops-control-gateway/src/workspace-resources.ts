import {
  workspaceManifestSchema,
  type WorkspaceManifest,
} from "@codeops/codeops-contracts";
import { createHash } from "node:crypto";

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const digestImage = /^.+@sha256:[0-9a-f]{64}$/;

export interface WorkspaceSourceAuthority {
  readonly catalogKey: string;
  readonly repositoryUrl: string;
  readonly readToken: string;
}

export interface WorkspaceResourceConfig {
  readonly namespace: string;
  readonly launchId: string;
  readonly principalId: string;
  readonly requestDigest: string;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly workspace: WorkspaceManifest;
  readonly sources: readonly WorkspaceSourceAuthority[];
  readonly agentImage: string;
  readonly runtimeWorkerImage: string;
  readonly imagePullSecrets: readonly { readonly name: string }[];
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly runtimeServiceAccountName: string;
  readonly sessionSecretsName: string;
  readonly sessionGatewayOrigin: string;
  readonly modelProxyOrigin: string;
  readonly workspaceStorageSize: string;
  readonly workspaceStorageClassName?: string;
}

function exactOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("workspace runtime gateway must be one credential-free HTTP origin");
  }
  return origin.origin;
}

const materializeScript = String.raw`
const { readFileSync, mkdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const input = JSON.parse(readFileSync("/var/run/codeops-source/sources.json", "utf8"));
const run = (args, env = process.env) => {
  const result = spawnSync("git", args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
mkdirSync("/workspace/sources", { recursive: true });
mkdirSync("/workspace/scratch", { recursive: true });
for (const source of input.sources) {
  const target = path.join("/workspace", source.checkoutPath);
  mkdirSync(target, { recursive: true });
  const auth = Buffer.from("x-access-token:" + source.readToken).toString("base64");
  const git = ["-c", "safe.directory=" + target, "-C", target];
  run([...git, "init"]);
  run([...git, "remote", "add", "origin", source.repositoryUrl]);
  run([...git, "-c", "http.extraHeader=Authorization: Basic " + auth, "fetch", "--depth=1", "origin", source.resolvedSha]);
  run([...git, "checkout", "--detach", "FETCH_HEAD"]);
  run([...git, "remote", "remove", "origin"]);
  const exact = spawnSync("git", [...git, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (exact.status !== 0 || exact.stdout.trim() !== source.resolvedSha) process.exit(1);
}
`;

export function buildWorkspaceResources(
  raw: WorkspaceResourceConfig,
): readonly Record<string, unknown>[] {
  const workspace = workspaceManifestSchema.parse(raw.workspace);
  const suffix = raw.launchId.replace(/^launch-/, "");
  if (!/^[0-9a-f]{24}$/.test(suffix)) throw new Error("workspace launch identity is invalid");
  for (const [name, value] of [
    ["namespace", raw.namespace],
    ["runtime ServiceAccount", raw.runtimeServiceAccountName],
    ["session Secret", raw.sessionSecretsName],
  ] as const) {
    if (!dnsLabel.test(value)) throw new Error(`workspace ${name} is invalid`);
  }
  if (!digestImage.test(raw.agentImage) || !digestImage.test(raw.runtimeWorkerImage)) {
    throw new Error("workspace runtime images must use immutable digests");
  }
  const authorities = new Map(raw.sources.map((source) => [source.catalogKey, source]));
  if (authorities.size !== raw.sources.length || authorities.size !== workspace.sources.length) {
    throw new Error("workspace source authorities must match the manifest exactly");
  }
  const sources = workspace.sources.map((source) => {
    const authority = authorities.get(source.catalogKey);
    if (
      authority === undefined ||
      authority.readToken.length < 16 ||
      authority.readToken.length > 4_096 ||
      /\s/.test(authority.readToken)
    ) {
      throw new Error("workspace source authority is missing or invalid");
    }
    const url = new URL(authority.repositoryUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) {
      throw new Error("workspace source must use an exact GitHub HTTPS URL");
    }
    return { ...source, repositoryUrl: authority.repositoryUrl, readToken: authority.readToken };
  });
  const name = `workspace-${suffix}`;
  const sourceIdentity = createHash("sha256").update(JSON.stringify({
    principalId: raw.principalId,
    requestDigest: raw.requestDigest,
    workspace,
    sources,
  })).digest("hex");
  const sourceSecretName = `${name}-source-${sourceIdentity.slice(0, 10)}`;
  if (!/^[1-9][0-9]*(?:Ei|Pi|Ti|Gi|Mi|Ki)$/.test(raw.workspaceStorageSize)) {
    throw new Error("workspace storage size must be one positive binary SI quantity");
  }
  if (
    raw.workspaceStorageClassName !== undefined &&
    !dnsLabel.test(raw.workspaceStorageClassName)
  ) {
    throw new Error("workspace storage class is invalid");
  }
  const commonLabels = {
    "app.kubernetes.io/part-of": "codeops",
    "codeops.example/launch-id": raw.launchId,
    "codeops.example/session-id": raw.sessionId,
  };
  const annotations = {
    "codeops.example/request-digest": raw.requestDigest,
    "codeops.example/principal-digest": createHash("sha256")
      .update(raw.principalId)
      .digest("hex"),
  };
  const securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  return [
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: sourceSecretName,
        namespace: raw.namespace,
        labels: {
          ...commonLabels,
          "app.kubernetes.io/name": "codeops-workspace-materializer",
          "app.kubernetes.io/component": "workspace-materializer",
          "codeops.example/resource-role": "source-authority",
        },
        annotations: {
          ...annotations,
          "codeops.example/source-identity": sourceIdentity,
        },
      },
      type: "Opaque",
      immutable: true,
      data: {
        "sources.json": Buffer.from(JSON.stringify({ sources })).toString("base64"),
      },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name,
        namespace: raw.namespace,
        labels: {
          ...commonLabels,
          "app.kubernetes.io/name": "codeops-workspace-storage",
          "app.kubernetes.io/component": "workspace-storage",
          "codeops.example/resource-role": "workspace-storage",
        },
        annotations,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        ...(raw.workspaceStorageClassName === undefined
          ? {}
          : { storageClassName: raw.workspaceStorageClassName }),
        resources: { requests: { storage: raw.workspaceStorageSize } },
      },
    },
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: `${name}-materialize`,
        namespace: raw.namespace,
        labels: {
          ...commonLabels,
          "app.kubernetes.io/name": "codeops-workspace-materializer",
          "app.kubernetes.io/component": "workspace-materializer",
          "codeops.example/resource-role": "source-materializer",
        },
        annotations,
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 1_800,
        ttlSecondsAfterFinished: 86_400,
        template: {
          metadata: {
            labels: {
              ...commonLabels,
              "app.kubernetes.io/name": "codeops-workspace-materializer",
              "app.kubernetes.io/component": "workspace-materializer",
            },
          },
          spec: {
            restartPolicy: "Never",
            terminationGracePeriodSeconds: 30,
            serviceAccountName: raw.runtimeServiceAccountName,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            imagePullSecrets: raw.imagePullSecrets,
            nodeSelector: raw.nodeSelector,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              fsGroupChangePolicy: "OnRootMismatch",
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [{
              name: "workspace-builder",
              image: raw.agentImage,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "-e", materializeScript],
              resources: {
                requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "256Mi" },
                limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "1Gi" },
              },
              securityContext,
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "source", mountPath: "/var/run/codeops-source", readOnly: true },
                { name: "temp", mountPath: "/tmp" },
              ],
            }],
            volumes: [
              { name: "workspace", persistentVolumeClaim: { claimName: name } },
              { name: "source", secret: { secretName: sourceSecretName, defaultMode: 256 } },
              { name: "temp", emptyDir: { sizeLimit: "256Mi" } },
            ],
          },
        },
      },
    },
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name,
        namespace: raw.namespace,
        labels: {
          ...commonLabels,
          "app.kubernetes.io/name": "codeops-workspace-runtime",
          "app.kubernetes.io/component": "runtime",
          "codeops.example/resource-role": "workspace-runtime",
        },
        annotations,
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 21_600,
        ttlSecondsAfterFinished: 86_400,
        template: {
          metadata: {
            labels: {
              ...commonLabels,
              "app.kubernetes.io/name": "codeops-workspace-runtime",
              "app.kubernetes.io/component": "runtime",
            },
          },
          spec: {
            restartPolicy: "Never",
            terminationGracePeriodSeconds: 960,
            serviceAccountName: raw.runtimeServiceAccountName,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            imagePullSecrets: raw.imagePullSecrets,
            nodeSelector: raw.nodeSelector,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              fsGroupChangePolicy: "OnRootMismatch",
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [{
              name: "runtime-worker",
              image: raw.runtimeWorkerImage,
              imagePullPolicy: "IfNotPresent",
              env: [
                { name: "CODEOPS_SESSION_RUNTIME_GATEWAY_ORIGIN", value: exactOrigin(raw.sessionGatewayOrigin) },
                { name: "CODEOPS_SESSION_RUNTIME_WORKER_TOKEN_FILE", value: "/var/run/codeops-session/runtime-worker-token" },
                { name: "CODEOPS_SESSION_JOB_INITIALIZATION_TOKEN_FILE", value: "/var/run/codeops-session/initialization-token" },
                { name: "CODEOPS_DATABASE_URL_FILE", value: "/var/run/codeops-session/database-url" },
                { name: "CODEOPS_SESSION_RUNTIME_ACP_SOCKET_PATH", value: "/run/codeops/agent.sock" },
                { name: "CODEOPS_SESSION_RUNTIME_WORKSPACE", value: "/workspace" },
                { name: "CODEOPS_SESSION_RUNTIME_ACP_STATE_PATH", value: "/var/lib/codeops-session/state.json" },
                { name: "CODEOPS_SESSION_WORKSPACE_JSON", value: JSON.stringify(workspace) },
                { name: "CODEOPS_SESSION_ID", value: raw.sessionId },
                { name: "CODEOPS_SESSION_WORKFLOW_ID", value: raw.workflowId },
                { name: "CODEOPS_SESSION_RUN_ID", value: raw.runId },
                { name: "CODEOPS_SESSION_LEASE_ID", value: raw.leaseId },
                { name: "CODEOPS_SESSION_HOLDER_ID", value: `session-job:${raw.sessionId}` },
              ],
              readinessProbe: {
                exec: { command: ["node", "-e", "process.exit(require('node:fs').existsSync('/run/codeops/ready') ? 0 : 1)"] },
                periodSeconds: 2,
                timeoutSeconds: 1,
              },
              resources: {
                requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "256Mi" },
                limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
              },
              securityContext,
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "session", mountPath: "/run/codeops" },
                { name: "session-state", mountPath: "/var/lib/codeops-session" },
                { name: "temp", mountPath: "/tmp" },
                { name: "session-secrets", mountPath: "/var/run/codeops-session", readOnly: true },
              ],
            }, {
              name: "coding-agent",
              image: raw.agentImage,
              imagePullPolicy: "IfNotPresent",
              env: [
                { name: "CODEX_HOME", value: "/tmp/codex-home" },
                { name: "CODEOPS_MODEL_PROXY_TOKEN_FILE", value: "/run/codeops/model-proxy-token" },
                { name: "DEFAULT_AUTH_REQUEST", value: '{"methodId":"api-key"}' },
                { name: "CODEX_CONFIG", value: JSON.stringify({
                  model: "gpt-5.6-sol",
                  model_reasoning_effort: "high",
                  approvals_reviewer: "auto_review",
                  web_search: "cached",
                  model_provider: "codeops_proxy",
                  model_providers: {
                    codeops_proxy: {
                      name: "CodeOps model proxy",
                      base_url: `${exactOrigin(raw.modelProxyOrigin)}/v1`,
                      env_key: "CODEX_API_KEY",
                      wire_api: "responses",
                    },
                  },
                }) },
                { name: "CODEOPS_ACP_SOCKET", value: "/run/codeops/agent.sock" },
              ],
              resources: {
                requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi" },
                limits: { cpu: "2", memory: "6Gi", "ephemeral-storage": "4Gi" },
              },
              securityContext,
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "session", mountPath: "/run/codeops" },
                { name: "temp", mountPath: "/tmp" },
              ],
            }],
            volumes: [
              { name: "workspace", persistentVolumeClaim: { claimName: name } },
              { name: "session", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } },
              { name: "session-state", emptyDir: { sizeLimit: "16Mi" } },
              { name: "temp", emptyDir: { sizeLimit: "256Mi" } },
              { name: "session-secrets", secret: {
                secretName: raw.sessionSecretsName,
                defaultMode: 256,
                items: [
                  { key: "runtime-worker-token", path: "runtime-worker-token" },
                  { key: "initialization-token", path: "initialization-token" },
                  { key: "runtime-database-url", path: "database-url" },
                ],
              } },
            ],
          },
        },
      },
    },
  ];
}

export function assertWorkspaceResources(resources: readonly Record<string, unknown>[]): void {
  if (
    resources.length !== 4 ||
    resources[0]?.kind !== "Secret" ||
    resources[1]?.kind !== "PersistentVolumeClaim" ||
    resources[2]?.kind !== "Job" ||
    resources[3]?.kind !== "Job"
  ) {
    throw new Error(
      "workspace launch must create one source Secret, one PVC, one materializer Job, and one runtime Job",
    );
  }
  const serializedMaterializer = JSON.stringify(resources[2]);
  const serializedRuntime = JSON.stringify(resources[3]);
  const serializedSecret = JSON.stringify(resources[0]);
  if (!serializedSecret.includes('"immutable":true')) {
    throw new Error("workspace source Secret must be immutable");
  }
  if (!serializedMaterializer.includes('"app.kubernetes.io/component":"workspace-materializer"')) {
    throw new Error("workspace materializer must have its isolated network identity");
  }
  if (serializedRuntime.includes("sources.json") || serializedRuntime.includes("readToken")) {
    throw new Error("workspace runtime must not receive repository credentials");
  }
  if (!serializedRuntime.includes('"ephemeral-storage"')) {
    throw new Error("workspace runtime must bound ephemeral storage");
  }
}
