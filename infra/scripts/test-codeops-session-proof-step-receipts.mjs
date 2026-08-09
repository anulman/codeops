import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  bindSessionProofNamespace,
  createSessionProofAdmission,
  recoverSessionProofAdmission,
} from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofCredentialEvidence } from "./codeops-session-proof-credential-evidence.mjs";
import {
  buildSessionProofCredentialRevocationEvidence,
  sessionProofCredentialNames,
} from "./codeops-session-proof-credential-revocation-evidence.mjs";
import { buildSessionProofReadinessEvidence } from "./codeops-session-proof-readiness-evidence.mjs";
import {
  buildSessionProofGatewayReadinessEvidence,
  sessionProofGatewayMigrationRelation,
} from "./codeops-session-proof-gateway-readiness-evidence.mjs";
import { buildSessionProofGrantCompletionEvidence } from "./codeops-session-proof-grant-completion-evidence.mjs";
import { buildSessionProofCodexLoginCompletionEvidence } from "./codeops-session-proof-codex-login-completion-evidence.mjs";
import { buildSessionProofCodexSmokeCompletionEvidence } from "./codeops-session-proof-codex-smoke-completion-evidence.mjs";
import { buildSessionProofCodexSmokeReplacementEvidence } from "./codeops-session-proof-codex-smoke-replacement-evidence.mjs";
import { buildSessionProofUiReadinessEvidence } from "./codeops-session-proof-ui-readiness-evidence.mjs";
import { buildSessionProofRuntimeReadinessEvidence } from "./codeops-session-proof-runtime-readiness-evidence.mjs";
import { buildSessionProofRecordEvidence } from "./codeops-session-proof-record-evidence.mjs";
import { buildSessionProofRuntimeStopEvidence } from "./codeops-session-proof-runtime-stop-evidence.mjs";
import { authorizeSessionProofStep, completeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "1".repeat(40),
  sessionSuffix: "video-1",
};
const operator = { username: "kubernetes-admin", uid: null, credentialSha256: "9".repeat(64) };
const target = { context: "k3s", server: "https://127.0.0.1:6443" };
const namespaceResource = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: {
    name: identity.namespace,
    uid: "namespace-uid-1",
    labels: {
      "app.kubernetes.io/part-of": "codeops-session-proof",
      "codeops.renoconcierge.ca/proof-run": identity.runId,
      "codeops.renoconcierge.ca/base-sha": identity.baseSha,
    },
  },
};
const artifacts = ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
  .map((id) => ({ id, sha256: createHash("sha256").update(`${id}\n`).digest("hex") }));
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts,
  sequence: sessionProofSequence(),
});
const planSha256 = createHash("sha256").update(planSource).digest("hex");
const unbound = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: planSha256,
  operator,
  target,
  approvedAt: "2026-08-05T18:00:00Z",
  expiresAt: "2026-08-05T20:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource,
  operator,
  target,
  observedAt: "2026-08-05T18:01:00Z",
});
const creationReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-namespace-create/v1",
  result: "created-and-uid-bound",
  checkedAt: "2026-08-05T18:01:00Z",
  planSha256,
  namespaceManifestSha256: artifacts.find((value) => value.id === "namespace").sha256,
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  proceed: true,
  admission,
});

function authorize(overrides = {}) {
  return authorizeSessionProofStep({
    planSource,
    creationReceiptSource,
    priorReceiptSources: [],
    namespaceResource,
    operator,
    target,
    observedAt: "2026-08-05T18:02:00Z",
    ...overrides,
  });
}

