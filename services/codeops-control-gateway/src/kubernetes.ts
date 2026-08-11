import { readFile } from "node:fs/promises";
import https from "node:https";

interface KubernetesResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly annotations?: Readonly<Record<string, string>>;
  };
}

const resourcePaths: Readonly<Record<string, string>> = {
  Secret: "api/v1/namespaces/{namespace}/secrets",
  ServiceAccount: "api/v1/namespaces/{namespace}/serviceaccounts",
  Job: "apis/batch/v1/namespaces/{namespace}/jobs",
  NetworkPolicy:
    "apis/networking.k8s.io/v1/namespaces/{namespace}/networkpolicies",
};

export interface KubernetesClient {
  ensure(resource: KubernetesResource, requestDigest: string): Promise<void>;
  getJob(name: string): Promise<Record<string, unknown>>;
  listRunPods(runId: string): Promise<readonly Record<string, unknown>[]>;
  getPodLogs(name: string, container: string): Promise<string>;
  delete(resource: KubernetesResource): Promise<void>;
}

export function createInClusterKubernetesClient(input: {
  namespace: string;
  host: string;
  port: number;
  token: string;
  ca: Buffer;
}): KubernetesClient {
  const request = async (
    method: string,
    requestPath: string,
    body?: unknown,
    expected: readonly number[] = [200],
  ): Promise<{ status: number; text: string }> => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: input.host,
          port: input.port,
          method,
          path: `/${requestPath}`,
          ca: input.ca,
          headers: {
            Authorization: `Bearer ${input.token}`,
            Accept: "application/json",
            ...(encoded
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": String(encoded.length),
                }
              : {}),
          },
          timeout: 30_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk) => {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 4_000_000) {
              req.destroy(new Error("Kubernetes response exceeded 4 MiB"));
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            if (!expected.includes(status)) {
              reject(new Error(`Kubernetes API ${method} ${requestPath} returned ${status}`));
              return;
            }
            resolve({ status, text });
          });
        },
      );
      req.once("timeout", () => req.destroy(new Error("Kubernetes API timeout")));
      req.once("error", reject);
      if (encoded) req.write(encoded);
      req.end();
    });
  };

  const collectionPath = (resource: KubernetesResource): string => {
    const template = resourcePaths[resource.kind];
    if (!template) throw new Error(`unsupported Kubernetes kind ${resource.kind}`);
    return template.replace("{namespace}", input.namespace);
  };

  return {
    async ensure(resource, requestDigest) {
      const collection = collectionPath(resource);
      const created = await request("POST", collection, resource, [201, 409]);
      if (created.status === 201) return;
      // Secret names are derived from the claimed request digest and Secrets
      // are immutable. Avoid granting the gateway read access to unrelated
      // namespace Secrets solely for restart reconciliation.
      if (resource.kind === "Secret") return;
      const existing = JSON.parse(
        (
          await request(
            "GET",
            `${collection}/${encodeURIComponent(resource.metadata.name)}`,
          )
        ).text,
      ) as KubernetesResource;
      if (
        existing.kind !== resource.kind ||
        existing.metadata.annotations?.[
          "codeops.example/request-digest"
        ] !== requestDigest
      ) {
        throw new Error("existing Kubernetes run resource identity drift");
      }
    },
    async getJob(name) {
      const response = await request(
        "GET",
        `apis/batch/v1/namespaces/${input.namespace}/jobs/${encodeURIComponent(name)}`,
      );
      return JSON.parse(response.text) as Record<string, unknown>;
    },
    async listRunPods(runId) {
      const selector = encodeURIComponent(
        `codeops.example/run-id=${runId}`,
      );
      const response = await request(
        "GET",
        `api/v1/namespaces/${input.namespace}/pods?labelSelector=${selector}`,
      );
      const list = JSON.parse(response.text) as { items?: unknown };
      if (!Array.isArray(list.items)) throw new Error("invalid Kubernetes Pod list");
      return list.items as readonly Record<string, unknown>[];
    },
    async getPodLogs(name, container) {
      return (
        await request(
          "GET",
          `api/v1/namespaces/${input.namespace}/pods/${encodeURIComponent(name)}/log?container=${encodeURIComponent(container)}`,
        )
      ).text;
    },
    async delete(resource) {
      await request(
        "DELETE",
        `${collectionPath(resource)}/${encodeURIComponent(resource.metadata.name)}`,
        { propagationPolicy: "Background" },
        [200, 202, 404],
      );
    },
  };
}

export async function loadInClusterKubernetesClient(
  namespace: string,
): Promise<KubernetesClient> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443");
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("in-cluster Kubernetes service identity is invalid");
  }
  return createInClusterKubernetesClient({
    namespace,
    host,
    port,
    token: (
      await readFile(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8",
      )
    ).trim(),
    ca: await readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
  });
}
