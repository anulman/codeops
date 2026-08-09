import { createHash } from "node:crypto";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_WINDOW_MS = 4 * 60 * 60 * 1000;
const BOUNDED_IDENTITY = /^.{1,256}$/u;
const ARTIFACT_IDS = [
  "codex-login",
  "codex-smoke",
  "database",
  "gateway",
  "grants",
  "namespace",
  "runtime",
  "ui",
];

function parseTime(value, label) {
  if (!RFC3339.test(value ?? "")) throw new Error(`${label} must be RFC3339 UTC`);
  const milliseconds = Date.parse(value ?? "");
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be RFC3339 UTC`);
  return milliseconds;
}

function assertServer(value) {
  let server;
  try {
    server = new URL(value);
  } catch {
    throw new Error("Kubernetes server must be one HTTPS origin");
  }
  if (
    server.protocol !== "https:" ||
    server.username ||
    server.password ||
    server.pathname !== "/" ||
    server.search ||
    server.hash ||
    server.origin !== value
  ) {
    throw new Error("Kubernetes server must be one HTTPS origin");
  }
}

function assertPrincipal(actual, expected) {
  if (
    !actual ||
    actual.username !== expected.username ||
    actual.uid !== expected.uid ||
    actual.credentialSha256 !== expected.credentialSha256
  ) {
    throw new Error("authenticated operator principal drifted");
  }
}

function assertTarget(actual, expected) {
  if (
    !actual ||
    actual.context !== expected.context ||
    actual.server !== expected.server
  ) {
    throw new Error("Kubernetes target drifted");
  }
}

function assertWindow(admission, observedAt) {
  const observed = parseTime(observedAt, "observed time");
  const approved = parseTime(admission.approvedAt, "approval time");
  const expires = parseTime(admission.expiresAt, "expiry time");
  if (observed < approved || observed > expires) {
    throw new Error("proof admission is outside its approval window");
  }
}

function assertAdmissionShape(admission) {
  const expectedSteps = sessionProofSequence().map((step) => step.id);
  const expectedNamespace = `codeops-session-proof-${admission.identity?.runId ?? ""}`;
  const approved = parseTime(admission.approvedAt, "approval time");
  const expires = parseTime(admission.expiresAt, "expiry time");
  const isInitial = admission.apiVersion === "codeops.renoconcierge.ca/session-proof-admission/v1";
  const isRecovery = admission.apiVersion === "codeops.renoconcierge.ca/session-proof-recovery-admission/v1";
  if (
    (!isInitial && !isRecovery) ||
    !SHA256.test(admission.planSha256 ?? "") ||
    !RUN_ID.test(admission.identity?.runId ?? "") ||
    admission.identity?.namespace !== expectedNamespace ||
    expectedNamespace.length > 63 ||
    !SHA.test(admission.identity?.baseSha ?? "") ||
    !SUFFIX.test(admission.identity?.sessionSuffix ?? "") ||
    !BOUNDED_IDENTITY.test(admission.operator?.username ?? "") ||
    !(
      admission.operator?.uid === null ||
      BOUNDED_IDENTITY.test(admission.operator?.uid ?? "")
    ) ||
    !SHA256.test(admission.operator?.credentialSha256 ?? "") ||
    !BOUNDED_IDENTITY.test(admission.target?.context ?? "") ||
    expires <= approved ||
    expires - approved > MAX_WINDOW_MS
  ) {
    throw new Error("proof admission artifact drifted");
  }
  assertServer(admission.target.server);
  if (isInitial && JSON.stringify(admission.authorizedSteps) !== JSON.stringify(expectedSteps)) {
    throw new Error("proof admission authorized steps drifted");
  }
  if (isRecovery) {
    const predecessorIndex = expectedSteps.indexOf(admission.recovery?.predecessorStepId);
    if (
      admission.state !== "approved-bound" ||
      !BOUNDED_IDENTITY.test(admission.namespaceUid ?? "") ||
      !SHA256.test(admission.recovery?.sourceAdmissionSha256 ?? "") ||
      !SHA256.test(admission.recovery?.predecessorReceiptSha256 ?? "") ||
      predecessorIndex < 0 ||
      predecessorIndex === expectedSteps.length - 1 ||
      JSON.stringify(admission.authorizedSteps) !== JSON.stringify(expectedSteps.slice(predecessorIndex + 1))
    ) {
      throw new Error("proof recovery admission drifted");
    }
  }
  if (
    !(
      (admission.state === "approved-unbound" && admission.namespaceUid === null) ||
      (admission.state === "approved-bound" && BOUNDED_IDENTITY.test(admission.namespaceUid ?? ""))
    )
  ) {
    throw new Error("proof admission Namespace binding drifted");
  }
}

function parseExactJson(source, label) {
  if (typeof source !== "string" || source.length < 2 || source.length > 1024 * 1024) {
    throw new Error(`${label} must be bounded JSON source`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function assertNamespaceIdentity(admission, namespaceResource) {
  if (
    namespaceResource?.apiVersion !== "v1" ||
    namespaceResource?.kind !== "Namespace" ||
    namespaceResource.metadata?.name !== admission.identity.namespace
  ) {
    throw new Error("live proof Namespace identity drifted");
  }
  const labels = namespaceResource.metadata.labels ?? {};
  if (
    labels["app.kubernetes.io/part-of"] !== "codeops-session-proof" ||
    labels["codeops.renoconcierge.ca/proof-run"] !== admission.identity.runId ||
    labels["codeops.renoconcierge.ca/base-sha"] !== admission.identity.baseSha
  ) {
    throw new Error("live proof Namespace labels drifted");
  }
  if (!BOUNDED_IDENTITY.test(namespaceResource.metadata.uid ?? "")) {
    throw new Error("live proof Namespace UID is required");
  }
}

function assertAdmissionContext(admission, input) {
  assertAdmissionShape(admission);
  assertWindow(admission, input.observedAt);
  assertPrincipal(input.operator, admission.operator);
  assertTarget(input.target, admission.target);
}

export function createSessionProofAdmission(input) {
  const digest = createHash("sha256").update(input.planSource ?? "").digest("hex");
  if (!SHA256.test(input.reviewedPlanSha256 ?? "") || digest !== input.reviewedPlanSha256) {
    throw new Error("reviewed proof plan digest drifted");
  }
  let plan;
  try {
    plan = JSON.parse(input.planSource);
  } catch {
    throw new Error("proof plan must be valid JSON");
  }
  if (
    plan.apiVersion !== "codeops.renoconcierge.ca/session-proof-plan/v1" ||
    plan.admission !== "closed" ||
    plan.execution !== "render-and-review-only" ||
    JSON.stringify(plan.sequence) !== JSON.stringify(sessionProofSequence())
  ) {
    throw new Error("proof plan is not the reviewed closed-admission contract");
  }
  const expectedNamespace = `codeops-session-proof-${plan.identity?.runId ?? ""}`;
  if (
    !RUN_ID.test(plan.identity?.runId ?? "") ||
    plan.identity?.namespace !== expectedNamespace ||
    expectedNamespace.length > 63 ||
    !SHA.test(plan.identity?.baseSha ?? "") ||
    !SUFFIX.test(plan.identity?.sessionSuffix ?? "")
  ) {
    throw new Error("proof plan identity drifted");
  }
  const artifactIds = plan.artifacts?.map((artifact) => artifact.id).sort();
  if (
    !Array.isArray(plan.artifacts) ||
    plan.artifacts.length !== 8 ||
    JSON.stringify(artifactIds) !== JSON.stringify(ARTIFACT_IDS) ||
    plan.artifacts.some((artifact) => !SHA256.test(artifact.sha256 ?? ""))
  ) {
    throw new Error("proof plan artifact inventory drifted");
  }
  if (
    !BOUNDED_IDENTITY.test(input.operator?.username ?? "") ||
    !(
      input.operator?.uid === null ||
      BOUNDED_IDENTITY.test(input.operator?.uid ?? "")
    ) ||
    !SHA256.test(input.operator?.credentialSha256 ?? "")
  ) {
    throw new Error("authenticated operator and credential fingerprint are required");
  }
  if (
    !BOUNDED_IDENTITY.test(input.target?.context ?? "") ||
    !BOUNDED_IDENTITY.test(input.target?.server ?? "")
  ) {
    throw new Error("exact Kubernetes context and server are required");
  }
  assertServer(input.target.server);
  const approved = parseTime(input.approvedAt, "approval time");
  const expires = parseTime(input.expiresAt, "expiry time");
  if (expires <= approved || expires - approved > MAX_WINDOW_MS) {
    throw new Error("proof approval window must be positive and at most four hours");
  }

  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-admission/v1",
    state: "approved-unbound",
    planSha256: digest,
    identity: plan.identity,
    operator: {
      username: input.operator.username,
      uid: input.operator.uid,
      credentialSha256: input.operator.credentialSha256,
    },
    target: { context: input.target.context, server: input.target.server },
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
    namespaceUid: null,
    authorizedSteps: plan.sequence.map((step) => step.id),
  };
}

export function bindSessionProofNamespace(admission, input) {
  assertAdmissionShape(admission);
  if (admission.state !== "approved-unbound" || admission.namespaceUid !== null) {
    throw new Error("proof admission is not waiting for its Namespace UID");
  }
  assertAdmissionContext(admission, input);
  assertNamespaceIdentity(admission, input.namespaceResource);
  return {
    ...admission,
    state: "approved-bound",
    namespaceUid: input.namespaceResource.metadata.uid,
  };
}

export function recoverSessionProofAdmission(admission, input) {
  assertAdmissionShape(admission);
  if (
    admission.apiVersion !== "codeops.renoconcierge.ca/session-proof-admission/v1" ||
    admission.state !== "approved-bound"
  ) {
    throw new Error("proof recovery requires the original Namespace-UID-bound admission");
  }
  const sourceAdmission = parseExactJson(input.sourceAdmissionSource, "source proof admission");
  if (JSON.stringify(sourceAdmission) !== JSON.stringify(admission)) {
    throw new Error("source proof admission bytes do not match the bound admission");
  }
  assertPrincipal(input.operator, admission.operator);
  assertTarget(input.target, admission.target);
  assertNamespaceIdentity(admission, input.namespaceResource);
  if (input.namespaceResource.metadata.uid !== admission.namespaceUid) {
    throw new Error("live proof Namespace UID drifted");
  }

  const steps = sessionProofSequence().map((step) => step.id);
  const predecessorIndex = steps.indexOf(input.predecessorStepId);
  const predecessorReceipt = parseExactJson(
    input.predecessorReceiptSource,
    "proof predecessor receipt",
  );
  const predecessorStep = sessionProofSequence()[predecessorIndex];
  if (
    predecessorIndex < 0 ||
    predecessorIndex === steps.length - 1 ||
    predecessorReceipt.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-receipt/v1" ||
    predecessorReceipt.result !== "completed" ||
    predecessorReceipt.proceed !== true ||
    predecessorReceipt.planSha256 !== admission.planSha256 ||
    predecessorReceipt.namespace?.name !== admission.identity.namespace ||
    predecessorReceipt.namespace?.uid !== admission.namespaceUid ||
    predecessorReceipt.stepIndex !== predecessorIndex ||
    predecessorReceipt.stepId !== input.predecessorStepId ||
    predecessorReceipt.action !== predecessorStep?.action ||
    predecessorReceipt.artifact !== (predecessorStep?.artifact ?? null) ||
    !SHA256.test(predecessorReceipt.previousReceiptSha256 ?? "") ||
    !SHA256.test(predecessorReceipt.evidenceSha256 ?? "") ||
    !RFC3339.test(predecessorReceipt.checkedAt ?? "")
  ) {
    throw new Error("proof recovery predecessor drifted");
  }

  const sourceExpiry = parseTime(admission.expiresAt, "source admission expiry time");
  const approved = parseTime(input.approvedAt, "recovery approval time");
  const expires = parseTime(input.expiresAt, "recovery expiry time");
  if (
    approved < sourceExpiry ||
    expires <= approved ||
    expires - approved > MAX_WINDOW_MS
  ) {
    throw new Error("proof recovery window must start after source expiry and be positive and at most four hours");
  }

  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-recovery-admission/v1",
    state: "approved-bound",
    planSha256: admission.planSha256,
    identity: admission.identity,
    operator: admission.operator,
    target: admission.target,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
    namespaceUid: admission.namespaceUid,
    authorizedSteps: steps.slice(predecessorIndex + 1),
    recovery: {
      sourceAdmissionSha256: createHash("sha256")
        .update(input.sourceAdmissionSource)
        .digest("hex"),
      predecessorStepId: input.predecessorStepId,
      predecessorReceiptSha256: createHash("sha256")
        .update(input.predecessorReceiptSource)
        .digest("hex"),
    },
  };
}

export function verifySessionProofOperation(admission, input) {
  assertAdmissionContext(admission, input);
  if (!admission.authorizedSteps.includes(input.stepId)) {
    throw new Error("proof step is not admitted");
  }
  if (input.stepId === "create-namespace") {
    if (admission.state !== "approved-unbound" || input.namespaceResource !== null) {
      throw new Error("Namespace creation requires one unbound, absent target");
    }
    return true;
  }
  if (admission.state !== "approved-bound") {
    throw new Error("proof operation requires a Namespace-UID-bound admission");
  }
  if (input.stepId === "verify-teardown") {
    if (input.namespaceResource !== null) {
      throw new Error("proof Namespace remains after teardown");
    }
    return true;
  }
  assertNamespaceIdentity(admission, input.namespaceResource);
  if (input.namespaceResource.metadata.uid !== admission.namespaceUid) {
    throw new Error("live proof Namespace UID drifted");
  }
  return true;
}
