import { createHash } from "node:crypto";
import { request } from "node:https";
import { execFileSync } from "node:child_process";
import { parseAllDocuments, stringify } from "yaml";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import { sessionProofApplyResourceIdentities } from "./codeops-session-proof-apply-evidence.mjs";
import {
  buildSessionProofCodexSmokeReplacementEvidence,
  verifySessionProofCodexSmokePredecessor,
} from "./codeops-session-proof-codex-smoke-replacement-evidence.mjs";
import { readSessionProofKubeTlsConfig } from "./codeops-session-proof-namespace-delete.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
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
  ["v1/PersistentVolumeClaim", "persistentvolumeclaim"],
  ["v1/ServiceAccount", "serviceaccount"],
]);

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function identity(resource) {
  return `${resource.apiVersion}/${resource.kind}/${resource.name ?? resource.metadata?.name}`;
}

function run(args, runner, options = {}) {
  return runner("kubectl", args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 45_000,
    ...options,
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
    throw new Error("proof Codex smoke replacement timestamps drifted");
  }
}

function readResource(namespace, expected, runner) {
  const resourceType = RESOURCE_TYPES.get(`${expected.apiVersion}/${expected.kind}`);
  if (!resourceType) throw new Error("proof Codex smoke resource type is not admitted");
  const source = run([
    "-n", namespace,
    "get", resourceType, expected.name,
    "-o", "json",
    "--ignore-not-found",
    "--request-timeout=15s",
  ], runner).trim();
  if (!source) return null;
  const resource = parseJson(source, `proof Codex smoke ${expected.kind}`);
  if (
    resource.apiVersion !== expected.apiVersion ||
    resource.kind !== expected.kind ||
    resource.metadata?.name !== expected.name ||
    resource.metadata?.namespace !== namespace ||
    typeof resource.metadata?.uid !== "string" ||
    resource.metadata.uid.length === 0
  ) {
    throw new Error("proof Codex smoke live resource identity drifted");
  }
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    uid: resource.metadata.uid,
  };
}

function readSmokeInventory(authorization, runner) {
  return sessionProofApplyResourceIdentities("codex-smoke").map((expected) =>
    readResource(authorization.namespace.name, expected, runner));
}

function predecessorInventory(loginCompletionEvidence) {
  const applyEvidence = parseJson(
    loginCompletionEvidence.loginApplyEvidenceSource,
    "proof Codex login apply evidence",
  );
  return new Map(applyEvidence.resourceInventory.map((resource) => [identity(resource), resource.uid]));
}

function verifyBeforeReplacement(authorization, loginCompletionEvidence, runner) {
  const previous = predecessorInventory(loginCompletionEvidence);
  const loginJob = readResource(authorization.namespace.name, {
    apiVersion: "batch/v1", kind: "Job", name: "codeops-codex-auth-login",
  }, runner);
  const smokeInventory = readSmokeInventory(authorization, runner);
  const smokeJob = smokeInventory.find((resource) => resource?.kind === "Job");
  if (!loginJob || loginJob.uid !== previous.get("batch/v1/Job/codeops-codex-auth-login")) {
    throw new Error("proof Codex login Job identity drifted before replacement");
  }
  if (smokeJob) throw new Error("proof Codex smoke Job already exists");
  for (const resource of smokeInventory.filter((value) => value !== null)) {
    if (resource.kind === "Job") continue;
    if (resource.uid !== previous.get(identity(resource))) {
      throw new Error("proof Codex smoke retained resource identity drifted before replacement");
    }
  }
  if (smokeInventory.filter((value) => value !== null).length !== 3) {
    throw new Error("proof Codex smoke retained resource inventory is incomplete");
  }
  return loginJob.uid;
}

function smokeJobSource(manifestSource, authorization) {
  const documents = parseAllDocuments(manifestSource);
  if (documents.some((document) => document.errors.length > 0)) {
    throw new Error("reviewed proof Codex smoke manifest is invalid YAML");
  }
  const resources = documents.map((document) => document.toJS());
  const expected = sessionProofApplyResourceIdentities("codex-smoke");
  if (
    resources.length !== expected.length ||
    new Set(resources.map(identity)).size !== resources.length ||
    JSON.stringify(resources.map(identity).sort()) !== JSON.stringify(expected.map(identity).sort()) ||
    resources.some((resource) => resource.metadata?.namespace !== authorization.namespace.name)
  ) {
    throw new Error("reviewed proof Codex smoke manifest resource set drifted");
  }
  const job = resources.find((resource) => resource.kind === "Job");
  return stringify(job);
}

export function createCodexLoginJobDeleteRequest(input) {
  return {
    path: `/apis/batch/v1/namespaces/${encodeURIComponent(input.namespace)}/jobs/codeops-codex-auth-login`,
    body: JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Foreground",
      preconditions: { uid: input.uid },
    }),
  };
}

