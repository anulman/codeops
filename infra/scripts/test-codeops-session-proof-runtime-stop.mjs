import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  bindSessionProofNamespace,
  createSessionProofAdmission,
} from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofRecordEvidence } from "./codeops-session-proof-record-evidence.mjs";
import { buildSessionProofRuntimeReadinessEvidence } from "./codeops-session-proof-runtime-readiness-evidence.mjs";
import {
  createRuntimeJobDeleteRequest,
  stopSessionProofRuntime,
} from "./codeops-session-proof-runtime-stop.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const digest = (source) => createHash("sha256").update(source).digest("hex");
const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "1".repeat(40),
  sessionSuffix: "video-1",
};
const certificate = Buffer.from("synthetic-client-certificate");
const certificateData = certificate.toString("base64");
const operator = {
  username: "kubernetes-admin",
  uid: null,
  credentialSha256: digest(certificate),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts: ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
    .map((id) => ({ id, sha256: digest(`${id}\n`) })),
  sequence: sessionProofSequence(),
});
const planSha256 = digest(planSource);

function namespaceResource(uid = "namespace-uid-1") {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: identity.namespace,
      uid,
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.renoconcierge.ca/proof-run": identity.runId,
        "codeops.renoconcierge.ca/base-sha": identity.baseSha,
      },
    },
  };
}

const unbound = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: planSha256,
  operator,
  target,
  approvedAt: "2026-08-05T22:00:00Z",
  expiresAt: "2026-08-06T02:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T22:01:00Z",
});
const namespace = { name: identity.namespace, uid: admission.namespaceUid };
const applyAuthorization = {
  planSha256,
  stepIndex: 16,
  stepId: "start-runtime",
  action: "operator-apply",
  artifact: "runtime",
  artifactSha256: digest("runtime\n"),
  namespace,
  admission,
};
const runtimeResources = sessionProofApplyResourceIdentities("start-runtime", applyAuthorization)
  .map((resource, index) => ({ ...resource, uid: `runtime-resource-uid-${index}` }));
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: applyAuthorization,
  observedAt: "2026-08-05T22:20:00Z",
  resources: runtimeResources,
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 16,
  stepId: "start-runtime",
  action: "operator-apply",
  artifact: "runtime",
  artifactSha256: applyAuthorization.artifactSha256,
  previousReceiptSha256: "c".repeat(64),
  evidenceSha256: digest(applyEvidenceSource),
});
const waitAuthorization = {
  planSha256,
  stepIndex: 17,
  stepId: "wait-runtime",
  action: "operator-wait-ready",
  artifact: null,
  namespace,
  admission,
  previousReceiptSha256: digest(applyReceiptSource),
};
const runtimeEvidenceSource = JSON.stringify(buildSessionProofRuntimeReadinessEvidence({
  authorization: waitAuthorization,
  runtimeApplyReceiptSource: applyReceiptSource,
  runtimeApplyEvidenceSource: applyEvidenceSource,
  job: {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "codeops-session-runtime-video-1", uid: "runtime-resource-uid-0", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 3600 },
    status: { active: 1, ready: 1, startTime: "2026-08-05T22:20:30Z" },
  },
  pod: {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "codeops-session-runtime-video-1-pod",
      uid: "runtime-pod-uid",
      labels: { "job-name": "codeops-session-runtime-video-1" },
      ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", uid: "runtime-resource-uid-0", controller: true }],
    },
    status: {
      phase: "Running",
      startTime: "2026-08-05T22:20:31Z",
      conditions: ["Initialized", "Ready", "ContainersReady", "PodScheduled"]
        .map((type) => ({ type, status: "True" })),
      initContainerStatuses: [{ name: "workspace-builder", restartCount: 0, state: { terminated: { exitCode: 0 } } }],
      containerStatuses: ["runtime-worker", "coding-agent"].map((name) => ({
        name,
        ready: true,
        restartCount: 0,
        state: { running: { startedAt: "2026-08-05T22:20:32Z" } },
      })),
    },
  },
  observedAt: "2026-08-05T22:21:00Z",
}));
const runtimeReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 17,
  stepId: "wait-runtime",
  action: "operator-wait-ready",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: digest(applyReceiptSource),
  evidenceSha256: digest(runtimeEvidenceSource),
});
const recordAuthorization = {
  planSha256,
  stepIndex: 18,
  stepId: "record-proof",
  action: "operator-record-and-export-evidence",
  artifact: null,
  namespace,
  admission,
  previousReceiptSha256: digest(runtimeReceiptSource),
};
const recordEvidenceSource = JSON.stringify(buildSessionProofRecordEvidence({
  authorization: recordAuthorization,
  runtimeReadinessReceiptSource: runtimeReceiptSource,
  runtimeReadinessEvidenceSource: runtimeEvidenceSource,
  startedAt: "2026-08-05T22:22:00Z",
  finishedAt: "2026-08-05T22:30:00Z",
  observedAt: "2026-08-05T22:31:00Z",
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
const recordReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 18,
  stepId: "record-proof",
  action: "operator-record-and-export-evidence",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: digest(runtimeReceiptSource),
  evidenceSha256: digest(recordEvidenceSource),
});
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace,
  stepIndex: 19,
  stepId: "stop-runtime",
  action: "operator-delete-exact-runtime-job",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: digest(recordReceiptSource),
  authorizedAt: "2026-08-05T22:31:30Z",
};

