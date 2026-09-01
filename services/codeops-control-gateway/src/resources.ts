import type {
  AgentJobDispatchRequest,
  CandidateCheckpoint,
} from "@codeops/codeops-contracts";
import { buildAgentPrompt } from "./core.js";
import {
  createModelProxyToken,
  createSessionModelProxyToken,
} from "@codeops/codeops-contracts/model-proxy";
import { posix } from "node:path";
import { agentJobModelBudgetAuthority } from "./agent-job-identity.js";
import {
  assertAgentModelProxyRouting,
  assertAgentModelProxySessionVolume,
} from "./model-proxy-routing.js";

interface ResourceConfig {
  readonly namespace: string;
  readonly runId: string;
  readonly requestDigest: string;
  readonly repositoryUrl: string;
  readonly agentImage: string;
  readonly sessionGatewayImage: string;
  readonly repositoryReadToken: string;
  readonly imagePullSecrets?: readonly { readonly name: string }[];
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly evidenceClaimName?: string;
  readonly modelProxyServiceName?: string;
  readonly modelProxyPodName?: string;
  readonly modelAuth: {
    readonly mode: "proxy";
    readonly origin: string;
    readonly signingKey: string;
    readonly issuedAt?: Date;
  };
  readonly candidate?: CandidateCheckpoint;
}

function canonicalMountPath(value: string | undefined): string | undefined {
  if (!value?.startsWith("/")) return undefined;
  return posix.normalize(value).replace(/\/+$/, "") || "/";
}

function mountPathsOverlap(
  mountPath: string | undefined,
  targetPath: string | undefined,
): boolean {
  return (
    mountPath !== undefined &&
    targetPath !== undefined &&
    (mountPath === targetPath ||
      mountPath.startsWith(targetPath === "/" ? "/" : `${targetPath}/`) ||
      targetPath.startsWith(mountPath === "/" ? "/" : `${mountPath}/`))
  );
}

