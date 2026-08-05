import { createHash } from "node:crypto";
import { request } from "node:https";
import { execFileSync } from "node:child_process";
import {
  readSessionProofKubeContext,
  readSessionProofNamespace,
} from "./codeops-session-proof-preflight.mjs";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofNamespaceDeleteReceipt,
  buildSessionProofTeardownReceipt,
  verifySessionProofRevocationPredecessor,
} from "./codeops-session-proof-teardown-evidence.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TLS_MATERIAL_BYTES = 128 * 1024;
const DELETE_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 3 * 60 * 1000;
const VERIFY_INTERVAL_MS = 1_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function decodeBase64(value, label) {
  if (!value || value.length > MAX_TLS_MATERIAL_BYTES * 2 || !BASE64.test(value)) {
    throw new Error(`${label} must be bounded inline base64 data`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.length > MAX_TLS_MATERIAL_BYTES ||
    decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  ) {
    throw new Error(`${label} must be valid bounded inline base64 data`);
  }
  return decoded;
}

function validateCreationReceipt(receipt) {
  const admission = receipt?.admission;
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-namespace-create/v1" ||
    ![
      "created-and-uid-bound",
      "namespace-uid-bound-create-incomplete",
    ].includes(receipt.result) ||
    admission?.state !== "approved-bound" ||
    receipt.planSha256 !== admission.planSha256 ||
    receipt.namespace?.name !== admission.identity?.namespace ||
    receipt.namespace?.uid !== admission.namespaceUid ||
    receipt.proceed !== (receipt.result === "created-and-uid-bound")
  ) {
    throw new Error("proof Namespace creation receipt drifted");
  }
  return admission;
}

export function readSessionProofKubeTlsConfig(expected, runner) {
  const source = runner(
    "kubectl",
    ["config", "view", "--minify", "--raw", "-o", "json"],
    {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 15_000,
    },
  );
  const config = parseJson(source, "raw Kubernetes client configuration");
  const cluster = config.clusters?.[0]?.cluster;
  const user = config.users?.[0]?.user;
  if (
    config.clusters?.length !== 1 ||
    config.users?.length !== 1 ||
    cluster?.server !== expected.target.server ||
    JSON.stringify(Object.keys(cluster ?? {}).sort()) !==
      JSON.stringify(["certificate-authority-data", "server"]) ||
    JSON.stringify(Object.keys(user ?? {}).sort()) !==
      JSON.stringify(["client-certificate-data", "client-key-data"])
  ) {
    throw new Error("raw Kubernetes client authentication or target drifted");
  }
  const ca = decodeBase64(cluster["certificate-authority-data"], "Kubernetes CA");
  const cert = decodeBase64(user["client-certificate-data"], "Kubernetes client certificate");
  const key = decodeBase64(user["client-key-data"], "Kubernetes client key");
  if (createHash("sha256").update(cert).digest("hex") !== expected.operator.credentialSha256) {
    throw new Error("raw Kubernetes client certificate drifted");
  }
  return { ca, cert, key };
}

export function createNamespaceDeleteRequest(input) {
  const body = JSON.stringify({
    apiVersion: "v1",
    kind: "DeleteOptions",
    propagationPolicy: "Foreground",
    preconditions: { uid: input.namespaceUid },
  });
  const path = `/api/v1/namespaces/${encodeURIComponent(input.namespace)}`;
  return { body, path };
}

export function requestNamespaceDeletion(input) {
  const server = new URL(input.target.server);
  const { body, path } = createNamespaceDeleteRequest(input);
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
          operation.destroy(new Error("Kubernetes delete response exceeded size bound"));
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
    operation.on("timeout", () => operation.destroy(new Error("Kubernetes delete request timed out")));
    operation.on("error", reject);
    operation.end(body);
  });
}

function assertDeleteResponse(response) {
  if (
    ![200, 202].includes(response?.statusCode) ||
    !/^application\/json(?:;|$)/i.test(response.contentType ?? "")
  ) {
    throw new Error(`UID-preconditioned Namespace deletion was rejected (${response?.statusCode ?? "no status"})`);
  }
  const status = parseJson(response.body, "Kubernetes delete response");
  if (
    status.kind !== "Status" ||
    status.apiVersion !== "v1" ||
    status.status !== "Success"
  ) {
    throw new Error("Kubernetes did not acknowledge Namespace deletion");
  }
}

