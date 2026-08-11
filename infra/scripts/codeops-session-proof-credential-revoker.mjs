import { createHash } from "node:crypto";
import { request } from "node:https";
import { execFileSync } from "node:child_process";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import {
  sessionProofCredentialNames,
  buildSessionProofCredentialRevocationEvidence,
} from "./codeops-session-proof-credential-revocation-evidence.mjs";
import { verifySessionProofCredentialEvidence } from "./codeops-session-proof-credential-evidence.mjs";
import { verifySessionProofRuntimeStopEvidence } from "./codeops-session-proof-runtime-stop-evidence.mjs";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { readSessionProofKubeTlsConfig } from "./codeops-session-proof-namespace-delete.mjs";
import {
  completeSessionProofStep,
  verifySessionProofStepAuthorization,
} from "./codeops-session-proof-step-receipts.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DELETE_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 60_000;
const VERIFY_INTERVAL_MS = 500;
const MAX_SOURCE_BYTES = 64 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function readCredentialUid(namespace, name, runner) {
  return runner("kubectl", [
    "-n", namespace,
    "get", "secret", name,
    "-o", "jsonpath={.metadata.uid}",
    "--ignore-not-found",
    "--request-timeout=15s",
  ], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 15_000,
  }).trim() || null;
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
    throw new Error("proof credential revocation timestamps drifted");
  }
}

function verifyRuntimeStopPredecessor(authorization, receiptSource, evidenceSource) {
  if (
    typeof receiptSource !== "string" ||
    Buffer.byteLength(receiptSource) > MAX_SOURCE_BYTES ||
    typeof evidenceSource !== "string" ||
    Buffer.byteLength(evidenceSource) > MAX_SOURCE_BYTES ||
    digest(receiptSource) !== authorization.previousReceiptSha256
  ) {
    throw new Error("proof credential revocation runtime-stop predecessor drifted");
  }
  const receipt = parseJson(receiptSource, "proof runtime-stop receipt");
  if (
    receipt?.apiVersion !== "codeops.example/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== authorization.planSha256 ||
    JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
    receipt.stepIndex !== authorization.stepIndex - 1 ||
    receipt.stepId !== "stop-runtime" ||
    receipt.action !== "operator-delete-exact-runtime-job" ||
    receipt.artifact !== null ||
    receipt.artifactSha256 !== null ||
    receipt.evidenceSha256 !== digest(evidenceSource)
  ) {
    throw new Error("proof credential revocation runtime-stop receipt drifted");
  }
  const stopAuthorization = {
    planSha256: authorization.planSha256,
    stepIndex: receipt.stepIndex,
    stepId: receipt.stepId,
    action: receipt.action,
    artifact: receipt.artifact,
    artifactSha256: receipt.artifactSha256,
    namespace: authorization.namespace,
    admission: authorization.admission,
    previousReceiptSha256: receipt.previousReceiptSha256,
  };
  const evidence = parseJson(evidenceSource, "proof runtime-stop evidence");
  verifySessionProofRuntimeStopEvidence(stopAuthorization, evidence);
  return evidence;
}

function verifyIssuanceChain(authorization, receiptSources, evidenceSources, runtimeStopEvidenceSource) {
  const expectedPriorCount = authorization.stepIndex - 2;
  if (
    !Array.isArray(receiptSources) ||
    receiptSources.length !== expectedPriorCount ||
    receiptSources.some((source) => typeof source !== "string") ||
    !Array.isArray(evidenceSources) ||
    evidenceSources.length !== 2 ||
    evidenceSources.some((source) => typeof source !== "string")
  ) {
    throw new Error("exact prior receipts and two issuance evidence artifacts are required");
  }
  if (digest(receiptSources.at(-1)) !== authorization.previousReceiptSha256) {
    throw new Error("proof credential revocation predecessor receipt drifted");
  }
  const runtimeStopEvidence = verifyRuntimeStopPredecessor(
    authorization,
    receiptSources.at(-1),
    runtimeStopEvidenceSource,
  );

  const sequence = sessionProofSequence();
  for (let index = receiptSources.length - 1; index >= 1; index -= 1) {
    const receipt = parseJson(receiptSources[index], "proof step receipt");
    if (receipt.previousReceiptSha256 !== digest(receiptSources[index - 1])) {
      throw new Error("proof credential revocation receipt chain drifted");
    }
  }

  const credentials = new Map();
  for (let index = 0; index < receiptSources.length; index += 1) {
    const receipt = parseJson(receiptSources[index], "proof step receipt");
    const stepIndex = index + 2;
    const step = sequence[stepIndex];
    if (
      receipt?.apiVersion !== "codeops.example/session-proof-step-receipt/v1" ||
      receipt.result !== "completed" ||
      receipt.proceed !== true ||
      receipt.planSha256 !== authorization.planSha256 ||
      JSON.stringify(receipt.namespace) !== JSON.stringify(authorization.namespace) ||
      receipt.stepIndex !== stepIndex ||
      receipt.stepId !== step?.id ||
      receipt.action !== step?.action
    ) {
      throw new Error("proof credential revocation receipt identity drifted");
    }
    if (index >= 2) continue;
    const evidenceSource = evidenceSources[index];
    if (receipt.evidenceSha256 !== digest(evidenceSource)) {
      throw new Error("proof credential issuance evidence digest drifted");
    }
    const evidence = parseJson(evidenceSource, "proof credential issuance evidence");
    verifySessionProofCredentialEvidence({
      planSha256: authorization.planSha256,
      stepId: receipt.stepId,
      namespace: authorization.namespace,
    }, evidence);
    for (const secret of evidence.credentialInventory) {
      if (credentials.has(secret.name)) {
        throw new Error("proof credential issuance UID inventory drifted");
      }
      credentials.set(secret.name, secret.uid);
    }
  }

  const expectedNames = sessionProofCredentialNames();
  if (
    credentials.size !== expectedNames.length ||
    JSON.stringify([...credentials.keys()].sort()) !== JSON.stringify(expectedNames)
  ) {
    throw new Error("proof credential issuance UID inventory drifted");
  }
  return { credentials, runtimeStopEvidence };
}

