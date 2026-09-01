import { posix } from "node:path";

const providerName = "codeops_proxy";
const sessionPath = "/run/codeops";
const tokenPath = "/run/codeops/model-proxy-token";

function canonicalPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  return posix.normalize(value).replace(/\/+$/, "") || "/";
}

function pathsOverlap(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    (left === right ||
      left.startsWith(right === "/" ? "/" : `${right}/`) ||
      right.startsWith(left === "/" ? "/" : `${left}/`))
  );
}

function isSecretBacked(volume) {
  return (
    volume?.secret !== undefined ||
    volume?.projected?.sources?.some((source) => source.secret !== undefined)
  );
}

function exactOrigin(value) {
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

export function assertModelProxyRouting(agent, expectedOrigin) {
  const env = agent?.env ?? [];
  for (const name of ["CODEOPS_MODEL_PROXY_ORIGIN", "CODEX_CONFIG", "MODEL_PROVIDER"]) {
    if (env.filter((entry) => entry.name === name).length !== 1) {
      throw new Error("model proxy routing environment is incomplete or duplicated");
    }
  }
  const tokenFile = env.filter((entry) => entry.name === "CODEOPS_MODEL_PROXY_TOKEN_FILE");
  if (
    env.some((entry) => ["CODEX_API_KEY", "OPENAI_API_KEY"].includes(entry.name)) ||
    tokenFile.length !== 1 ||
    tokenFile[0].value !== "/run/codeops/model-proxy-token" ||
    tokenFile[0].valueFrom !== undefined
  ) {
    throw new Error("model proxy credential selector drifted");
  }
  const values = Object.fromEntries(env.map((entry) => [entry.name, entry.value]));
  if (values.MODEL_PROVIDER !== providerName) {
    throw new Error("model proxy process provider drifted");
  }
  const origin = exactOrigin(values.CODEOPS_MODEL_PROXY_ORIGIN ?? "");
  if (origin !== exactOrigin(expectedOrigin)) {
    throw new Error("model proxy routing origin drifted");
  }
  let config;
  try {
    config = JSON.parse(values.CODEX_CONFIG ?? "");
  } catch {
    throw new Error("model proxy Codex configuration is invalid");
  }
  const providers = config?.model_providers;
  const provider = providers?.[providerName];
  if (
    config?.model_provider !== providerName ||
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

export function assertModelProxySessionVolume(pod, producerName) {
  const sessionVolume = pod?.volumes?.filter((volume) => volume.name === "session") ?? [];
  const containers = [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])];
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
  const secretOverlap = (pod?.volumes ?? []).some(
    (volume) =>
      isSecretBacked(volume) &&
      containers.some((container) =>
        container.volumeMounts?.some((mount) => {
          const mountPath = canonicalPath(mount.mountPath);
          return (
            mount.name === volume.name &&
            (pathsOverlap(mountPath, sessionPath) || pathsOverlap(mountPath, tokenPath))
          );
        }),
      ),
  );
  if (
    sessionVolume.length !== 1 ||
    JSON.stringify(sessionVolume[0]) !==
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