function evidenceSource(authorization, observedAt, context = {}) {
  const credentialContracts = authorization.stepId === "issue-broker-capabilities"
    ? {
        "codeops-session-proof-database-owner": ["database", "password", "username"],
        "codeops-session-broker-database": ["database-url"],
        "codeops-session-broker-read-auth": ["token"],
        "codeops-session-broker-write-auth": ["token"],
        "codeops-session-runtime-worker-auth": ["token"],
        "codeops-session-job-initialization-auth": ["token"],
        "codeops-session-runtime-worker-database": ["database-url", "password"],
      }
    : authorization.stepId === "issue-runtime-capabilities"
      ? {
          "ghcr-renoconcierge": [".dockerconfigjson"],
          "codeops-agent-source-credentials": ["repository-read-token"],
        }
      : null;
  if (credentialContracts) {
    const runtime = authorization.stepId === "issue-runtime-capabilities";
    return JSON.stringify(buildSessionProofCredentialEvidence({
      authorization,
      observedAt,
      secrets: Object.entries(credentialContracts).map(([name, dataKeys], index) => ({
        name,
        namespace: authorization.namespace.name,
        uid: `secret-uid-${authorization.stepIndex}-${index}`,
        type: name === "ghcr-renoconcierge" ? "kubernetes.io/dockerconfigjson" : "Opaque",
        dataKeys,
        labels: {
          "app.kubernetes.io/part-of": "codeops-session-proof",
          "codeops.renoconcierge.ca/credential-scope": runtime
            ? "session-video-proof-runtime"
            : "session-video-proof",
        },
      })),
    }));
  }
  if (authorization.stepId === "revoke-capabilities") {
    return JSON.stringify(buildSessionProofCredentialRevocationEvidence({
      authorization,
      observedAt,
      absentCredentialNames: sessionProofCredentialNames(),
    }));
  }
  if (authorization.stepId === "start-database") {
    return JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt,
      resources: sessionProofApplyResourceIdentities("start-database").map((resource, index) => ({
        ...resource,
        uid: `database-resource-uid-${index}`,
      })),
    }));
  }
  if (authorization.stepId === "start-gateway") {
    return JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt,
      resources: sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
        ...resource,
        uid: `gateway-resource-uid-${index}`,
      })),
    }));
  }
  if (authorization.stepId === "grant-receipts") {
    return JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt,
      resources: sessionProofApplyResourceIdentities("grant-receipts").map((resource, index) => ({
        ...resource,
        uid: `grant-resource-uid-${index}`,
      })),
    }));
  }
  if (authorization.stepId === "codex-login") {
    return JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt,
      resources: sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
        ...resource,
        uid: `codex-login-resource-uid-${index}`,
      })),
    }));
  }
  if (authorization.stepId === "start-ui") {
    return JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt,
      resources: sessionProofApplyResourceIdentities("start-ui").map((resource, index) => ({
        ...resource,
        uid: `ui-resource-uid-${index}`,
      })),
    }));
  }
  if (authorization.stepId === "wait-ui") {
    return JSON.stringify(buildSessionProofUiReadinessEvidence({
      authorization,
      uiApplyReceiptSource: context.priorReceiptSources?.at(-1),
      uiApplyEvidenceSource: context.priorEvidenceSources?.at(-1),
      deployment: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "codeops-agents-ui",
          namespace: authorization.namespace.name,
          uid: "ui-resource-uid-0",
          generation: 1,
        },
        spec: { replicas: 1 },
        status: {
          observedGeneration: 1,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
          conditions: [
            { type: "Available", status: "True" },
            { type: "Progressing", status: "True" },
          ],
        },
      },
      observedAt,
    }));
  }
  if (authorization.stepId === "start-runtime") {
    return JSON.stringify(buildSessionProofApplyEvidence({
      authorization,
      observedAt,
      resources: sessionProofApplyResourceIdentities("start-runtime", authorization)
        .map((resource, index) => ({
          ...resource,
          uid: `runtime-resource-uid-${index}`,
        })),
    }));
  }
  if (authorization.stepId === "wait-runtime") {
    const observedAt = `2026-08-05T18:11:${String(authorization.stepIndex).padStart(2, "0")}Z`;
    return JSON.stringify(buildSessionProofRuntimeReadinessEvidence({
      authorization,
      runtimeApplyReceiptSource: context.priorReceiptSources?.at(-1),
      runtimeApplyEvidenceSource: context.priorEvidenceSources?.at(-1),
      job: {
        apiVersion: "batch/v1", kind: "Job",
        metadata: { name: "codeops-session-runtime-video-1", uid: "runtime-resource-uid-0", generation: 1 },
        spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 3600 },
        status: { active: 1, ready: 1, startTime: observedAt },
      },
      pod: {
        apiVersion: "v1", kind: "Pod",
        metadata: {
          name: "codeops-session-runtime-video-1-pod", uid: "runtime-pod-uid",
          labels: { "job-name": "codeops-session-runtime-video-1" },
          ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", uid: "runtime-resource-uid-0", controller: true }],
        },
        status: {
          phase: "Running", startTime: observedAt,
          conditions: ["Initialized", "Ready", "ContainersReady", "PodScheduled"].map((type) => ({ type, status: "True" })),
          initContainerStatuses: [{ name: "workspace-builder", restartCount: 0, state: { terminated: { exitCode: 0 } } }],
          containerStatuses: ["runtime-worker", "coding-agent"].map((name) => ({ name, ready: true, restartCount: 0, state: { running: { startedAt: observedAt } } })),
        },
      },
      observedAt,
    }));
  }
  if (authorization.stepId === "record-proof") {
    return JSON.stringify(buildSessionProofRecordEvidence({
      authorization,
      runtimeReadinessReceiptSource: context.priorReceiptSources?.at(-1),
      runtimeReadinessEvidenceSource: context.priorEvidenceSources?.at(-1),
      startedAt: "2026-08-05T18:12:18Z",
      finishedAt: "2026-08-05T18:13:18Z",
      observedAt: "2026-08-05T18:14:18Z",
      inspection: {
        legible: true,
        completeOperationCoverage: true,
        correctFinalLifecycleState: true,
        syntheticOwnedContentOnly: true,
        sensitiveMaterialAbsent: true,
      },
      artifacts: {
        "browser/video/raw.webm": Buffer.from("canonical raw video"),
        "browser/trace.zip": Buffer.from("playwright trace"),
        "session/export.json": Buffer.from('{"sessions":[]}\n'),
        "assertions.json": Buffer.from('{"result":"passed"}\n'),
      },
    }));
  }
  if (authorization.stepId === "stop-runtime") {
    const recordEvidenceSource = context.priorEvidenceSources?.at(-1);
    const recordEvidence = JSON.parse(recordEvidenceSource);
    const runtimeEvidence = JSON.parse(recordEvidence.runtimeReadinessEvidenceSource);
    const applyEvidence = JSON.parse(runtimeEvidence.runtimeApplyEvidenceSource);
    return JSON.stringify(buildSessionProofRuntimeStopEvidence({
      authorization,
      recordReceiptSource: context.priorReceiptSources?.at(-1),
      recordEvidenceSource,
      runtimeJobAbsent: true,
      retainedResources: applyEvidence.resourceInventory.filter((resource) => resource.kind !== "Job"),
      observedAt: "2026-08-05T18:15:19Z",
    }));
  }
  if (authorization.stepId === "wait-database") {
    return JSON.stringify(buildSessionProofReadinessEvidence({
      authorization,
      databaseApplyReceiptSource: context.priorReceiptSources?.at(-1),
      databaseApplyEvidenceSource: context.priorEvidenceSources?.at(-1),
      deployment: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "codeops-session-proof-database",
          namespace: authorization.namespace.name,
          uid: "database-resource-uid-1",
          generation: 1,
        },
        spec: { replicas: 1 },
        status: {
          observedGeneration: 1,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
          conditions: [
            { type: "Available", status: "True" },
            { type: "Progressing", status: "True" },
          ],
        },
      },
      observedAt,
    }));
  }
  if (authorization.stepId === "wait-gateway-migration") {
    return JSON.stringify(buildSessionProofGatewayReadinessEvidence({
      authorization,
      gatewayApplyReceiptSource: context.priorReceiptSources?.at(-1),
      gatewayApplyEvidenceSource: context.priorEvidenceSources?.at(-1),
      deployment: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "codeops-control-gateway",
          namespace: authorization.namespace.name,
          uid: "gateway-resource-uid-0",
          generation: 1,
        },
        spec: { replicas: 1 },
        status: {
          observedGeneration: 1,
          replicas: 1,
          updatedReplicas: 1,
          readyReplicas: 1,
          availableReplicas: 1,
          conditions: [
            { type: "Available", status: "True" },
            { type: "Progressing", status: "True" },
          ],
        },
      },
      migrationRelation: sessionProofGatewayMigrationRelation(),
      observedAt,
    }));
  }
  if (authorization.stepId === "wait-grants") {
    return JSON.stringify(buildSessionProofGrantCompletionEvidence({
      authorization,
      grantApplyReceiptSource: context.priorReceiptSources?.at(-1),
      grantApplyEvidenceSource: context.priorEvidenceSources?.at(-1),
      job: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "codeops-session-proof-grants",
          namespace: authorization.namespace.name,
          uid: "grant-resource-uid-0",
          generation: 1,
        },
        spec: {
          completions: 1,
          parallelism: 1,
          backoffLimit: 0,
          activeDeadlineSeconds: 300,
        },
        status: {
          active: 0,
          succeeded: 1,
          failed: 0,
          startTime: observedAt,
          completionTime: observedAt,
          conditions: [{ type: "Complete", status: "True" }],
        },
      },
      observedAt,
    }));
  }
  if (authorization.stepId === "wait-codex-login") {
    return JSON.stringify(buildSessionProofCodexLoginCompletionEvidence({
      authorization,
      loginApplyReceiptSource: context.priorReceiptSources?.at(-1),
      loginApplyEvidenceSource: context.priorEvidenceSources?.at(-1),
      job: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "codeops-codex-auth-login",
          namespace: authorization.namespace.name,
          uid: "codex-login-resource-uid-0",
          generation: 1,
        },
        spec: {
          completions: 1,
          parallelism: 1,
          backoffLimit: 0,
          activeDeadlineSeconds: 900,
          ttlSecondsAfterFinished: 3600,
        },
        status: {
          active: 0,
          succeeded: 1,
          failed: 0,
          startTime: observedAt,
          completionTime: observedAt,
          conditions: [{ type: "Complete", status: "True" }],
        },
      },
      persistentVolumeClaim: {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: "codeops-codex-auth",
          namespace: authorization.namespace.name,
          uid: "codex-login-resource-uid-2",
        },
        status: { phase: "Bound" },
      },
      observedAt,
    }));
  }
  if (authorization.stepId === "codex-smoke") {
    return JSON.stringify(buildSessionProofCodexSmokeReplacementEvidence({
      authorization,
      loginCompletionReceiptSource: context.priorReceiptSources?.at(-1),
      loginCompletionEvidenceSource: context.priorEvidenceSources?.at(-1),
      resources: sessionProofApplyResourceIdentities("codex-smoke").map((resource, index) => ({
        ...resource,
        uid: resource.kind === "Job"
          ? "codex-smoke-job-uid"
          : `codex-login-resource-uid-${index}`,
      })),
      loginJobAbsent: true,
      observedAt,
    }));
  }
  if (authorization.stepId === "wait-codex-smoke") {
    return JSON.stringify(buildSessionProofCodexSmokeCompletionEvidence({
      authorization,
      smokeReplacementReceiptSource: context.priorReceiptSources?.at(-1),
      smokeReplacementEvidenceSource: context.priorEvidenceSources?.at(-1),
      loginJobAbsent: true,
      job: {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "codeops-codex-auth-smoke",
          namespace: authorization.namespace.name,
          uid: "codex-smoke-job-uid",
          generation: 1,
        },
        spec: {
          completions: 1,
          parallelism: 1,
          backoffLimit: 0,
          activeDeadlineSeconds: 900,
          ttlSecondsAfterFinished: 3600,
        },
        status: {
          active: 0,
          succeeded: 1,
          failed: 0,
          startTime: observedAt,
          completionTime: observedAt,
          conditions: [{ type: "Complete", status: "True" }],
        },
      },
      persistentVolumeClaim: {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: "codeops-codex-auth",
          namespace: authorization.namespace.name,
          uid: "codex-login-resource-uid-2",
        },
        status: { phase: "Bound" },
      },
      observedAt,
    }));
  }
  return JSON.stringify({
    apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
    result: "verified",
    observedAt,
    planSha256: authorization.planSha256,
    stepId: authorization.stepId,
    namespace: authorization.namespace,
  });
}