export async function deleteSessionProofNamespace(
  input,
  dependencies = {},
) {
  const runner = dependencies.runner ?? execFileSync;
  const deleteRequest = dependencies.deleteRequest ?? requestNamespaceDeletion;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const receipt = typeof input.creationReceipt === "string"
    ? parseJson(input.creationReceipt, "proof Namespace creation receipt")
    : input.creationReceipt;
  const admission = validateCreationReceipt(receipt);
  const planSha256 = createHash("sha256").update(input.planSource ?? "").digest("hex");
  if (planSha256 !== admission.planSha256) {
    throw new Error("proof teardown plan digest drifted");
  }

  const observedAt = input.observedAt ?? now().toISOString();
  if (receipt.result === "created-and-uid-bound") {
    verifySessionProofRevocationPredecessor({
      planSha256,
      namespace: receipt.namespace,
      observedAt,
      revocationReceiptSource: input.revocationReceiptSource,
      revocationEvidenceSource: input.revocationEvidenceSource,
    });
  }
  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(admission.identity.namespace, runner);
  verifySessionProofOperation(admission, {
    stepId: "delete-namespace",
    namespaceResource,
    operator,
    target,
    observedAt,
  });
  const tls = readSessionProofKubeTlsConfig({ operator, target }, runner);
  const response = await deleteRequest({
    target,
    namespace: admission.identity.namespace,
    namespaceUid: admission.namespaceUid,
    ...tls,
  });
  assertDeleteResponse(response);
  const deletionAcceptedAt = now().toISOString();
  if (Date.parse(deletionAcceptedAt) < Date.parse(observedAt)) {
    throw new Error("proof Namespace deletion acknowledgement time drifted");
  }
  const deleteStep = receipt.result === "created-and-uid-bound"
    ? buildSessionProofNamespaceDeleteReceipt({
        planSha256,
        namespace: receipt.namespace,
        observedAt: deletionAcceptedAt,
        revocationReceiptSource: input.revocationReceiptSource,
        revocationEvidenceSource: input.revocationEvidenceSource,
        deletionAccepted: true,
      })
    : null;

  const deadline = now().getTime() + VERIFY_TIMEOUT_MS;
  while (true) {
    const current = readSessionProofNamespace(admission.identity.namespace, runner);
    if (current === null) break;
    if (current.metadata?.uid !== admission.namespaceUid) {
      throw new Error("proof Namespace identity changed while verifying teardown");
    }
    if (now().getTime() >= deadline) {
      return {
        apiVersion: "codeops.renoconcierge.ca/session-proof-namespace-delete/v1",
        result: "deletion-requested-absence-unconfirmed",
        checkedAt: now().toISOString(),
        planSha256,
        namespace: { name: admission.identity.namespace, uid: admission.namespaceUid },
        proceed: false,
        deleteEvidenceSource: deleteStep?.evidenceSource ?? null,
        deleteReceiptSource: deleteStep ? JSON.stringify(deleteStep.receipt) : null,
      };
    }
    await sleep(VERIFY_INTERVAL_MS);
  }

  const verifiedAt = now().toISOString();
  const finalContext = readSessionProofKubeContext(runner);
  verifySessionProofOperation(admission, {
    stepId: "verify-teardown",
    namespaceResource: readSessionProofNamespace(admission.identity.namespace, runner),
    operator: finalContext.operator,
    target: finalContext.target,
    observedAt: verifiedAt,
  });
  const teardownStep = deleteStep
    ? buildSessionProofTeardownReceipt({
        planSha256,
        namespace: receipt.namespace,
        observedAt: verifiedAt,
        deleteReceiptSource: JSON.stringify(deleteStep.receipt),
        deleteEvidenceSource: deleteStep.evidenceSource,
        namespaceAbsent: true,
      })
    : null;
  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-namespace-delete/v1",
    result: "deleted-and-absence-verified",
    checkedAt: verifiedAt,
    planSha256,
    namespace: { name: admission.identity.namespace, uid: admission.namespaceUid },
    proceed: true,
    deleteEvidenceSource: deleteStep?.evidenceSource ?? null,
    deleteReceiptSource: deleteStep ? JSON.stringify(deleteStep.receipt) : null,
    teardownEvidenceSource: teardownStep?.evidenceSource ?? null,
    teardownReceipt: teardownStep?.receipt ?? null,
  };
}
