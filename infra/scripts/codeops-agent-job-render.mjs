import { parseAllDocuments } from "yaml";
import { posix } from "node:path";
import {
  assertModelProxyRouting,
  assertModelProxySessionVolume,
} from "./model-proxy-routing.mjs";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const REPOSITORY =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
const AGENT_ROLES = new Set([
  "coding-agent",
  "qa-contract-researcher",
]);

const TOKENS = {
  __CODEOPS_AGENT_DIGEST__: "agentDigest",
  __CODEOPS_AGENT_ROLE__: "role",
  __CODEOPS_BASE_SHA__: "baseSha",
  __CODEOPS_REPOSITORY_URL__: "repository",
  __CODEOPS_RUN_ID__: "runId",
  __CODEOPS_RUN_SUFFIX__: "runSuffix",
  __CODEOPS_SESSION_GATEWAY_DIGEST__: "sessionGatewayDigest",
  __CODEOPS_WORKSPACE_READ_ONLY__: "workspaceReadOnly",
};

function canonicalMountPath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  const normalized = posix.normalize(value).replace(/\/+$/, "");
  return normalized || "/";
}

function mountPathsOverlap(mountPath, targetPath) {
  return (
    mountPath !== undefined &&
    targetPath !== undefined &&
    (mountPath === targetPath ||
      mountPath.startsWith(targetPath === "/" ? "/" : `${targetPath}/`) ||
      targetPath.startsWith(mountPath === "/" ? "/" : `${mountPath}/`))
  );
}

function secretProjections(volume) {
  return [
    ...(volume.secret
      ? [{ name: volume.secret.secretName, items: volume.secret.items }]
      : []),
    ...(volume.projected?.sources ?? []).flatMap((source) =>
      source.secret
        ? [{ name: source.secret.name, items: source.secret.items }]
        : []
    ),
  ];
}

