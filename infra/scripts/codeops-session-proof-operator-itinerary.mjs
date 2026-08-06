import { createHash } from "node:crypto";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const PLAN_VERSION = "codeops.renoconcierge.ca/session-proof-plan/v1";

const adapters = {
  "create-namespace": ["./codeops-session-proof-namespace-create.mjs", "createSessionProofNamespace"],
  "issue-broker-capabilities": [
    "./codeops-session-proof-credential-issuer.mjs",
    "issueFirstSessionProofCredentialsFromOperatorPacket",
  ],
  "issue-runtime-capabilities": ["./codeops-session-proof-credential-issuer.mjs", "issueSessionProofCredentials"],
  "start-database": ["./codeops-session-proof-database-apply.mjs", "applySessionProofDatabase"],
  "wait-database": ["./codeops-session-proof-database-wait.mjs", "waitForSessionProofDatabase"],
  "start-gateway": ["./codeops-session-proof-gateway-apply.mjs", "applySessionProofGateway"],
  "wait-gateway-migration": ["./codeops-session-proof-gateway-wait.mjs", "waitForSessionProofGatewayMigration"],
  "grant-receipts": ["./codeops-session-proof-grant-apply.mjs", "applySessionProofGrants"],
  "wait-grants": ["./codeops-session-proof-grant-wait.mjs", "waitForSessionProofGrants"],
  "codex-login": ["./codeops-session-proof-codex-login-apply.mjs", "applySessionProofCodexLogin"],
  "wait-codex-login": ["./codeops-session-proof-codex-login-wait.mjs", "waitForSessionProofCodexLogin"],
  "codex-smoke": ["./codeops-session-proof-codex-smoke-replace.mjs", "replaceSessionProofCodexSmoke"],
  "wait-codex-smoke": ["./codeops-session-proof-codex-smoke-wait.mjs", "waitForSessionProofCodexSmoke"],
  "start-ui": ["./codeops-session-proof-ui-apply.mjs", "applySessionProofUi"],
  "wait-ui": ["./codeops-session-proof-ui-wait.mjs", "waitForSessionProofUi"],
  "start-runtime": ["./codeops-session-proof-runtime-apply.mjs", "applySessionProofRuntime"],
  "wait-runtime": ["./codeops-session-proof-runtime-wait.mjs", "waitForSessionProofRuntime"],
  "record-proof": ["./codeops-session-proof-record.mjs", "completeSessionProofRecording"],
  "stop-runtime": ["./codeops-session-proof-runtime-stop.mjs", "stopSessionProofRuntime"],
  "revoke-capabilities": ["./codeops-session-proof-credential-revoker.mjs", "revokeSessionProofCredentials"],
  "delete-namespace": ["./codeops-session-proof-namespace-delete.mjs", "deleteSessionProofNamespace"],
};

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

function assertPlan(plan, planSource) {
  if (
    plan?.apiVersion !== PLAN_VERSION ||
    plan.admission !== "closed" ||
    plan.execution !== "render-and-review-only" ||
    JSON.stringify(plan.sequence) !== JSON.stringify(sessionProofSequence()) ||
    !Array.isArray(plan.artifacts) ||
    plan.artifacts.length !== 8
  ) {
    throw new Error("reviewed proof plan is not the exact closed sequence");
  }
  if (!SHA256.test(digest(planSource))) {
    throw new Error("reviewed proof plan digest is invalid");
  }
}

function verifyArtifacts(plan, artifactSources) {
  const expectedIds = plan.artifacts.map((artifact) => artifact.id).sort();
  if (JSON.stringify(Object.keys(artifactSources ?? {}).sort()) !== JSON.stringify(expectedIds)) {
    throw new Error("closed rehearsal artifact source set drifted");
  }
  return Object.fromEntries(plan.artifacts.map((artifact) => {
    const source = artifactSources[artifact.id];
    if (typeof source !== "string" || source.length < 2 || digest(source) !== artifact.sha256) {
      throw new Error(`closed rehearsal ${artifact.id} artifact bytes drifted`);
    }
    return [artifact.id, {
      input: `artifact:${artifact.id}`,
      sha256: artifact.sha256,
      bytes: Buffer.byteLength(source),
    }];
  }));
}

function outputSlots(stepId) {
  if (stepId === "review-namespace") return ["reviewed-plan"];
  if (stepId === "create-namespace") return ["namespace-creation-receipt"];
  return [`receipt:${stepId}`, `evidence:${stepId}`];
}

export function buildSessionProofOperatorItinerary(input) {
  const planSource = input.planSource ?? "";
  const plan = parseJson(planSource, "proof plan");
  assertPlan(plan, planSource);
  const artifacts = verifyArtifacts(plan, input.artifactSources);
  const receipts = [];
  const evidence = [];
  const steps = plan.sequence.map((step, stepIndex) => {
    const outputs = outputSlots(step.id);
    const adapter = adapters[step.id] ?? null;
    if (!["review-namespace", "verify-teardown"].includes(step.id) && !adapter) {
      throw new Error(`closed rehearsal adapter is missing for ${step.id}`);
    }
    const result = {
      stepIndex,
      stepId: step.id,
      action: step.action,
      adapter: adapter ? { module: adapter[0], export: adapter[1] } : null,
      emittedByStepId: step.id === "verify-teardown" ? "delete-namespace" : null,
      inputs: {
        plan: "reviewed-plan",
        admission: step.id === "review-namespace" ? null : "operator-admission",
        namespaceCreationReceipt: stepIndex >= 2 ? "namespace-creation-receipt" : null,
        artifact: step.artifact ? artifacts[step.artifact].input : null,
        priorReceiptSources: [...receipts],
        priorEvidenceSources: [...evidence],
        externalArtifacts: step.id === "record-proof"
          ? ["recording:raw-webm", "recording:playwright-trace", "recording:session-export", "recording:assertions"]
          : [],
      },
      outputs,
    };
    if (stepIndex >= 2) {
      receipts.push(`receipt:${step.id}`);
      evidence.push(`evidence:${step.id}`);
    }
    return result;
  });

  const tail = steps.slice(-3);
  if (
    tail[0].stepId !== "revoke-capabilities" ||
    tail[1].stepId !== "delete-namespace" ||
    tail[2].stepId !== "verify-teardown" ||
    !tail[1].inputs.priorReceiptSources.includes("receipt:revoke-capabilities") ||
    !tail[1].inputs.priorEvidenceSources.includes("evidence:revoke-capabilities") ||
    !tail[2].inputs.priorReceiptSources.includes("receipt:delete-namespace") ||
    !tail[2].inputs.priorEvidenceSources.includes("evidence:delete-namespace")
  ) {
    throw new Error("closed rehearsal teardown wiring drifted");
  }

  return {
    apiVersion: "codeops.renoconcierge.ca/session-proof-operator-itinerary/v1",
    mode: "closed-rehearsal",
    liveAccess: false,
    mutation: false,
    adapterInvocation: false,
    planSha256: digest(planSource),
    identity: plan.identity,
    artifacts,
    externalInputs: ["operator-admission", "recording:raw-webm", "recording:playwright-trace", "recording:session-export", "recording:assertions"],
    steps,
    finalOutputs: ["receipt:verify-teardown", "evidence:verify-teardown"],
  };
}
