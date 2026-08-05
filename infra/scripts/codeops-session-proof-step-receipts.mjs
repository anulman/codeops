import { createHash } from "node:crypto";
import { verifySessionProofOperation } from "./codeops-session-proof-admission.mjs";
import { verifySessionProofApplyEvidence } from "./codeops-session-proof-apply-evidence.mjs";
import { verifySessionProofCodexLoginCompletionEvidence } from "./codeops-session-proof-codex-login-completion-evidence.mjs";
import { verifySessionProofCodexSmokeCompletionEvidence } from "./codeops-session-proof-codex-smoke-completion-evidence.mjs";
import { verifySessionProofCodexSmokeReplacementEvidence } from "./codeops-session-proof-codex-smoke-replacement-evidence.mjs";
import { verifySessionProofCredentialEvidence } from "./codeops-session-proof-credential-evidence.mjs";
import { verifySessionProofCredentialRevocationEvidence } from "./codeops-session-proof-credential-revocation-evidence.mjs";
import { verifySessionProofGatewayReadinessEvidence } from "./codeops-session-proof-gateway-readiness-evidence.mjs";
import { verifySessionProofGrantCompletionEvidence } from "./codeops-session-proof-grant-completion-evidence.mjs";
import { verifySessionProofReadinessEvidence } from "./codeops-session-proof-readiness-evidence.mjs";
import { verifySessionProofUiReadinessEvidence } from "./codeops-session-proof-ui-readiness-evidence.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const FIRST_EXECUTED_STEP = 2;
const LAST_EXECUTED_STEP = 19;

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

function assertCreationReceipt(receipt) {
  const admission = receipt?.admission;
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-namespace-create/v1" ||
    receipt.result !== "created-and-uid-bound" ||
    receipt.proceed !== true ||
    admission?.state !== "approved-bound" ||
    receipt.planSha256 !== admission.planSha256 ||
    receipt.namespace?.name !== admission.identity?.namespace ||
    receipt.namespace?.uid !== admission.namespaceUid
  ) {
    throw new Error("proof Namespace creation receipt does not admit execution");
  }
  return admission;
}

function assertPlan(plan, planSha256, admission) {
  if (
    plan?.apiVersion !== "codeops.renoconcierge.ca/session-proof-plan/v1" ||
    plan.admission !== "closed" ||
    plan.execution !== "render-and-review-only" ||
    planSha256 !== admission.planSha256 ||
    JSON.stringify(plan.identity) !== JSON.stringify(admission.identity) ||
    JSON.stringify(plan.sequence) !== JSON.stringify(sessionProofSequence())
  ) {
    throw new Error("reviewed proof plan or admission drifted");
  }
}

function assertPriorReceipt(receipt, expected) {
  if (
    receipt?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-receipt/v1" ||
    receipt.result !== "completed" ||
    receipt.proceed !== true ||
    receipt.planSha256 !== expected.planSha256 ||
    receipt.namespace?.name !== expected.namespace.name ||
    receipt.namespace?.uid !== expected.namespace.uid ||
    receipt.stepIndex !== expected.stepIndex ||
    receipt.stepId !== expected.step.id ||
    receipt.action !== expected.step.action ||
    receipt.artifact !== (expected.step.artifact ?? null) ||
    receipt.previousReceiptSha256 !== expected.previousReceiptSha256 ||
    !SHA256.test(receipt.evidenceSha256 ?? "") ||
    !RFC3339.test(receipt.checkedAt ?? "") ||
    (expected.artifactSha256 === null
      ? receipt.artifactSha256 !== null
      : receipt.artifactSha256 !== expected.artifactSha256)
  ) {
    throw new Error("proof step receipt chain drifted");
  }
}

function artifactDigest(plan, step, artifactSource) {
  if (!step.artifact) {
    if (artifactSource !== undefined && artifactSource !== null) {
      throw new Error("non-artifact proof step cannot receive manifest bytes");
    }
    return null;
  }
  if (typeof artifactSource !== "string") {
    throw new Error("artifact proof step requires the reviewed manifest bytes");
  }
  const expected = plan.artifacts?.find((artifact) => artifact.id === step.artifact);
  const actual = digest(artifactSource);
  if (!expected || expected.sha256 !== actual) {
    throw new Error("proof step artifact digest drifted");
  }
  return actual;
}

export function authorizeSessionProofStep(input) {
  const planSource = input.planSource ?? "";
  const creationReceiptSource = input.creationReceiptSource ?? "";
  const plan = parseJson(planSource, "proof plan");
  const creationReceipt = parseJson(
    creationReceiptSource,
    "proof Namespace creation receipt",
  );
  const admission = assertCreationReceipt(creationReceipt);
  const planSha256 = digest(planSource);
  assertPlan(plan, planSha256, admission);

  const priorSources = input.priorReceiptSources ?? [];
  if (!Array.isArray(priorSources) || priorSources.some((source) => typeof source !== "string")) {
    throw new Error("prior proof step receipts must be exact JSON byte strings");
  }
  if (priorSources.length > LAST_EXECUTED_STEP - FIRST_EXECUTED_STEP) {
    throw new Error("proof intermediate execution is already complete");
  }

  let previousReceiptSha256 = digest(creationReceiptSource);
  for (let offset = 0; offset < priorSources.length; offset += 1) {
    const stepIndex = FIRST_EXECUTED_STEP + offset;
    const step = plan.sequence[stepIndex];
    const artifact = step.artifact
      ? plan.artifacts.find((value) => value.id === step.artifact)
      : null;
    const receipt = parseJson(priorSources[offset], "proof step receipt");
    assertPriorReceipt(receipt, {
      planSha256,
      namespace: creationReceipt.namespace,
      stepIndex,
      step,
      previousReceiptSha256,
      artifactSha256: artifact?.sha256 ?? null,
    });
    previousReceiptSha256 = digest(priorSources[offset]);
  }

  const stepIndex = FIRST_EXECUTED_STEP + priorSources.length;
  const step = plan.sequence[stepIndex];
  if (!step || stepIndex > LAST_EXECUTED_STEP) {
    throw new Error("proof intermediate execution is already complete");
  }
  const artifactSha256 = artifactDigest(plan, step, input.artifactSource);
  verifySessionProofOperation(admission, {
    stepId: step.id,
    namespaceResource: input.namespaceResource,
    operator: input.operator,
    target: input.target,
    observedAt: input.observedAt,
  });

  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
    planSha256,
    admission,
    namespace: creationReceipt.namespace,
    stepIndex,
    stepId: step.id,
    action: step.action,
    artifact: step.artifact ?? null,
    artifactSha256,
    previousReceiptSha256,
    authorizedAt: input.observedAt,
  };
}

