import type { AgentJobDispatchRequest } from "@renoconcierge/codeops-contracts";
import { buildAgentPrompt } from "./core.js";

interface ResourceConfig {
  readonly namespace: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly repositoryUrl: string;
  readonly agentImage: string;
  readonly sessionGatewayImage: string;
  readonly repositoryReadToken: string;
  readonly modelApiKey: string;
}

function labels(input: ResourceConfig, request: AgentJobDispatchRequest) {
  return {
    "app.kubernetes.io/name": "codeops-agent",
    "app.kubernetes.io/part-of": "codeops-trial0",
    "codeops.renoconcierge.ca/run-id": input.runId,
    "codeops.renoconcierge.ca/agent-role": request.role,
  };
}

export function buildRunResources(
  input: ResourceConfig,
  request: AgentJobDispatchRequest,
): readonly Record<string, unknown>[] {
  const metadata = {
    namespace: input.namespace,
    labels: labels(input, request),
    annotations: {
      "codeops.renoconcierge.ca/request-digest": input.requestDigest,
    },
  };
  const name = `codeops-agent-${input.runId}`;
  const secretName = `codeops-run-${input.runId}`;
  const workspaceReadOnly = request.role === "qa-contract-researcher";
  const commonSecurity = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  const commonIdentity = [
    { name: "CODEOPS_RUN_ID", value: input.runId },
    { name: "CODEOPS_BASE_SHA", value: request.baseSha },
    { name: "CODEOPS_AGENT_ROLE", value: request.role },
  ];
  return [
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { ...metadata, name: secretName },
      type: "Opaque",
      immutable: true,
      data: {
        "repository-read-token": Buffer.from(
          input.repositoryReadToken,
        ).toString("base64"),
        "model-api-key": Buffer.from(input.modelApiKey).toString("base64"),
      },
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { ...metadata, name },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { ...metadata, name },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 3600,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: { labels: labels(input, request) },
          spec: {
            restartPolicy: "Never",
            serviceAccountName: name,
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            imagePullSecrets: [{ name: "ghcr-renoconcierge" }],
            nodeSelector: { "renoconcierge.ca/codeops": "true" },
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            initContainers: [
              {
                name: "workspace-builder",
                image: input.agentImage,
                imagePullPolicy: "IfNotPresent",
                command: [
                  "/bin/sh",
                  "-ceu",
                  [
                    "auth=\"$(printf 'x-access-token:%s' \"$CODEOPS_REPOSITORY_READ_TOKEN\" | base64 | tr -d '\\n')\"",
                    "git init /workspace",
                    "git -C /workspace remote add origin \"$CODEOPS_REPOSITORY\"",
                    "git -C /workspace -c \"http.extraHeader=Authorization: Basic $auth\" fetch --depth=1 origin \"$CODEOPS_BASE_SHA\"",
                    "unset auth CODEOPS_REPOSITORY_READ_TOKEN",
                    "git -C /workspace checkout --detach FETCH_HEAD",
                    "git -C /workspace remote remove origin",
                    "test \"$(git -C /workspace rev-parse HEAD)\" = \"$CODEOPS_BASE_SHA\"",
                  ].join("\n"),
                ],
                env: [
                  ...commonIdentity.slice(1),
                  { name: "CODEOPS_REPOSITORY", value: input.repositoryUrl },
                  {
                    name: "CODEOPS_REPOSITORY_READ_TOKEN",
                    valueFrom: {
                      secretKeyRef: {
                        name: secretName,
                        key: "repository-read-token",
                      },
                    },
                  },
                ],
                resources: {
                  requests: { cpu: "100m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
                securityContext: commonSecurity,
                volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
              },
            ],
            containers: [
              {
                name: "session-gateway",
                image: input.sessionGatewayImage,
                imagePullPolicy: "IfNotPresent",
                env: [
                  ...commonIdentity,
                  { name: "CODEOPS_ACP_SOCKET", value: "/run/codeops/agent.sock" },
                  { name: "CODEOPS_CHECKPOINT_DIR", value: "/checkpoint" },
                  { name: "CODEOPS_WORKSPACE", value: "/workspace" },
                  {
                    name: "CODEOPS_PROMPT_B64",
                    value: Buffer.from(buildAgentPrompt(request)).toString("base64"),
                  },
                ],
                resources: {
                  requests: { cpu: "100m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
                securityContext: commonSecurity,
                volumeMounts: [
                  {
                    name: "workspace",
                    mountPath: "/workspace",
                    readOnly: workspaceReadOnly,
                  },
                  { name: "session", mountPath: "/run/codeops" },
                  { name: "checkpoint", mountPath: "/checkpoint" },
                  { name: "temp", mountPath: "/tmp" },
                ],
              },
              {
                name: "coding-agent",
                image: input.agentImage,
                imagePullPolicy: "IfNotPresent",
                env: [
                  ...commonIdentity,
                  { name: "CODEOPS_REPOSITORY", value: input.repositoryUrl },
                  {
                    name: "CODEX_API_KEY",
                    valueFrom: {
                      secretKeyRef: { name: secretName, key: "model-api-key" },
                    },
                  },
                  {
                    name: "DEFAULT_AUTH_REQUEST",
                    value: '{"methodId":"api-key"}',
                  },
                  { name: "CODEOPS_ACP_SOCKET", value: "/run/codeops/agent.sock" },
                ],
                resources: {
                  requests: { cpu: "500m", memory: "1Gi" },
                  limits: { cpu: "2", memory: "6Gi" },
                },
                securityContext: commonSecurity,
                volumeMounts: [
                  {
                    name: "workspace",
                    mountPath: "/workspace",
                    readOnly: workspaceReadOnly,
                  },
                  { name: "session", mountPath: "/run/codeops" },
                  { name: "checkpoint", mountPath: "/checkpoint" },
                  { name: "temp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "workspace", emptyDir: {} },
              {
                name: "session",
                emptyDir: { medium: "Memory", sizeLimit: "16Mi" },
              },
              { name: "checkpoint", emptyDir: { sizeLimit: "256Mi" } },
              { name: "temp", emptyDir: { sizeLimit: "256Mi" } },
            ],
          },
        },
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { ...metadata, name },
      spec: {
        podSelector: {
          matchLabels: {
            "codeops.renoconcierge.ca/run-id": input.runId,
          },
        },
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name": "kube-system",
                  },
                },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: [
                    "0.0.0.0/8",
                    "10.0.0.0/8",
                    "100.64.0.0/10",
                    "127.0.0.0/8",
                    "169.254.0.0/16",
                    "172.16.0.0/12",
                    "192.0.0.0/24",
                    "192.168.0.0/16",
                    "198.18.0.0/15",
                    "224.0.0.0/4",
                    "240.0.0.0/4",
                  ],
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 443 }],
          },
        ],
      },
    },
  ];
}

export function assertRunResources(
  resources: readonly Record<string, unknown>[],
): void {
  const serialized = JSON.stringify(resources);
  if (
    resources.length !== 4 ||
    JSON.stringify(resources.map((resource) => resource.kind).sort()) !==
      JSON.stringify(["Job", "NetworkPolicy", "Secret", "ServiceAccount"])
  ) {
    throw new Error("control gateway may create only the fixed run resources");
  }
  if (
    serialized.includes("hostPath") ||
    serialized.includes("PersistentVolumeClaim")
  ) {
    throw new Error("Agent Job resources must remain ephemeral");
  }
  const job = resources.find((resource) => resource.kind === "Job") as {
    spec: { template: { spec: Record<string, unknown> } };
  };
  const account = resources.find(
    (resource) => resource.kind === "ServiceAccount",
  ) as { automountServiceAccountToken?: boolean };
  if (
    job.spec.template.spec.automountServiceAccountToken !== false ||
    account.automountServiceAccountToken !== false
  ) {
    throw new Error("Agent Job resources must remain tokenless");
  }
}
