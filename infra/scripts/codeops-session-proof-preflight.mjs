import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function runKubectl(args, runner) {
  return runner("kubectl", args, {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: 15_000,
  }).trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function certificateFingerprint(certificateData) {
  if (
    !certificateData ||
    certificateData.length > 128 * 1024 ||
    !BASE64.test(certificateData)
  ) {
    throw new Error("active Kubernetes client certificate data is required");
  }
  const certificate = Buffer.from(certificateData, "base64");
  if (
    certificate.length === 0 ||
    certificate.toString("base64").replace(/=+$/, "") !==
      certificateData.replace(/=+$/, "")
  ) {
    throw new Error("active Kubernetes client certificate data is invalid");
  }
  return createHash("sha256").update(certificate).digest("hex");
}

export function readSessionProofKubeContext(runner = execFileSync) {
  const context = runKubectl(["config", "current-context"], runner);
  const config = parseJson(
    runKubectl(["config", "view", "--minify", "-o", "json"], runner),
    "kubectl config view",
  );
  const server = config.clusters?.[0]?.cluster?.server;
  if (typeof server !== "string") {
    throw new Error("active Kubernetes API server is unavailable");
  }
  const whoami = parseJson(
    runKubectl(["auth", "whoami", "-o", "json"], runner),
    "kubectl auth whoami",
  );
  const certificateData = runKubectl([
    "config",
    "view",
    "--minify",
    "--raw",
    "-o",
    "jsonpath={.users[0].user.client-certificate-data}",
  ], runner);
  const operator = {
    username: whoami.status?.userInfo?.username,
    uid: whoami.status?.userInfo?.uid ?? null,
    credentialSha256: certificateFingerprint(certificateData),
  };
  return { operator, target: { context, server } };
}

export function readSessionProofNamespace(namespace, runner = execFileSync) {
  const namespaceSource = runKubectl([
    "get",
    "namespace",
    namespace,
    "-o",
    "json",
    "--ignore-not-found",
  ], runner);
  return namespaceSource
    ? parseJson(namespaceSource, "kubectl get namespace")
    : null;
}

export function runSessionProofPreflight(input, runner = execFileSync) {
  const planSha256 = createHash("sha256").update(input.planSource ?? "").digest("hex");
  if (planSha256 !== input.admission?.planSha256) {
    throw new Error("live preflight plan digest drifted");
  }
  const plan = parseJson(input.planSource, "proof plan");
  if (JSON.stringify(plan.identity) !== JSON.stringify(input.admission.identity)) {
    throw new Error("live preflight plan identity drifted");
  }

  const { operator, target } = readSessionProofKubeContext(runner);
  const namespaceResource = readSessionProofNamespace(
    input.admission.identity.namespace,
    runner,
  );

  verifySessionProofOperation(input.admission, {
    stepId: "create-namespace",
    namespaceResource,
    operator,
    target,
    observedAt: input.observedAt,
  });

  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-preflight/v1",
    result: "ready-for-reviewed-namespace-creation",
    checkedAt: input.observedAt,
    planSha256,
    identity: input.admission.identity,
    operator,
    target,
    namespace: { name: input.admission.identity.namespace, state: "absent" },
  };
}