test("authorizes only the first post-creation step against the live Namespace UID", () => {
  const value = authorize();
  assert.equal(value.stepIndex, 2);
  assert.equal(value.stepId, "issue-broker-capabilities");
  assert.equal(value.previousReceiptSha256, createHash("sha256").update(creationReceiptSource).digest("hex"));
});

test("emits a completed receipt only after a second live identity check", () => {
  const authorization = authorize();
  const receipt = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: "2026-08-05T18:03:00Z",
    evidenceSource: evidenceSource(authorization, "2026-08-05T18:03:00Z"),
  });
  assert.equal(receipt.result, "completed");
  assert.equal(receipt.stepId, "issue-broker-capabilities");
  assert.equal(receipt.namespace.uid, "namespace-uid-1");
  assert.match(receipt.evidenceSha256, /^[0-9a-f]{64}$/);
});

test("rejects value-bearing or identity-drifted completion evidence", () => {
  const authorization = authorize();
  const evidence = JSON.parse(evidenceSource(authorization, "2026-08-05T18:03:00Z"));
  evidence.data = { token: "must-not-enter-receipt-evidence" };
  assert.throws(
    () => completeSessionProofStep(authorization, {
      namespaceResource,
      operator,
      target,
      completedAt: "2026-08-05T18:03:00Z",
      evidenceSource: JSON.stringify(evidence),
    }),
    /evidence identity drifted/,
  );
});