export function verifySessionProofStepAuthorization(authorization) {
  const expectedStep = sessionProofSequence()[authorization?.stepIndex];
  if (
    authorization?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-authorization/v1" ||
    !SHA256.test(authorization.planSha256 ?? "") ||
    !SHA256.test(authorization.previousReceiptSha256 ?? "") ||
    !Number.isInteger(authorization.stepIndex) ||
    authorization.stepIndex < FIRST_EXECUTED_STEP ||
    authorization.stepIndex > LAST_EXECUTED_STEP ||
    authorization.planSha256 !== authorization.admission?.planSha256 ||
    authorization.namespace?.name !== authorization.admission?.identity?.namespace ||
    authorization.namespace?.uid !== authorization.admission?.namespaceUid ||
    authorization.stepId !== expectedStep?.id ||
    authorization.action !== expectedStep?.action ||
    authorization.artifact !== (expectedStep?.artifact ?? null) ||
    (authorization.artifact === null
      ? authorization.artifactSha256 !== null
      : !SHA256.test(authorization.artifactSha256 ?? "")) ||
    !RFC3339.test(authorization.authorizedAt ?? "")
  ) {
    throw new Error("proof step authorization drifted");
  }
  return true;
}

export function completeSessionProofStep(authorization, input) {
  verifySessionProofStepAuthorization(authorization);
  const evidenceSource = input.evidenceSource ?? "";
  const evidence = parseJson(evidenceSource, "proof step evidence");
  if (
    !RFC3339.test(input.completedAt ?? "") ||
    evidence?.apiVersion !== "codeops.renoconcierge.ca/session-proof-step-evidence/v1" ||
    evidence.result !== "verified" ||
    evidence.planSha256 !== authorization.planSha256 ||
    evidence.stepId !== authorization.stepId ||
    evidence.namespace?.name !== authorization.namespace.name ||
    evidence.namespace?.uid !== authorization.namespace.uid ||
    !RFC3339.test(evidence.observedAt ?? "")
  ) {
    throw new Error("proof step authorization drifted");
  }
  if (["issue-broker-capabilities", "issue-runtime-capabilities"].includes(authorization.stepId)) {
    verifySessionProofCredentialEvidence(authorization, evidence);
  } else if (["start-database", "start-gateway", "grant-receipts", "codex-login", "start-ui"].includes(authorization.stepId)) {
    verifySessionProofApplyEvidence(authorization, evidence);
  } else if (authorization.stepId === "wait-database") {
    verifySessionProofReadinessEvidence(authorization, evidence);
  } else if (authorization.stepId === "wait-gateway-migration") {
    verifySessionProofGatewayReadinessEvidence(authorization, evidence);
  } else if (authorization.stepId === "wait-grants") {
    verifySessionProofGrantCompletionEvidence(authorization, evidence);
  } else if (authorization.stepId === "wait-codex-login") {
    verifySessionProofCodexLoginCompletionEvidence(authorization, evidence);
  } else if (authorization.stepId === "codex-smoke") {
    verifySessionProofCodexSmokeReplacementEvidence(authorization, evidence);
  } else if (authorization.stepId === "wait-codex-smoke") {
    verifySessionProofCodexSmokeCompletionEvidence(authorization, evidence);
  } else if (authorization.stepId === "wait-ui") {
    verifySessionProofUiReadinessEvidence(authorization, evidence);
  } else if (authorization.stepId === "revoke-capabilities") {
    verifySessionProofCredentialRevocationEvidence(authorization, evidence);
  } else if (
    JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify([
      "apiVersion", "namespace", "observedAt", "planSha256", "result", "stepId",
    ])
  ) {
    throw new Error("proof step evidence gained unreviewed fields");
  }
  verifySessionProofOperation(authorization.admission, {
    stepId: authorization.stepId,
    namespaceResource: input.namespaceResource,
    operator: input.operator,
    target: input.target,
    observedAt: input.completedAt,
  });
  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
    result: "completed",
    proceed: true,
    checkedAt: input.completedAt,
    planSha256: authorization.planSha256,
    namespace: authorization.namespace,
    stepIndex: authorization.stepIndex,
    stepId: authorization.stepId,
    action: authorization.action,
    artifact: authorization.artifact,
    artifactSha256: authorization.artifactSha256,
    previousReceiptSha256: authorization.previousReceiptSha256,
    evidenceSha256: digest(evidenceSource),
  };
}
