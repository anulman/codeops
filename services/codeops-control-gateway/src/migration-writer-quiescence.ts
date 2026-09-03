import https from "node:https";
import { readFile } from "node:fs/promises";

export interface KubernetesMigrationRequest {
  (method: string, path: string, body?: unknown, contentType?: string):
    Promise<{ readonly status: number; readonly text: string }>;
}

interface QuiescenceClock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export type MigrationKubernetesOperation =
  "get-deployment" | "scale-deployment" | "list-pods";

export class MigrationKubernetesResponseError extends Error {
  readonly permanent = true;
  constructor(readonly operation: MigrationKubernetesOperation, readonly status: number,
    options?: ErrorOptions) {
    super(`Kubernetes migration ${operation} returned an invalid HTTP ${status} response`, options);
  }
}

const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const resourceName = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const uid = /^[!-~]{1,128}$/;

function object(text: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`Kubernetes ${description} response is not JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Kubernetes ${description} response is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function metadata(value: Record<string, unknown>, description: string): Record<string, unknown> {
  const result = value.metadata;
  const identity = result as Record<string, unknown> | undefined;
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      typeof identity?.name !== "string" || !resourceName.test(identity.name) ||
      typeof identity.namespace !== "string" || !dnsLabel.test(identity.namespace) ||
      typeof identity.uid !== "string" || !uid.test(identity.uid)) {
    throw new Error(`Kubernetes ${description} metadata is invalid`);
  }
  return identity;
}

export async function quiesceMigrationWriterDeployments(input: {
  readonly namespace: string;
  readonly deploymentNames: readonly string[];
  readonly request: KubernetesMigrationRequest;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly clock?: QuiescenceClock;
}): Promise<void> {
  if (!dnsLabel.test(input.namespace) || input.deploymentNames.length < 1 ||
      new Set(input.deploymentNames).size !== input.deploymentNames.length ||
      input.deploymentNames.some((name) => !dnsLabel.test(name))) {
    throw new Error("migration writer deployment identity is invalid");
  }
  const timeoutMs = input.timeoutMs ?? 180_000;
  const pollMs = input.pollMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 240_000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 5_000) {
    throw new Error("migration writer quiescence timing is invalid");
  }
  const clock = input.clock ?? {
    now: () => Date.now(),
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
  const base = `apis/apps/v1/namespaces/${input.namespace}/deployments`;
  const deploymentUids = new Map<string, string>();
  const classified = async <T>(operation: MigrationKubernetesOperation,
    request: Promise<{ readonly status: number; readonly text: string }>,
    validate: (text: string) => T): Promise<T> => {
    const response = await request;
    try {
      if (response.status !== 200) throw new Error("Kubernetes response status is invalid");
      return validate(response.text);
    }
    catch (error) {
      throw new MigrationKubernetesResponseError(operation, response.status, { cause: error });
    }
  };
  const exactDeployment = (text: string, name: string, expectedUid?: string) => {
    const deployment = object(text, "Deployment");
    const identity = metadata(deployment, "Deployment");
    if (deployment.apiVersion !== "apps/v1" || deployment.kind !== "Deployment" ||
        identity.name !== name || identity.namespace !== input.namespace ||
        (expectedUid !== undefined && identity.uid !== expectedUid)) {
      throw new Error(`migration writer Deployment ${name} identity drifted`);
    }
    return deployment;
  };
  for (const name of input.deploymentNames) {
    const path = `${base}/${encodeURIComponent(name)}`;
    const deployment = await classified("get-deployment", input.request("GET", path),
      (text) => exactDeployment(text, name));
    const deploymentMetadata = metadata(deployment, "Deployment");
    const uid = deploymentMetadata.uid as string;
    deploymentUids.set(name, uid);
    const patched = await classified("scale-deployment", input.request("PATCH", `${path}/scale`,
      { metadata: { uid }, spec: { replicas: 0 } },
      "application/merge-patch+json"), (text) => {
      const scale = object(text, "Deployment scale");
      const identity = metadata(scale, "Deployment scale");
      if (scale.apiVersion !== "autoscaling/v1" || scale.kind !== "Scale" ||
          identity.name !== name || identity.namespace !== input.namespace || identity.uid !== uid) {
        throw new Error(`migration writer Deployment ${name} scale identity drifted`);
      }
      return scale;
    });
    if ((patched.spec as Record<string, unknown> | undefined)?.replicas !== 0) {
      throw new Error(`migration writer Deployment ${name} did not accept quiescence`);
    }
  }

  const deadline = clock.now() + timeoutMs;
  for (;;) {
    let allStopped = true;
    for (const name of input.deploymentNames) {
      const path = `${base}/${encodeURIComponent(name)}`;
      const deployment = await classified("get-deployment", input.request("GET", path),
        (text) => exactDeployment(text, name, deploymentUids.get(name)));
      if ((deployment.spec as Record<string, unknown> | undefined)?.replicas !== 0) {
        throw new Error(`migration writer Deployment ${name} resumed during quiescence`);
      }
      const selector = encodeURIComponent(`app.kubernetes.io/name=${name}`);
      const pods = await classified("list-pods", input.request("GET",
        `api/v1/namespaces/${input.namespace}/pods?labelSelector=${selector}`), (text) => {
        const list = object(text, "Pod list");
        if (list.apiVersion !== "v1" || list.kind !== "PodList" || !Array.isArray(list.items)) {
          throw new Error("Kubernetes Pod list response is invalid");
        }
        for (const item of list.items) {
          if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Kubernetes Pod response is invalid");
          }
          const pod = item as Record<string, unknown>;
          const identity = metadata(pod, "Pod");
          if (pod.apiVersion !== "v1" || pod.kind !== "Pod" ||
              identity.namespace !== input.namespace) {
            throw new Error("Kubernetes Pod response identity is invalid");
          }
        }
        return list.items;
      });
      if (pods.length !== 0) allStopped = false;
    }
    if (allStopped) return;
    if (clock.now() >= deadline) {
      throw new Error("migration writers did not quiesce before the deadline");
    }
    await clock.sleep(pollMs);
  }
}

export function createKubernetesMigrationRequest(input: {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly ca: Buffer;
}): KubernetesMigrationRequest {
  return async (method, path, body, contentType = "application/json") => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: input.host, port: input.port, method,
        path: `/${path}`, ca: input.ca, timeout: 30_000, headers: {
          Authorization: `Bearer ${input.token}`, Accept: "application/json",
          ...(encoded ? { "Content-Type": contentType,
            "Content-Length": String(encoded.length) } : {}),
        } }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          const value = Buffer.from(chunk); bytes += value.length;
          if (bytes > 4_000_000) request.destroy(new Error("Kubernetes response exceeded 4 MiB"));
          else chunks.push(value);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`Kubernetes API ${method} ${path} returned ${status}`));
          } else resolve({ status, text: Buffer.concat(chunks).toString("utf8") });
        });
      });
      request.once("timeout", () => request.destroy(new Error("Kubernetes API timeout")));
      request.once("error", reject);
      if (encoded) request.write(encoded);
      request.end();
    });
  };
}

export async function quiesceInClusterMigrationWriters(input: {
  readonly namespace: string;
  readonly deploymentNames: readonly string[];
}): Promise<void> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443");
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("in-cluster Kubernetes service identity is invalid");
  }
  await quiesceMigrationWriterDeployments({ ...input,
    request: createKubernetesMigrationRequest({ host, port,
      token: (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim(),
      ca: await readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt") }) });
}
