import { posix } from "node:path";

const providerName = "codeops_proxy";
const sessionPath = "/run/codeops";
const tokenPath = "/run/codeops/model-proxy-token";

interface AgentEnvironmentEntry {
  readonly name?: string;
  readonly value?: string;
  readonly valueFrom?: unknown;
}

interface AgentContainer {
  readonly env?: readonly AgentEnvironmentEntry[];
  readonly name?: string;
  readonly volumeMounts?: readonly {
    readonly name?: string;
    readonly mountPath?: string;
    readonly subPath?: string;
    readonly readOnly?: boolean;
  }[];
}

interface AgentPod {
  readonly containers?: readonly AgentContainer[];
  readonly initContainers?: readonly AgentContainer[];
  readonly volumes?: readonly {
    readonly name?: string;
    readonly emptyDir?: unknown;
    readonly secret?: unknown;
    readonly projected?: {
      readonly sources?: readonly { readonly secret?: unknown }[];
    };
  }[];
}

function canonicalPath(value: string | undefined): string | undefined {
  if (!value?.startsWith("/")) return undefined;
  return posix.normalize(value).replace(/\/+$/, "") || "/";
}

function pathsOverlap(
  left: string | undefined,
  right: string,
): boolean {
  return (
    left !== undefined &&
    (left === right ||
      left.startsWith(right === "/" ? "/" : `${right}/`) ||
      right.startsWith(left === "/" ? "/" : `${left}/`))
  );
}

function isSecretBacked(volume: NonNullable<AgentPod["volumes"]>[number]): boolean {
  return (
    volume.secret !== undefined ||
    (volume.projected?.sources ?? []).some((source) => source.secret !== undefined)
  );
}

function exactProxyOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("model proxy origin must be one credential-free HTTP origin");
  }
  return origin.origin;
}

export function assertAgentModelProxyRouting(
  agent: AgentContainer | undefined,
  expectedOrigin?: string,
): void {
  const env = agent?.env ?? [];
  const requiredNames = [
    "CODEOPS_MODEL_PROXY_ORIGIN",
    "CODEX_CONFIG",
    "MODEL_PROVIDER",
  ];
  if (
    requiredNames.some(
      (name) => env.filter((entry) => entry.name === name).length !== 1,
    )
  ) {
    throw new Error("model proxy routing environment is incomplete or duplicated");
  }
  const tokenFileEntries = env.filter(
    (entry) => entry.name === "CODEOPS_MODEL_PROXY_TOKEN_FILE",
  );
  if (
    env.some((entry) =>
      ["CODEX_API_KEY", "OPENAI_API_KEY"].includes(entry.name ?? ""),
    ) ||
    tokenFileEntries.length !== 1 ||
    tokenFileEntries[0]?.value !== "/run/codeops/model-proxy-token" ||
    tokenFileEntries[0]?.valueFrom !== undefined
  ) {
    throw new Error("model proxy credential selector drifted");
  }
  const values = Object.fromEntries(
    env.map((entry) => [entry.name, entry.value]),
  );
  if (values.MODEL_PROVIDER !== providerName) {
    throw new Error("model proxy process provider drifted");
  }
  const origin = exactProxyOrigin(values.CODEOPS_MODEL_PROXY_ORIGIN ?? "");
  if (expectedOrigin !== undefined && origin !== exactProxyOrigin(expectedOrigin)) {
    throw new Error("model proxy routing origin drifted");
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(values.CODEX_CONFIG ?? "") as Record<string, unknown>;
  } catch {
    throw new Error("model proxy Codex configuration is invalid");
  }
  const providers = config.model_providers as Record<string, unknown> | undefined;
  const provider = providers?.[providerName] as Record<string, unknown> | undefined;
  if (
    config.model_provider !== providerName ||
    !providers ||
    JSON.stringify(Object.keys(providers).sort()) !== JSON.stringify([providerName]) ||
    !provider ||
    JSON.stringify(Object.keys(provider).sort()) !==
      JSON.stringify(["base_url", "env_key", "name", "wire_api"]) ||
    provider.name !== "CodeOps model proxy" ||
    provider.base_url !== `${origin}/v1` ||
    provider.env_key !== "CODEX_API_KEY" ||
    provider.wire_api !== "responses"
  ) {
    throw new Error("model proxy Codex routing contract drifted");
  }
}

export function assertAgentModelProxySessionVolume(
  pod: AgentPod,
  producerName: string,
): void {
  const sessionVolumes = pod.volumes?.filter((volume) => volume.name === "session") ?? [];
  const containers = [...(pod.initContainers ?? []), ...(pod.containers ?? [])];
  const exactMount = { name: "session", mountPath: "/run/codeops" };
  const sessionMounts = containers.flatMap((container) =>
    (container.volumeMounts ?? [])
      .filter(
        (mount) =>
          mount.name === "session" ||
          pathsOverlap(canonicalPath(mount.mountPath), sessionPath),
      )
      .map((mount) => ({ container: container.name, mount })),
  );
  const secretOverlap = (pod.volumes ?? []).some(
    (volume) =>
      isSecretBacked(volume) &&
      containers.some((container) =>
        container.volumeMounts?.some((mount) => {
          const mountPath = canonicalPath(mount.mountPath);
          return (
            mount.name === volume.name &&
            (pathsOverlap(mountPath, sessionPath) ||
              pathsOverlap(mountPath, tokenPath))
          );
        }),
      ),
  );
  if (
    sessionVolumes.length !== 1 ||
    JSON.stringify(sessionVolumes[0]) !==
      JSON.stringify({ name: "session", emptyDir: { medium: "Memory", sizeLimit: "16Mi" } }) ||
    sessionMounts.length !== 2 ||
    sessionMounts.filter(
      ({ container, mount }) =>
        container === producerName && JSON.stringify(mount) === JSON.stringify(exactMount),
    ).length !== 1 ||
    sessionMounts.filter(
      ({ container, mount }) =>
        container === "coding-agent" && JSON.stringify(mount) === JSON.stringify(exactMount),
    ).length !== 1 ||
    secretOverlap
  ) {
    throw new Error("model proxy shared session volume drifted");
  }
}
