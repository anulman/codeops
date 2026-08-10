import type {
  AgentJobDispatchRequest,
  CandidateCheckpoint,
} from "@renoconcierge/codeops-contracts";
import { createHmac } from "node:crypto";
import { buildAgentPrompt } from "./core.js";

interface ResourceConfig {
  readonly namespace: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly repositoryUrl: string;
  readonly agentImage: string;
  readonly sessionGatewayImage: string;
  readonly repositoryReadToken: string;
  readonly modelAuth: {
    readonly mode: "proxy";
    readonly origin: string;
    readonly signingKey: string;
    readonly issuedAt?: Date;
  };
  readonly candidate?: CandidateCheckpoint;
}

function createModelProxyToken(input: {
  runId: string;
  signingKey: string;
  issuedAt?: Date;
}): string {
  if (input.signingKey.length < 32 || input.signingKey.length > 4_096) {
    throw new Error("model proxy signing key length is invalid");
  }
  const issuedAt = Math.floor((input.issuedAt ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAt)) {
    throw new Error("model proxy token issue time is invalid");
  }
  const payload = Buffer.from(JSON.stringify({
    aud: "codeops-model-proxy",
    sub: input.runId,
    iat: issuedAt,
    exp: issuedAt + 75 * 60,
  })).toString("base64url");
  const signature = createHmac("sha256", input.signingKey)
    .update(`v1.${payload}`)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
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
  const requestedCandidate =
    request.role === "critic-agent"
      ? request.candidate
      : request.role === "coding-agent"
        ? request.revision?.candidate
        : undefined;
  if (
    JSON.stringify(input.candidate) !== JSON.stringify(requestedCandidate)
  ) {
    throw new Error(
      "resource candidate mount must exactly match the dispatch contract",
    );
  }
  const metadata = {
    namespace: input.namespace,
    labels: labels(input, request),
    annotations: {
      "codeops.renoconcierge.ca/request-digest": input.requestDigest,
    },
  };
  const name = `codeops-agent-${input.runId}`;
  const secretName = `codeops-run-${input.runId}`;
  const modelProxyOrigin = new URL(input.modelAuth.origin);
  if (
    modelProxyOrigin.protocol !== "http:" ||
    modelProxyOrigin.hostname !== "codeops-model-proxy" ||
    modelProxyOrigin.port !== "8080" ||
    modelProxyOrigin.pathname !== "/" ||
    modelProxyOrigin.username !== "" ||
    modelProxyOrigin.password !== "" ||
    modelProxyOrigin.search !== "" ||
    modelProxyOrigin.hash !== ""
  ) {
    throw new Error("model proxy origin must be the internal service");
  }
  const modelProxyToken = createModelProxyToken({
    runId: input.runId,
    signingKey: input.modelAuth.signingKey,
    issuedAt: input.modelAuth.issuedAt,
  });
  const prompt = buildAgentPrompt(request);
  const workspaceReadOnly = request.role === "qa-contract-researcher";
  const projectContext =
    request.role === "coding-agent" || request.role === "critic-agent"
      ? request.codingRequest.projectContext
      : request.researchRequest.projectContext;
  const researchPacket =
    request.role === "coding-agent" || request.role === "critic-agent"
      ? request.codingRequest.researchPacket
      : undefined;
  const codingRequest =
    request.role === "coding-agent" || request.role === "critic-agent"
      ? request.codingRequest
      : undefined;
  const researchDispatch =
    request.role === "qa-contract-researcher" ? request : undefined;
  const commonSecurity = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  const commonIdentity = [
    { name: "CODEOPS_RUN_ID", value: input.runId },
    { name: "CODEOPS_BASE_SHA", value: request.baseSha },
    {
      name: "CODEOPS_CONTROL_PLANE_SHA",
      value: projectContext.controlPlaneSha,
    },
    { name: "CODEOPS_AGENT_ROLE", value: request.role },
    { name: "CODEOPS_PROJECT_CONTEXT_DIGEST", value: projectContext.digest },
    { name: "CODEOPS_MODEL", value: "gpt-5.6-sol" },
    { name: "CODEOPS_REASONING_EFFORT", value: "high" },
    ...(input.candidate
      ? [
          {
            name: "CODEOPS_CANDIDATE_PATCH_DIGEST",
            value: input.candidate.patch.digest,
          },
          {
            name: "CODEOPS_CANDIDATE_PATCH_SIZE",
            value: String(input.candidate.patch.sizeBytes),
          },
        ]
      : []),
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
        "agent-prompt": Buffer.from(prompt).toString("base64"),
        "project-context": Buffer.from(
          JSON.stringify(projectContext),
        ).toString("base64"),
        ...(codingRequest === undefined
          ? {}
          : {
              "coding-request": Buffer.from(
                JSON.stringify(codingRequest),
              ).toString("base64"),
            }),
        ...(researchPacket === undefined
          ? {}
          : {
              "research-packet": Buffer.from(
                JSON.stringify(researchPacket),
              ).toString("base64"),
            }),
        ...(researchDispatch === undefined
          ? {}
          : {
              "research-dispatch": Buffer.from(
                JSON.stringify(researchDispatch),
              ).toString("base64"),
            }),
        "model-proxy-token": Buffer.from(modelProxyToken).toString("base64"),
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
                    "git -c safe.directory=/workspace -C /workspace remote add origin \"$CODEOPS_REPOSITORY\"",
                    "git -c safe.directory=/workspace -C /workspace -c \"http.extraHeader=Authorization: Basic $auth\" fetch --depth=1 origin \"$CODEOPS_BASE_SHA\"",
                    "unset auth CODEOPS_REPOSITORY_READ_TOKEN",
                    "git -c safe.directory=/workspace -C /workspace checkout --detach FETCH_HEAD",
                    "git -c safe.directory=/workspace -C /workspace remote remove origin",
                    "test \"$(git -c safe.directory=/workspace -C /workspace rev-parse HEAD)\" = \"$CODEOPS_BASE_SHA\"",
                    ...(input.candidate
                      ? [
                          "test -f /candidate/changes.patch",
                          "test \"$(wc -c < /candidate/changes.patch | tr -d ' ')\" = \"$CODEOPS_CANDIDATE_PATCH_SIZE\"",
                          "test \"sha256:$(sha256sum /candidate/changes.patch | cut -d' ' -f1)\" = \"$CODEOPS_CANDIDATE_PATCH_DIGEST\"",
                          "git -c safe.directory=/workspace -C /workspace apply --check /candidate/changes.patch",
                          "git -c safe.directory=/workspace -C /workspace apply /candidate/changes.patch",
                        ]
                      : []),
                    "node /opt/codeops-agent/prepare-project-context.mjs",
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
                  { name: "CODEOPS_WORKSPACE", value: "/workspace" },
                  { name: "CODEOPS_CONTEXT_DIR", value: "/context" },
                  {
                    name: "CODEOPS_PROJECT_CONTEXT_FILE",
                    value: "/input/project-context.json",
                  },
                  ...(codingRequest === undefined
                    ? []
                    : [
                        {
                          name: "CODEOPS_CODING_REQUEST_FILE",
                          value: "/input/coding-request.json",
                        },
                      ]),
                  ...(researchPacket === undefined
                    ? []
                    : [
                        {
                          name: "CODEOPS_RESEARCH_PACKET_FILE",
                          value: "/input/research-packet.json",
                        },
                      ]),
                  ...(researchDispatch === undefined
                    ? []
                    : [
                        {
                          name: "CODEOPS_RESEARCH_DISPATCH_FILE",
                          value: "/input/research-dispatch.json",
                        },
                      ]),
                ],
                resources: {
                  requests: { cpu: "100m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
                securityContext: commonSecurity,
                volumeMounts: [
                  { name: "workspace", mountPath: "/workspace" },
                  { name: "context", mountPath: "/context" },
                  {
                    name: "run-input",
                    mountPath: "/input",
                    readOnly: true,
                  },
                  ...(input.candidate
                    ? [
                        {
                          name: "candidate",
                          mountPath: "/candidate/changes.patch",
                          subPath: `agent-runs/${input.candidate.runId}/changes.patch`,
                          readOnly: true,
                        },
                      ]
                    : []),
                ],
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
                  { name: "CODEOPS_CONTEXT_DIR", value: "/context" },
                  {
                    name: "CODEOPS_PROMPT_FILE",
                    value: "/input/agent-prompt.txt",
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
                  {
                    name: "context",
                    mountPath: "/context",
                    readOnly: true,
                  },
                  {
                    name: "run-input",
                    mountPath: "/input",
                    readOnly: true,
                  },
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
                      secretKeyRef: {
                        name: secretName,
                        key: "model-proxy-token",
                      },
                    },
                  },
                  {
                    name: "CODEX_HOME",
                    value: "/tmp/codex-home",
                  },
                  {
                    name: "DEFAULT_AUTH_REQUEST",
                    value: '{"methodId":"api-key"}',
                  },
                  {
                    name: "CODEX_CONFIG",
                    value: JSON.stringify({
                      model: "gpt-5.6-sol",
                      model_reasoning_effort: "high",
                      approvals_reviewer: "auto_review",
                      web_search: "cached",
                      model_provider: "codeops_proxy",
                      model_providers: {
                        codeops_proxy: {
                          name: "CodeOps model proxy",
                          base_url: new URL("/v1", modelProxyOrigin).toString(),
                          env_key: "CODEX_API_KEY",
                          wire_api: "responses",
                        },
                      },
                    }),
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
                  {
                    name: "context",
                    mountPath: "/context",
                    readOnly: true,
                  },
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
              { name: "context", emptyDir: { sizeLimit: "2Mi" } },
              {
                name: "run-input",
                secret: {
                  secretName,
                  items: [
                    { key: "agent-prompt", path: "agent-prompt.txt" },
                    {
                      key: "project-context",
                      path: "project-context.json",
                    },
                    ...(codingRequest === undefined
                      ? []
                      : [
                          {
                            key: "coding-request",
                            path: "coding-request.json",
                          },
                        ]),
                    ...(researchPacket === undefined
                      ? []
                      : [
                          {
                            key: "research-packet",
                            path: "research-packet.json",
                          },
                        ]),
                    ...(researchDispatch === undefined
                      ? []
                      : [
                          {
                            key: "research-dispatch",
                            path: "research-dispatch.json",
                          },
                        ]),
                  ],
                },
              },
              { name: "temp", emptyDir: { sizeLimit: "256Mi" } },
              ...(input.candidate
                ? [
                    {
                      name: "candidate",
                      persistentVolumeClaim: {
                        claimName: "codeops-control-gateway-evidence",
                        readOnly: true,
                      },
                    },
                  ]
                : []),
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
                podSelector: {
                  matchLabels: {
                    "app.kubernetes.io/name": "codeops-model-proxy",
                  },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
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
  if (serialized.includes("hostPath")) {
    throw new Error("Agent Job resources must not mount host paths");
  }
  const claimReferences = [
    ...serialized.matchAll(/"persistentVolumeClaim"/g),
  ].length;
  if (claimReferences > 1) {
    throw new Error(
      "Agent Job may mount only the exact candidate-evidence claim",
    );
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
  const pod = job.spec.template.spec as {
    containers?: {
      name?: string;
      env?: { name?: string; value?: string }[];
      volumeMounts?: { name?: string; mountPath?: string }[];
    }[];
    initContainers?: {
      name?: string;
      volumeMounts?: {
        name?: string;
        mountPath?: string;
        subPath?: string;
        readOnly?: boolean;
      }[];
    }[];
    volumes?: {
      name?: string;
      persistentVolumeClaim?: {
        claimName?: string;
        readOnly?: boolean;
      };
    }[];
  };
  const agent = pod.containers?.find(
    (container) => container.name === "coding-agent",
  );
  const candidateVolume = pod.volumes?.find(
    (volume) => volume.name === "candidate",
  );
  if (
    agent?.env?.find((entry) => entry.name === "CODEX_HOME")?.value !==
      "/tmp/codex-home" ||
    agent.env?.find((entry) => entry.name === "DEFAULT_AUTH_REQUEST")?.value !==
      '{"methodId":"api-key"}' ||
    !agent.env?.some((entry) => entry.name === "CODEX_API_KEY") ||
    serialized.includes("model-api-key") ||
    serialized.includes("codex-auth")
  ) {
    throw new Error("model proxy credential boundary drifted");
  }
  if (candidateVolume) {
    const builder = pod.initContainers?.find(
      (container) => container.name === "workspace-builder",
    );
    const mount = builder?.volumeMounts?.find(
      (candidate) => candidate.name === "candidate",
    );
    if (
      candidateVolume.persistentVolumeClaim?.claimName !==
        "codeops-control-gateway-evidence" ||
      candidateVolume.persistentVolumeClaim?.readOnly !== true ||
      mount?.mountPath !== "/candidate/changes.patch" ||
      mount.readOnly !== true ||
      !/^agent-runs\/[a-z0-9-]+\/changes\.patch$/.test(
        mount.subPath ?? "",
      ) ||
      pod.containers?.some((container) =>
        container.volumeMounts?.some(
          (candidate) => candidate.name === "candidate",
        ),
      )
    ) {
      throw new Error("candidate evidence claim boundary drifted");
    }
  }
  if (
    claimReferences !==
    Number(candidateVolume !== undefined)
  ) {
    throw new Error("unexpected Agent Job persistent claim");
  }
}