export function createCredentialDeleteRequest(input) {
  return {
    path: `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/secrets/${encodeURIComponent(input.name)}`,
    body: JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: input.uid },
    }),
  };
}

export function requestCredentialDeletion(input) {
  const server = new URL(input.target.server);
  const { path, body } = createCredentialDeleteRequest(input);
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
          operation.destroy(new Error("Kubernetes Secret delete response exceeded size bound"));
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
    operation.on("timeout", () => operation.destroy(new Error("Kubernetes Secret delete request timed out")));
    operation.on("error", reject);
    operation.end(body);
  });
}

function assertDeleteResponse(response, name) {
  if (
    ![200, 202].includes(response?.statusCode) ||
    !/^application\/json(?:;|$)/i.test(response.contentType ?? "")
  ) {
    throw new Error(`UID-preconditioned Secret deletion was rejected for ${name} (${response?.statusCode ?? "no status"})`);
  }
  const status = parseJson(response.body, "Kubernetes Secret delete response");
  if (status.kind !== "Status" || status.apiVersion !== "v1" || status.status !== "Success") {
    throw new Error(`Kubernetes did not acknowledge Secret deletion for ${name}`);
  }
}

export async function revokeSessionProofCredentials(input, dependencies = {}) {
  const runner = dependencies.runner ?? execFileSync;
  const deleteRequest = dependencies.deleteRequest ?? requestCredentialDeletion;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const authorization = input.authorization;
  verifySessionProofStepAuthorization(authorization);
  if (
    authorization.stepId !== "revoke-capabilities" ||
    authorization.action !== "operator-revoke-exact-secrets"
  ) {
    throw new Error("proof step is not exact credential revocation");
  }
  verifyExecutionTimes(authorization, input.startedAt, input.completedAt);
  const predecessor = verifyIssuanceChain(
    authorization,
    input.priorReceiptSources,
    input.issuanceEvidenceSources,
    input.runtimeStopEvidenceSource,
  );
  if (Date.parse(input.startedAt) < Date.parse(predecessor.runtimeStopEvidence.observedAt)) {
    throw new Error("proof credential revocation started before runtime stop completed");
  }
  const issuedUids = predecessor.credentials;

  const live = readAndVerifyLiveIdentity(authorization, input.startedAt, runner);
  const tls = readSessionProofKubeTlsConfig({ operator: live.operator, target: live.target }, runner);
  for (const name of sessionProofCredentialNames()) {
    const expectedUid = issuedUids.get(name);
    const currentUid = readCredentialUid(authorization.namespace.name, name, runner);
    if (currentUid === null) continue;
    if (currentUid !== expectedUid) {
      throw new Error(`proof credential UID drifted before revocation: ${name}`);
    }
    const response = await deleteRequest({
      target: live.target,
      namespace: authorization.namespace.name,
      name,
      uid: expectedUid,
      ...tls,
    });
    assertDeleteResponse(response, name);
  }

  const deadline = now().getTime() + VERIFY_TIMEOUT_MS;
  while (true) {
    const remaining = sessionProofCredentialNames().filter((name) =>
      readCredentialUid(authorization.namespace.name, name, runner) !== null);
    if (remaining.length === 0) break;
    if (now().getTime() >= deadline) {
      throw new Error(`proof credential absence was not verified: ${remaining.join(", ")}`);
    }
    await sleep(VERIFY_INTERVAL_MS);
  }

  const finalLive = readAndVerifyLiveIdentity(authorization, input.completedAt, runner);
  const finalRemaining = sessionProofCredentialNames().filter((name) =>
    readCredentialUid(authorization.namespace.name, name, runner) !== null);
  if (finalRemaining.length > 0) {
    throw new Error(`proof credential absence drifted after final identity check: ${finalRemaining.join(", ")}`);
  }
  const evidence = buildSessionProofCredentialRevocationEvidence({
    authorization,
    observedAt: input.completedAt,
    absentCredentialNames: sessionProofCredentialNames(),
  });
  const evidenceSource = JSON.stringify(evidence);
  const receipt = completeSessionProofStep(authorization, {
    ...finalLive,
    completedAt: input.completedAt,
    evidenceSource,
  });
  return { evidenceSource, receipt };
}