export function renderAgentJobManifest(template, input) {
  if (!RUN_ID.test(input.runId ?? "")) {
    throw new Error("run ID must be a DNS-safe label");
  }
  if (!SHA.test(input.baseSha ?? "")) {
    throw new Error("base SHA must contain exactly 40 lowercase hex characters");
  }
  if (!REPOSITORY.test(input.repository ?? "")) {
    throw new Error("repository must be an HTTPS GitHub repository URL");
  }
  if (!AGENT_ROLES.has(input.role ?? "")) {
    throw new Error(
      "static manifest role must be coding-agent or qa-contract-researcher; critics require the control gateway's exact candidate mount",
    );
  }
  for (const key of ["agentDigest", "sessionGatewayDigest"]) {
    if (!DIGEST.test(input[key] ?? "")) {
      throw new Error(`${key} must use a lowercase SHA-256 digest`);
    }
  }

  const values = {
    ...input,
    runSuffix: input.runId,
    workspaceReadOnly:
      input.role === "qa-contract-researcher" ? "true" : "false",
  };
  values.promptBase64 = Buffer.from(input.prompt ?? "", "utf8").toString("base64");
  if (
    Buffer.byteLength(input.prompt ?? "", "utf8") < 1 ||
    Buffer.byteLength(input.prompt ?? "", "utf8") > 100_000
  ) {
    throw new Error("prompt must contain 1 to 100000 UTF-8 bytes");
  }
  let rendered = template;
  for (const [token, key] of Object.entries(TOKENS)) {
    const occurrences = rendered.split(token).length - 1;
    if (occurrences < 1) throw new Error(`expected ${token} token`);
    rendered = rendered.replaceAll(token, values[key]);
  }
  for (const token of Object.keys(TOKENS)) {
    if (rendered.includes(token)) {
      throw new Error(`unresolved ${token} token survived rendering`);
    }
  }

  const resources = parseAllDocuments(rendered).map((document) => document.toJS());
  const kinds = resources.map((resource) => resource?.kind).sort();
  if (
    JSON.stringify(kinds) !==
    JSON.stringify(["Job", "NetworkPolicy", "ServiceAccount"])
  ) {
    throw new Error("agent run may render only Job, NetworkPolicy, and ServiceAccount");
  }

  const job = resources.find((resource) => resource.kind === "Job");
  const account = resources.find((resource) => resource.kind === "ServiceAccount");
  const networkPolicy = resources.find(
    (resource) => resource.kind === "NetworkPolicy",
  );
  const pod = job.spec.template.spec;
  const images = [...pod.initContainers, ...pod.containers].map(
    (container) => container.image,
  );
  if (
    images.length !== 3 ||
    images.some((image) => !/@sha256:[0-9a-f]{64}$/.test(image))
  ) {
    throw new Error("every agent-run container image must be immutable");
  }
  if (
    pod.automountServiceAccountToken !== false ||
    account.automountServiceAccountToken !== false
  ) {
    throw new Error("agent run must not receive a Kubernetes service-account token");
  }
  if (JSON.stringify(resources).includes("hostPath")) {
    throw new Error("agent run must not mount host paths");
  }
  if (
    pod.volumes.some((volume) => volume.persistentVolumeClaim) ||
    JSON.stringify(pod).includes("codex-auth") ||
    JSON.stringify(pod).includes("model-api-key")
  ) {
    throw new Error("agent run must not mount a reusable model credential");
  }
  for (const resource of [account, job, job.spec.template, networkPolicy]) {
    if (
      resource.metadata.labels?.["codeops.example/agent-role"] !==
      input.role
    ) {
      throw new Error("every agent-run resource must carry the exact agent role");
    }
  }
  const runtimeContainers = pod.containers.filter((container) =>
    ["session-gateway", "coding-agent"].includes(container.name),
  );
  if (runtimeContainers.length !== 2) {
    throw new Error("agent run must contain the session gateway and coding agent");
  }
  for (const container of runtimeContainers) {
    const role = container.env?.find(
      (entry) => entry.name === "CODEOPS_AGENT_ROLE",
    );
    const workspace = container.volumeMounts?.find(
      (mount) => mount.name === "workspace",
    );
    if (role?.value !== input.role || !workspace) {
      throw new Error("runtime containers must receive the exact agent role");
    }
    if (
      workspace.readOnly !==
      (input.role === "qa-contract-researcher")
    ) {
      throw new Error("workspace mutability does not match the agent role");
    }
  }
  const agent = runtimeContainers.find((container) => container.name === "coding-agent");
  assertModelProxyRouting(agent, "http://codeops-model-proxy:8080");
  assertModelProxySessionVolume(pod, "session-gateway");
  const modelProxyTokenVolumes = pod.volumes.filter(
    (volume) => volume.name === "model-proxy-token",
  );
  const tokenProjectors = pod.containers.filter(
    (container) => container.name === "session-gateway",
  );
  const expectedTokenVolume = {
    name: "model-proxy-token",
    secret: {
      secretName: `codeops-run-${input.runId}`,
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
  const runSecretName = `codeops-run-${input.runId}`;
  const runInputVolumes = pod.volumes.filter((volume) => volume.name === "run-input");
  const expectedRunInputVolume = {
    name: "run-input",
    secret: {
      secretName: runSecretName,
      items: [{ key: "agent-prompt", path: "agent-prompt.txt" }],
    },
  };
  const tokenProjections = pod.volumes.filter((volume) =>
    secretProjections(volume).some(
      (projection) =>
        (projection.name === runSecretName &&
          (!Array.isArray(projection.items) || projection.items.length === 0)) ||
        projection.items?.some(
          (item) =>
            item.key === "model-proxy-token" || item.path === "model-proxy-token",
        ),
    ),
  );
  const secretVolumeNames = new Set(
    pod.volumes
      .filter((volume) => secretProjections(volume).length > 0)
      .map((volume) => volume.name),
  );
  const tokenVolumeNames = new Set(tokenProjections.map((volume) => volume.name));
  const allContainers = [...pod.initContainers, ...pod.containers];
  const expectedTokenMountPath = canonicalMountPath(expectedTokenMount.mountPath);
  const tokenMounts = allContainers.flatMap(
    (container) =>
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
  if (
    runInputVolumes.length !== 1 ||
    JSON.stringify(runInputVolumes[0]) !== JSON.stringify(expectedRunInputVolume) ||
    modelProxyTokenVolumes.length !== 1 ||
    JSON.stringify(modelProxyTokenVolumes[0]) !== JSON.stringify(expectedTokenVolume) ||
    tokenProjections.length !== 1 ||
    tokenProjections[0] !== modelProxyTokenVolumes[0] ||
    tokenMounts.length !== 1 ||
    tokenMounts[0]?.container !== "session-gateway" ||
    JSON.stringify(tokenMounts[0].mount) !== JSON.stringify(expectedTokenMount) ||
    tokenEnvironmentReferences.length !== 0 ||
    tokenProjectors.length !== 1 ||
    JSON.stringify(tokenProjectors[0]?.lifecycle) !== JSON.stringify(expectedLifecycle) ||
    agent.env?.find((entry) => entry.name === "CODEX_HOME")?.value !==
      "/var/lib/codeops-agent/codex-home" ||
    !agent.volumeMounts?.some((mount) =>
      mount.name === "workspace" &&
      mount.mountPath === "/var/lib/codeops-agent/codex-home" &&
      mount.subPath === ".codeops/codex-home" &&
      mount.readOnly === false
    )
  ) {
    throw new Error("agent run model proxy binding drifted");
  }
  return rendered;
}