export function requestCodexLoginJobDeletion(input) {
  const server = new URL(input.target.server);
  const { path, body } = createCodexLoginJobDeleteRequest(input);
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
          operation.destroy(new Error("Kubernetes Job delete response exceeded size bound"));
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
    operation.on("timeout", () => operation.destroy(new Error("Kubernetes Job delete request timed out")));
    operation.on("error", reject);
    operation.end(body);
  });
}

function assertDeleteResponse(response) {
  if (
    ![200, 202].includes(response?.statusCode) ||
    !/^application\/json(?:;|$)/i.test(response.contentType ?? "")
  ) {
    throw new Error(`UID-preconditioned Codex login Job deletion was rejected (${response?.statusCode ?? "no status"})`);
  }
  const status = parseJson(response.body, "Kubernetes Codex login Job delete response");
  if (status.kind !== "Status" || status.apiVersion !== "v1" || status.status !== "Success") {
    throw new Error("Kubernetes did not acknowledge Codex login Job deletion");
  }
}

export async function replaceSessionProofCodexSmoke(input, dependencies = {}) {
  const runner = dependencies.runner ?? execFileSync;
  const deleteRequest = dependencies.deleteRequest ?? requestCodexLoginJobDeletion;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "codex-smoke" ||
    authorization.action !== "operator-replace-auth-job" ||
    authorization.artifact !== "codex-smoke"
  ) {
    throw new Error("proof step is not the exact Codex smoke replacement action");
  }
  verifyExecutionTimes(authorization, input.startedAt, input.completedAt);
  const manifestSource = input.manifestSource ?? "";
  if (digest(manifestSource) !== authorization.artifactSha256) {
    throw new Error("reviewed proof Codex smoke manifest digest drifted");
  }
  const jobSource = smokeJobSource(manifestSource, authorization);
  const loginCompletionEvidence = verifySessionProofCodexSmokePredecessor(
    authorization,
    input.loginCompletionReceiptSource ?? "",
    input.loginCompletionEvidenceSource ?? "",
  );

  const live = readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  if (input.resumeAfterLoginDeletion === true) {
    if (readResource(authorization.namespace.name, {
      apiVersion: "batch/v1", kind: "Job", name: "codeops-codex-auth-login",
    }, runner) !== null) {
      throw new Error("proof Codex login Job still exists during replacement recovery");
    }
  } else {
    const loginJobUid = verifyBeforeReplacement(authorization, loginCompletionEvidence, runner);
    const tls = readSessionProofKubeTlsConfig({ operator: live.operator, target: live.target }, runner);
    const response = await deleteRequest({
      target: live.target,
      namespace: authorization.namespace.name,
      uid: loginJobUid,
      ...tls,
    });
    assertDeleteResponse(response);

    const deadline = now().getTime() + VERIFY_TIMEOUT_MS;
    while (readResource(authorization.namespace.name, {
      apiVersion: "batch/v1", kind: "Job", name: "codeops-codex-auth-login",
    }, runner) !== null) {
      if (now().getTime() >= deadline) {
        throw new Error("proof Codex login Job absence was not verified");
      }
      await sleep(VERIFY_INTERVAL_MS);
    }
  }

  readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  const beforeCreate = readSmokeInventory(authorization, runner);
  if (beforeCreate.find((resource) => resource?.kind === "Job")) {
    throw new Error("proof Codex smoke Job appeared before creation");
  }
  if (beforeCreate.filter((resource) => resource !== null).length !== 3) {
    throw new Error("proof Codex smoke retained resource inventory changed after deletion");
  }
  const previous = predecessorInventory(loginCompletionEvidence);
  for (const resource of beforeCreate.filter((value) => value !== null)) {
    if (resource.uid !== previous.get(identity(resource))) {
      throw new Error("proof Codex smoke retained resource identity drifted after deletion");
    }
  }

  run([
    "-n", authorization.namespace.name,
    "create", "--filename", "-",
    "--request-timeout=30s",
  ], runner, { input: jobSource });

  const resources = readSmokeInventory(authorization, runner);
  if (resources.some((resource) => resource === null)) {
    throw new Error("proof Codex smoke replacement package is incomplete");
  }
  const finalLive = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const finalResources = readSmokeInventory(authorization, runner);
  if (
    finalResources.some((resource) => resource === null) ||
    JSON.stringify(finalResources) !== JSON.stringify(resources) ||
    readResource(authorization.namespace.name, {
      apiVersion: "batch/v1", kind: "Job", name: "codeops-codex-auth-login",
    }, runner) !== null
  ) {
    throw new Error("proof Codex smoke replacement identity drifted after final identity check");
  }
  const evidence = buildSessionProofCodexSmokeReplacementEvidence({
    authorization,
    loginCompletionReceiptSource: input.loginCompletionReceiptSource,
    loginCompletionEvidenceSource: input.loginCompletionEvidenceSource,
    resources: finalResources,
    loginJobAbsent: true,
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