const typeByIdentity = new Map([
  ["batch/v1/Job", "job.batch"],
  ["networking.k8s.io/v1/NetworkPolicy", "networkpolicy.networking.k8s.io"],
  ["v1/ServiceAccount", "serviceaccount"],
]);

function makeDependencies(options = {}) {
  let jobExists = true;
  let nowValue = 0;
  let finalNamespaceReads = 0;
  let retainedReads = 0;
  const calls = [];
  const runner = (file, args) => {
    calls.push({ file, args });
    const key = args.join(" ");
    if (file === "kubectl" && key === "config current-context") return `${target.context}\n`;
    if (file === "kubectl" && key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (file === "kubectl" && key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (file === "kubectl" && key.includes("client-certificate-data")) return certificateData;
    if (file === "kubectl" && key === "config view --minify --raw -o json") {
      return JSON.stringify({
        clusters: [{ cluster: {
          server: target.server,
          "certificate-authority-data": Buffer.from("synthetic-ca").toString("base64"),
        } }],
        users: [{ user: {
          "client-certificate-data": certificateData,
          "client-key-data": Buffer.from("synthetic-key").toString("base64"),
        } }],
      });
    }
    if (file === "kubectl" && key.startsWith(`get namespace ${identity.namespace}`)) {
      finalNamespaceReads += 1;
      return JSON.stringify(namespaceResource(
        options.replaceNamespace && finalNamespaceReads > 1 ? "replacement-namespace-uid" : undefined,
      ));
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get") {
      const expected = runtimeResources.find((resource) =>
        typeByIdentity.get(`${resource.apiVersion}/${resource.kind}`) === args[3] && resource.name === args[4]);
      assert.ok(expected);
      if (expected.kind === "Job") {
        if (!jobExists) {
          if (options.reappearJob && finalNamespaceReads > 1) {
            return JSON.stringify({
              apiVersion: expected.apiVersion,
              kind: expected.kind,
              metadata: { name: expected.name, namespace: identity.namespace, uid: "replacement-job-uid" },
            });
          }
          return "";
        }
        return JSON.stringify({
          apiVersion: expected.apiVersion,
          kind: expected.kind,
          metadata: {
            name: expected.name,
            namespace: identity.namespace,
            uid: options.replaceJobBeforeDelete ? "replacement-job-uid" : expected.uid,
          },
        });
      }
      retainedReads += 1;
      const uid = options.replaceRetained && retainedReads > 2 ? "replacement-retained-uid" : expected.uid;
      return JSON.stringify({
        apiVersion: expected.apiVersion,
        kind: expected.kind,
        metadata: { name: expected.name, namespace: identity.namespace, uid },
      });
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  const deleteRequest = async (input) => {
    calls.push({ deleteInput: input });
    if (options.rejectDelete) return { statusCode: 409, contentType: "application/json", body: "{}" };
    if (!options.timeout) jobExists = false;
    return {
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: "v1", kind: "Status", status: "Success" }),
    };
  };
  return {
    calls,
    runner,
    deleteRequest,
    now: () => new Date(nowValue),
    sleep: async () => { nowValue += 60_001; },
  };
}

function stop(dependencies, overrides = {}) {
  return stopSessionProofRuntime({
    authorization,
    recordReceiptSource,
    recordEvidenceSource,
    startedAt: "2026-08-05T22:32:00Z",
    completedAt: "2026-08-05T22:33:00Z",
    ...overrides,
  }, dependencies);
}

test("UID-deletes only the exact runtime Job and receipts stable retained identities", async () => {
  const dependencies = makeDependencies();
  const result = await stop(dependencies);
  assert.equal(result.receipt.stepId, "stop-runtime");
  assert.equal(JSON.parse(result.evidenceSource).runtimeJobAbsent, true);
  const deletion = dependencies.calls.find((call) => call.deleteInput);
  assert.equal(deletion.deleteInput.uid, "runtime-resource-uid-0");
  assert.equal(deletion.deleteInput.name, "codeops-session-runtime-video-1");
  assert.equal(dependencies.calls.some(({ args }) => args?.includes("delete")), false);
});

test("builds an exact UID-preconditioned foreground runtime Job deletion request", () => {
  const operation = createRuntimeJobDeleteRequest({
    namespace: identity.namespace,
    name: "codeops-session-runtime-video-1",
    uid: "runtime-resource-uid-0",
  });
  assert.equal(operation.path, `/apis/batch/v1/namespaces/${identity.namespace}/jobs/codeops-session-runtime-video-1`);
  assert.deepEqual(JSON.parse(operation.body), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    propagationPolicy: "Foreground",
    preconditions: { uid: "runtime-resource-uid-0" },
  });
});

test("rejects action, predecessor, or time drift before Kubernetes access", async () => {
  for (const overrides of [
    { authorization: { ...authorization, action: "operator-delete-job" } },
    { recordReceiptSource: `${recordReceiptSource}\n` },
    { startedAt: "2026-08-05T22:31:29Z" },
  ]) {
    const dependencies = makeDependencies();
    await assert.rejects(() => stop(dependencies, overrides));
    assert.equal(dependencies.calls.length, 0);
  }
});

test("withholds a receipt on replacement, rejection, timeout, or final-state drift", async () => {
  for (const options of [
    { replaceJobBeforeDelete: true },
    { rejectDelete: true },
    { timeout: true },
    { replaceRetained: true },
    { replaceNamespace: true },
    { reappearJob: true },
  ]) {
    const dependencies = makeDependencies(options);
    await assert.rejects(() => stop(dependencies));
  }
});
