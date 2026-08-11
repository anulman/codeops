import { execFileSync } from "node:child_process";
import { request } from "node:https";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import { readSessionProofKubeTlsConfig } from "./codeops-session-proof-namespace-delete.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import {
  buildSessionProofRuntimeStopEvidence,
  verifySessionProofRuntimeStopPredecessor,
} from "./codeops-session-proof-runtime-stop-evidence.mjs";
import {
  completeSessionProofStep,
  verifySessionProofStepAuthorization,
} from "./codeops-session-proof-step-receipts.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DELETE_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 60_000;
const VERIFY_INTERVAL_MS = 500;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const RESOURCE_TYPES = new Map([
  ["batch/v1/Job", "job.batch"],
  ["networking.k8s.io/v1/NetworkPolicy", "networkpolicy.networking.k8s.io"],
  ["v1/ServiceAccount", "serviceaccount"],
]);

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function identity(resource) {
  return `${resource.apiVersion}/${resource.kind}/${resource.name}`;
}

function run(args, runner) {
  return runner("kubectl", args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 20_000,
  });
}

function readAndVerifyLiveIdentity(authorization, observedAt, runner) {
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(authorization.namespace.name, runner);
  verifySessionProofOperation(authorization.admission, {
    stepId: authorization.stepId,
    namespaceResource,
    operator,
    target,
    observedAt,
  });
  return { namespaceResource, operator, target };
}

function verifyExecutionTimes(authorization, startedAt, completedAt) {
  if (
    !RFC3339.test(startedAt ?? "") ||
    !RFC3339.test(completedAt ?? "") ||
    Date.parse(startedAt) < Date.parse(authorization.authorizedAt) ||
    Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    throw new Error("proof runtime stop timestamps drifted");
  }
}

function readResource(namespace, expected, runner) {
  const resourceType = RESOURCE_TYPES.get(`${expected.apiVersion}/${expected.kind}`);
  if (!resourceType) throw new Error("proof runtime stop resource type is not admitted");
  const source = run([
    "-n", namespace,
    "get", resourceType, expected.name,
    "-o", "json",
    "--ignore-not-found",
    "--request-timeout=15s",
  ], runner).trim();
  if (!source) return null;
  const resource = parseJson(source, `proof runtime stop ${expected.kind}`);
  if (
    resource.apiVersion !== expected.apiVersion ||
    resource.kind !== expected.kind ||
    resource.metadata?.name !== expected.name ||
    resource.metadata?.namespace !== namespace ||
    typeof resource.metadata?.uid !== "string" ||
    resource.metadata.uid.length === 0
  ) {
    throw new Error("proof runtime stop live resource identity drifted");
  }
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    uid: resource.metadata.uid,
  };
}

function readAndVerifyRetained(authorization, expected, runner) {
  const resources = expected.map((resource) =>
    readResource(authorization.namespace.name, resource, runner));
  if (
    resources.some((resource) => resource === null) ||
    JSON.stringify(resources.map(identity)) !== JSON.stringify(expected.map(identity)) ||
    JSON.stringify(resources.map((resource) => resource.uid)) !==
      JSON.stringify(expected.map((resource) => resource.uid))
  ) {
    throw new Error("proof runtime stop retained resource identity drifted");
  }
  return resources;
}

export function createRuntimeJobDeleteRequest(input) {
  return {
    path: `/apis/batch/v1/namespaces/${encodeURIComponent(input.namespace)}/jobs/${encodeURIComponent(input.name)}`,
    body: JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Foreground",
      preconditions: { uid: input.uid },
    }),
  };
}

export function requestRuntimeJobDeletion(input) {
  const server = new URL(input.target.server);
  const { path, body } = createRuntimeJobDeleteRequest(input);
  return new Promise((resolve, reject) => {
    const operation = request({
      protocol: server.protocol,
      hostname: server.hostname,
      port: server.port || 443,
      path,
      method: "DELETE",
      ca: input.ca,
      cert: input.cert,
      key: input.key,
      rejectUnauthorized: true,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
      timeout: DELETE_TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          operation.destroy(new Error("Kubernetes runtime Job delete response exceeded size bound"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        contentType: response.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    operation.on("timeout", () => operation.destroy(new Error("Kubernetes runtime Job delete request timed out")));
    operation.on("error", reject);
    operation.end(body);
  });
}

function assertDeleteResponse(response) {
  if (
    ![200, 202].includes(response?.statusCode) ||
    !/^application\/json(?:;|$)/i.test(response.contentType ?? "")
  ) {
    throw new Error(`UID-preconditioned runtime Job deletion was rejected (${response?.statusCode ?? "no status"})`);
  }
  const status = parseJson(response.body, "Kubernetes runtime Job delete response");
  if (status.kind !== "Status" || status.apiVersion !== "v1" || status.status !== "Success") {
    throw new Error("Kubernetes did not acknowledge runtime Job deletion");
  }
}

export async function stopSessionProofRuntime(input, dependencies = {}) {
  const runner = dependencies.runner ?? execFileSync;
  const deleteRequest = dependencies.deleteRequest ?? requestRuntimeJobDeletion;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "stop-runtime" ||
    authorization.action !== "operator-delete-exact-runtime-job" ||
    authorization.artifact !== null
  ) {
    throw new Error("proof step is not the exact runtime stop action");
  }
  verifyExecutionTimes(authorization, input.startedAt, input.completedAt);
  const predecessor = verifySessionProofRuntimeStopPredecessor(
    authorization,
    input.recordReceiptSource ?? "",
    input.recordEvidenceSource ?? "",
  );

  const live = readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  const job = readResource(authorization.namespace.name, predecessor.job, runner);
  if (!job || job.uid !== predecessor.job.uid) {
    throw new Error("proof runtime Job identity drifted before deletion");
  }
  readAndVerifyRetained(authorization, predecessor.retained, runner);
  const tls = readSessionProofKubeTlsConfig({ operator: live.operator, target: live.target }, runner);
  const response = await deleteRequest({
    target: live.target,
    namespace: authorization.namespace.name,
    name: predecessor.job.name,
    uid: predecessor.job.uid,
    ...tls,
  });
  assertDeleteResponse(response);

  const deadline = now().getTime() + VERIFY_TIMEOUT_MS;
  while (true) {
    const current = readResource(authorization.namespace.name, predecessor.job, runner);
    if (current === null) break;
    if (current.uid !== predecessor.job.uid) {
      throw new Error("proof runtime Job identity changed while verifying deletion");
    }
    if (now().getTime() >= deadline) {
      throw new Error("proof runtime Job absence was not verified");
    }
    await sleep(VERIFY_INTERVAL_MS);
  }

  const retainedResources = readAndVerifyRetained(authorization, predecessor.retained, runner);
  const finalLive = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  if (readResource(authorization.namespace.name, predecessor.job, runner) !== null) {
    throw new Error("proof runtime Job reappeared after final identity check");
  }
  const finalRetainedResources = readAndVerifyRetained(authorization, predecessor.retained, runner);
  if (JSON.stringify(finalRetainedResources) !== JSON.stringify(retainedResources)) {
    throw new Error("proof runtime retained identity drifted after final identity check");
  }
  const evidence = buildSessionProofRuntimeStopEvidence({
    authorization,
    recordReceiptSource: input.recordReceiptSource,
    recordEvidenceSource: input.recordEvidenceSource,
    runtimeJobAbsent: true,
    retainedResources: finalRetainedResources,
    observedAt: input.completedAt,
  });
  const evidenceSource = JSON.stringify(evidence);
  const receipt = completeSessionProofStep(authorization, {
    ...finalLive,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}