test("advances only through exact predecessor bytes", () => {
  const authorization = authorize();
  const first = completeSessionProofStep(authorization, {
    namespaceResource,
    operator,
    target,
    completedAt: "2026-08-05T18:03:00Z",
    evidenceSource: evidenceSource(authorization, "2026-08-05T18:03:00Z"),
  });
  const firstSource = JSON.stringify(first);
  const second = authorize({ priorReceiptSources: [firstSource] });
  assert.equal(second.stepId, "issue-runtime-capabilities");
  assert.equal(second.previousReceiptSha256, createHash("sha256").update(firstSource).digest("hex"));
  const tampered = { ...first, previousReceiptSha256: "0".repeat(64) };
  assert.throws(
    () => authorize({ priorReceiptSources: [JSON.stringify(tampered)] }),
    /receipt chain drifted/,
  );
});

test("continues an expired run only from its exact recovery admission and predecessor", () => {
  const receiptSources = [];
  const evidenceSources = [];
  const sequence = sessionProofSequence();
  for (let stepIndex = 2; stepIndex <= 6; stepIndex += 1) {
    const step = sequence[stepIndex];
    const authorization = authorize({
      priorReceiptSources: receiptSources,
      artifactSource: step.artifact ? `${step.artifact}\n` : undefined,
      observedAt: `2026-08-05T18:10:${String(stepIndex).padStart(2, "0")}Z`,
    });
    const currentEvidenceSource = evidenceSource(
      authorization,
      `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
      { priorReceiptSources: receiptSources, priorEvidenceSources: evidenceSources },
    );
    evidenceSources.push(currentEvidenceSource);
    receiptSources.push(`${JSON.stringify(completeSessionProofStep(authorization, {
      namespaceResource,
      operator,
      target,
      completedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
      evidenceSource: currentEvidenceSource,
    }), null, 2)}\n`);
  }
  const sourceAdmissionSource = `${JSON.stringify(admission, null, 2)}\n`;
  const recoveryAdmission = recoverSessionProofAdmission(admission, {
    sourceAdmissionSource,
    predecessorStepId: "start-gateway",
    predecessorReceiptSource: receiptSources.at(-1),
    namespaceResource,
    operator,
    target,
    approvedAt: "2026-08-05T20:05:00Z",
    expiresAt: "2026-08-05T21:05:00Z",
  });
  const recoveryAdmissionSource = `${JSON.stringify(recoveryAdmission, null, 2)}\n`;
  const authorization = authorize({
    priorReceiptSources: receiptSources,
    recoveryAdmissionSource,
    observedAt: "2026-08-05T20:10:00Z",
  });
  assert.equal(authorization.stepId, "wait-gateway-migration");
  assert.deepEqual(authorization.admission, recoveryAdmission);

  assert.throws(() => authorize({
    priorReceiptSources: receiptSources.slice(0, -1),
    artifactSource: "gateway\n",
    recoveryAdmissionSource,
    observedAt: "2026-08-05T20:10:00Z",
  }), /does not continue the exact receipt chain/);
  assert.throws(() => authorize({
    priorReceiptSources: receiptSources,
    recoveryAdmissionSource: recoveryAdmissionSource.replace(
      recoveryAdmission.recovery.predecessorReceiptSha256,
      "f".repeat(64),
    ),
    observedAt: "2026-08-05T20:10:00Z",
  }), /does not continue the exact receipt chain/);
  for (const driftedRecovery of [
    {
      ...recoveryAdmission,
      operator: { ...recoveryAdmission.operator, username: "substituted@example.com" },
    },
    {
      ...recoveryAdmission,
      target: { ...recoveryAdmission.target, context: "substituted-context" },
    },
    {
      ...recoveryAdmission,
      approvedAt: "2026-08-05T19:55:00Z",
      expiresAt: "2026-08-05T20:55:00Z",
    },
  ]) {
    assert.throws(() => authorize({
      priorReceiptSources: receiptSources,
      recoveryAdmissionSource: `${JSON.stringify(driftedRecovery, null, 2)}\n`,
      observedAt: "2026-08-05T20:10:00Z",
    }), /does not continue the exact receipt chain/);
  }
});

test("binds artifact steps to the reviewed manifest bytes", () => {
  const receipts = [];
  for (let index = 0; index < 2; index += 1) {
    const authorization = authorize({ priorReceiptSources: receipts });
    receipts.push(JSON.stringify(completeSessionProofStep(authorization, {
      namespaceResource,
      operator,
      target,
      completedAt: `2026-08-05T18:0${3 + index}:00Z`,
      evidenceSource: evidenceSource(authorization, `2026-08-05T18:0${3 + index}:00Z`),
    })));
  }
  assert.throws(
    () => authorize({ priorReceiptSources: receipts, artifactSource: "wrong\n" }),
    /artifact digest drifted/,
  );
  const value = authorize({ priorReceiptSources: receipts, artifactSource: "database\n" });
  assert.equal(value.stepId, "start-database");
  assert.equal(value.artifactSha256, artifacts.find((artifact) => artifact.id === "database").sha256);
  assert.throws(() => completeSessionProofStep(value, {
    namespaceResource,
    operator,
    target,
    completedAt: "2026-08-05T18:06:00Z",
    evidenceSource: JSON.stringify({
      apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
      result: "verified",
      observedAt: "2026-08-05T18:06:00Z",
      planSha256,
      stepId: value.stepId,
      namespace: value.namespace,
    }),
  }), /apply evidence identity drifted/);
});

test("rejects Namespace replacement and incomplete creation", () => {
  assert.throws(
    () => authorize({ namespaceResource: { ...namespaceResource, metadata: { ...namespaceResource.metadata, uid: "replacement" } } }),
    /Namespace UID drifted/,
  );
  const incomplete = JSON.parse(creationReceiptSource);
  incomplete.result = "namespace-uid-bound-create-incomplete";
  incomplete.proceed = false;
  assert.throws(
    () => authorize({ creationReceiptSource: JSON.stringify(incomplete) }),
    /does not admit execution/,
  );
});

test("rejects authorization field substitution before writing a receipt", () => {
  const authorization = authorize();
  assert.throws(
    () => completeSessionProofStep(
      { ...authorization, stepId: "start-runtime", action: "operator-apply" },
      {
        namespaceResource,
        operator,
        target,
        completedAt: "2026-08-05T18:03:00Z",
        evidenceSource: evidenceSource(authorization, "2026-08-05T18:03:00Z"),
      },
    ),
    /authorization drifted/,
  );
});

test("chains every intermediate step through revocation and stops before deletion", () => {
  const receiptSources = [];
  const evidenceSources = [];
  const sequence = sessionProofSequence();
  for (let stepIndex = 2; stepIndex <= 20; stepIndex += 1) {
    const step = sequence[stepIndex];
    const authorization = authorize({
      priorReceiptSources: receiptSources,
      artifactSource: step.artifact ? `${step.artifact}\n` : undefined,
      observedAt: `2026-08-05T18:10:${String(stepIndex).padStart(2, "0")}Z`,
    });
    assert.equal(authorization.stepId, step.id);
    const currentEvidenceSource = evidenceSource(
      authorization,
      `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
      { priorReceiptSources: receiptSources, priorEvidenceSources: evidenceSources },
    );
    evidenceSources.push(currentEvidenceSource);
    receiptSources.push(JSON.stringify(completeSessionProofStep(authorization, {
      namespaceResource,
      operator,
      target,
      completedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
      evidenceSource: currentEvidenceSource,
    })));
  }
  assert.equal(JSON.parse(receiptSources.at(-1)).stepId, "revoke-capabilities");
  assert.throws(
    () => authorize({ priorReceiptSources: receiptSources }),
    /already complete/,
  );
});