function labels(input: ResourceConfig, request: AgentJobDispatchRequest) {
  return {
    "app.kubernetes.io/name": "codeops-agent",
    "app.kubernetes.io/part-of": "codeops",
    "codeops.example/run-id": input.runId,
    "codeops.example/agent-role": request.role,
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
      "codeops.example/request-digest": input.requestDigest,
    },
  };
  const name = `codeops-agent-${input.runId}`;
  const secretName = `codeops-run-${input.runId}`;
  const modelProxyOrigin = new URL(input.modelAuth.origin);
  const modelProxyServiceName =
    input.modelProxyServiceName ?? "codeops-model-proxy";
  const modelProxyPodName = input.modelProxyPodName ?? modelProxyServiceName;
  const evidenceClaimName =
    input.evidenceClaimName ?? "codeops-control-gateway-evidence";
  const controlGatewayPodName = evidenceClaimName.replace(/-evidence$/, "");
  if (
    modelProxyOrigin.protocol !== "http:" ||
    modelProxyOrigin.hostname !== modelProxyServiceName ||
    modelProxyOrigin.port !== "8080" ||
    modelProxyOrigin.pathname !== "/" ||
    modelProxyOrigin.username !== "" ||
    modelProxyOrigin.password !== "" ||
    modelProxyOrigin.search !== "" ||
    modelProxyOrigin.hash !== ""
  ) {
    throw new Error("model proxy origin must be the internal service");
  }
  const modelBudgetAuthority = agentJobModelBudgetAuthority(request, input.runId);
  const tokenInput = {
    subject: modelBudgetAuthority?.budgetId ?? input.runId,
    signingKey: input.modelAuth.signingKey,
    model: "gpt-5.6-sol",
    reasoningEffort: "high" as const,
    issuedAt: input.modelAuth.issuedAt,
  };
  const modelProxyToken = modelBudgetAuthority === null
    ? createModelProxyToken(tokenInput)
    : createSessionModelProxyToken({
        ...tokenInput,
        ...modelBudgetAuthority,
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
            imagePullSecrets: input.imagePullSecrets ?? [
              { name: "codeops-registry" },
            ],
            nodeSelector: input.nodeSelector ?? {
              "codeops.example/codeops": "true",
            },
            ...(input.candidate
              ? {
                  affinity: {
                    podAffinity: {
                      requiredDuringSchedulingIgnoredDuringExecution: [
                        {
                          labelSelector: {
                            matchLabels: {
                              "app.kubernetes.io/name": controlGatewayPodName,
                            },
                          },
                          topologyKey: "kubernetes.io/hostname",
                        },
                      ],
                    },
                  },
                }
              : {}),
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
                    "mkdir -p /workspace/.codeops/codex-home",
                    "chmod 700 /workspace/.codeops/codex-home",
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
                          "git -c safe.directory=/workspace -C /workspace apply --allow-empty --check /candidate/changes.patch",
                          "git -c safe.directory=/workspace -C /workspace apply --allow-empty /candidate/changes.patch",
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
                lifecycle: {
                  postStart: {
                    exec: {
                      command: [
                        "node",
                        "-e",
                        "const f=require('node:fs'),s='/var/run/secrets/codeops-model-proxy/model-proxy-token',d='/run/codeops/model-proxy-token',t=d+'.tmp',v=f.readFileSync(s);if(!v.length)throw new Error('model proxy token is empty');const h=f.openSync(t,f.constants.O_WRONLY|f.constants.O_CREAT|f.constants.O_EXCL,0o600);try{f.fchmodSync(h,0o600);f.writeFileSync(h,v);f.fsyncSync(h)}finally{f.closeSync(h)}const w=f.readFileSync(t);if(!w.length||!w.equals(v))throw new Error('model proxy token copy is incomplete');f.renameSync(t,d);const q=f.openSync(d,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const a=f.fstatSync(q),x=f.readFileSync(q);if(!a.isFile()||(a.mode&0o777)!==0o600||!x.length||!x.equals(v))throw new Error('published model proxy token is invalid')}finally{f.closeSync(q)}",
                      ],
                    },
                  },
                },
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
                  {
                    name: "model-proxy-token",
                    mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token",
                    subPath: "model-proxy-token",
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
                    name: "CODEOPS_MODEL_PROXY_TOKEN_FILE",
                    value: "/run/codeops/model-proxy-token",
                  },
                  {
                    name: "CODEX_HOME",
                    value: "/var/lib/codeops-agent/codex-home",
                  },
                  {
                    name: "INITIAL_AGENT_MODE",
                    value: "agent-full-access",
                  },
                  {
                    name: "DEFAULT_AUTH_REQUEST",
                    value: '{"methodId":"api-key"}',
                  },
                  {
                    name: "MODEL_PROVIDER",
                    value: "codeops_proxy",
                  },
                  {
                    name: "CODEOPS_MODEL_PROXY_ORIGIN",
                    value: modelProxyOrigin.origin,
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
                  {
                    name: "workspace",
                    mountPath: "/var/lib/codeops-agent/codex-home",
                    subPath: ".codeops/codex-home",
                    readOnly: false,
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
              {
                name: "model-proxy-token",
                secret: {
                  secretName,
                  items: [
                    { key: "model-proxy-token", path: "model-proxy-token" },
                  ],
                },
              },
              { name: "temp", emptyDir: { sizeLimit: "2Gi" } },
              ...(input.candidate
                ? [
                    {
                      name: "candidate",
                      persistentVolumeClaim: {
                        claimName: evidenceClaimName,
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
            "codeops.example/run-id": input.runId,
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
                    "app.kubernetes.io/name": modelProxyPodName,
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
  modelProxyIdentity: {
    readonly serviceName?: string;
    readonly podName?: string;
  } = {},
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
    metadata?: { labels?: Record<string, string> };
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
    affinity?: unknown;
    containers?: {
      name?: string;
      env?: {
        name?: string;
        value?: string;
        valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
      }[];
      envFrom?: { secretRef?: { name?: string } }[];
      lifecycle?: unknown;
      volumeMounts?: {
        name?: string;
        mountPath?: string;
        subPath?: string;
        readOnly?: boolean;
      }[];
    }[];
    initContainers?: {
      name?: string;
      env?: {
        name?: string;
        value?: string;
        valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
      }[];
      envFrom?: { secretRef?: { name?: string } }[];
      volumeMounts?: {
        name?: string;
        mountPath?: string;
        subPath?: string;
        readOnly?: boolean;
      }[];
    }[];
    volumes?: {
      name?: string;
      secret?: {
        secretName?: string;
        items?: { key?: string; path?: string }[];
      };
      projected?: {
        sources?: {
          secret?: {
            name?: string;
            items?: { key?: string; path?: string }[];
          };
        }[];
      };
      persistentVolumeClaim?: {
        claimName?: string;
        readOnly?: boolean;
      };
    }[];
  };
  const agent = pod.containers?.find(
    (container) => container.name === "coding-agent",
  );
  assertAgentModelProxySessionVolume(pod, "session-gateway");
  const modelProxyServiceName =
    modelProxyIdentity.serviceName ?? "codeops-model-proxy";
  const expectedModelProxyPodName =
    modelProxyIdentity.podName ?? modelProxyServiceName;
  const modelProxyPodName = (resources.find(
    (resource) => resource.kind === "NetworkPolicy",
  ) as { spec?: { egress?: { to?: { podSelector?: { matchLabels?: Record<string, string> } }[] }[] } })
    ?.spec?.egress?.[0]?.to?.[0]?.podSelector?.matchLabels?.["app.kubernetes.io/name"];
  if (modelProxyPodName !== expectedModelProxyPodName) {
    throw new Error("model proxy routing origin drifted");
  }
  assertAgentModelProxyRouting(
    agent,
    `http://${modelProxyServiceName}:8080`,
  );
  const runId = job.metadata?.labels?.["codeops.example/run-id"];
  const runSecretName = `codeops-run-${runId}`;
  const runSecret = resources.find(
    (resource) =>
      resource.kind === "Secret" &&
      (resource.metadata as { name?: string } | undefined)?.name === runSecretName,
  ) as { data?: Record<string, string> } | undefined;
  const allowedRunInputItems = [
    { key: "agent-prompt", path: "agent-prompt.txt" },
    { key: "project-context", path: "project-context.json" },
    { key: "coding-request", path: "coding-request.json" },
    { key: "research-packet", path: "research-packet.json" },
    { key: "research-dispatch", path: "research-dispatch.json" },
  ];
  const expectedRunInputItems = allowedRunInputItems.filter(
    (item) => runSecret?.data?.[item.key] !== undefined,
  );
  const runInputVolumes = pod.volumes?.filter(
    (volume) => volume.name === "run-input",
  ) ?? [];
  const expectedRunInputVolume = {
    name: "run-input",
    secret: { secretName: runSecretName, items: expectedRunInputItems },
  };
  const expectedTokenVolume = {
    name: "model-proxy-token",
    secret: {
      secretName: runSecretName,
      items: [{ key: "model-proxy-token", path: "model-proxy-token" }],
    },
  };
  const expectedTokenMount = {
    name: "model-proxy-token",
    mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token",
    subPath: "model-proxy-token",
    readOnly: true,
  };
  const expectedLifecycle = {
    postStart: {
      exec: {
        command: [
          "node",
          "-e",
          "const f=require('node:fs'),s='/var/run/secrets/codeops-model-proxy/model-proxy-token',d='/run/codeops/model-proxy-token',t=d+'.tmp',v=f.readFileSync(s);if(!v.length)throw new Error('model proxy token is empty');const h=f.openSync(t,f.constants.O_WRONLY|f.constants.O_CREAT|f.constants.O_EXCL,0o600);try{f.fchmodSync(h,0o600);f.writeFileSync(h,v);f.fsyncSync(h)}finally{f.closeSync(h)}const w=f.readFileSync(t);if(!w.length||!w.equals(v))throw new Error('model proxy token copy is incomplete');f.renameSync(t,d);const q=f.openSync(d,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const a=f.fstatSync(q),x=f.readFileSync(q);if(!a.isFile()||(a.mode&0o777)!==0o600||!x.length||!x.equals(v))throw new Error('published model proxy token is invalid')}finally{f.closeSync(q)}",
        ],
      },
    },
  };
  const tokenVolumes = pod.volumes?.filter(
    (volume) => volume.name === "model-proxy-token",
  ) ?? [];
  const secretProjections = (volume: NonNullable<typeof pod.volumes>[number]) => [
    ...(volume.secret
      ? [{ name: volume.secret.secretName, items: volume.secret.items }]
      : []),
    ...(volume.projected?.sources ?? []).flatMap((source) =>
      source.secret
        ? [{ name: source.secret.name, items: source.secret.items }]
        : [],
    ),
  ];
  const tokenProjections = pod.volumes?.filter((volume) =>
    secretProjections(volume).some(
      (projection) =>
        (projection.name === runSecretName &&
          (!Array.isArray(projection.items) || projection.items.length === 0)) ||
        projection.items?.some(
          (item) =>
            item.key === "model-proxy-token" || item.path === "model-proxy-token",
        ),
    ),
  ) ?? [];
  const secretVolumeNames = new Set(
    pod.volumes
      ?.filter((volume) => secretProjections(volume).length > 0)
      .map((volume) => volume.name),
  );
  const tokenVolumeNames = new Set(tokenProjections.map((volume) => volume.name));
  const allContainers = [...(pod.initContainers ?? []), ...(pod.containers ?? [])];
  const expectedTokenMountPath = canonicalMountPath(expectedTokenMount.mountPath);
  const tokenMounts = allContainers.flatMap((container) =>
    (container.volumeMounts ?? [])
      .filter((mount) => {
        const mountPath = canonicalMountPath(mount.mountPath);
        return (
          tokenVolumeNames.has(mount.name) ||
          mountPath === expectedTokenMountPath ||
          (secretVolumeNames.has(mount.name) &&
            mountPathsOverlap(mountPath, expectedTokenMountPath))
        );
      })
      .map((mount) => ({ container: container.name, mount })),
  );
  const tokenEnvironmentReferences = allContainers.flatMap((container) => [
    ...(container.env ?? []).filter(
      (entry) => entry.valueFrom?.secretKeyRef?.key === "model-proxy-token",
    ),
    ...(container.envFrom ?? []).filter(
      (entry) => entry.secretRef?.name === runSecretName,
    ),
  ]);
  const tokenProjectors = pod.containers?.filter(
    (container) => container.name === "session-gateway",
  ) ?? [];
  if (
    !runId ||
    expectedRunInputItems.length === 0 ||
    runInputVolumes.length !== 1 ||
    JSON.stringify(runInputVolumes[0]) !== JSON.stringify(expectedRunInputVolume) ||
    tokenVolumes.length !== 1 ||
    JSON.stringify(tokenVolumes[0]) !== JSON.stringify(expectedTokenVolume) ||
    tokenProjections.length !== 1 ||
    tokenProjections[0] !== tokenVolumes[0] ||
    tokenMounts.length !== 1 ||
    tokenMounts[0]?.container !== "session-gateway" ||
    JSON.stringify(tokenMounts[0].mount) !== JSON.stringify(expectedTokenMount) ||
    tokenEnvironmentReferences.length !== 0 ||
    tokenProjectors.length !== 1 ||
    JSON.stringify(tokenProjectors[0]?.lifecycle) !==
      JSON.stringify(expectedLifecycle)
  ) {
    throw new Error("model proxy credential selector drifted");
  }
  const candidateVolume = pod.volumes?.find(
    (volume) => volume.name === "candidate",
  );
  const codexHomeMount = agent?.volumeMounts?.find(
    (mount) => mount.mountPath === "/var/lib/codeops-agent/codex-home",
  );
  if (
    agent?.env?.find((entry) => entry.name === "CODEX_HOME")?.value !==
      "/var/lib/codeops-agent/codex-home" ||
    agent.env?.find((entry) => entry.name === "INITIAL_AGENT_MODE")?.value !==
      "agent-full-access" ||
    agent.env?.find((entry) => entry.name === "DEFAULT_AUTH_REQUEST")?.value !==
      '{"methodId":"api-key"}' ||
    agent.env?.find((entry) => entry.name === "CODEOPS_MODEL_PROXY_TOKEN_FILE")
      ?.value !== "/run/codeops/model-proxy-token" ||
    codexHomeMount?.name !== "workspace" ||
    codexHomeMount.subPath !== ".codeops/codex-home" ||
    codexHomeMount.readOnly !== false ||
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
    const candidateClaimName =
      candidateVolume.persistentVolumeClaim?.claimName ?? "";
    const expectedAffinity = {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: {
              matchLabels: {
                "app.kubernetes.io/name": candidateClaimName.replace(
                  /-evidence$/,
                  "",
                ),
              },
            },
            topologyKey: "kubernetes.io/hostname",
          },
        ],
      },
    };
    if (
      candidateClaimName.length > 253 ||
      !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?-control-gateway-evidence$/.test(
        candidateClaimName,
      ) ||
      candidateVolume.persistentVolumeClaim?.readOnly !== true ||
      mount?.mountPath !== "/candidate/changes.patch" ||
      mount.readOnly !== true ||
      !/^agent-runs\/[a-z0-9-]+\/changes\.patch$/.test(
        mount.subPath ?? "",
      ) ||
      JSON.stringify(pod.affinity) !== JSON.stringify(expectedAffinity) ||
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
  if (!candidateVolume && pod.affinity !== undefined) {
    throw new Error("Agent Job affinity is limited to candidate evidence");
  }
}
