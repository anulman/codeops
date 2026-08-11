import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseAllDocuments, stringify } from "yaml";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import { buildSessionProofCodexLoginCompletionEvidence } from "./codeops-session-proof-codex-login-completion-evidence.mjs";
import {
  createCodexLoginJobDeleteRequest,
  replaceSessionProofCodexSmoke,
} from "./codeops-session-proof-codex-smoke-replace.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

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
  credentialSha256: createHash("sha256").update(certificate).digest("hex"),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };

function manifestResource(resource) {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: { name: resource.name, namespace: identity.namespace },
  };
}

const manifestSource = sessionProofApplyResourceIdentities("codex-smoke")
  .map((resource) => stringify(manifestResource(resource)))
  .join("---\n");
const artifacts = ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
  .map((id) => ({
    id,
    sha256: createHash("sha256").update(id === "codex-smoke" ? manifestSource : `${id}\n`).digest("hex"),
  }));
const planSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts,
  sequence: sessionProofSequence(),
});
const planSha256 = createHash("sha256").update(planSource).digest("hex");

function namespaceResource(uid = "namespace-uid-1") {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: identity.namespace,
      uid,
      labels: {
        "app.kubernetes.io/part-of": "codeops-session-proof",
        "codeops.example/proof-run": identity.runId,
        "codeops.example/base-sha": identity.baseSha,
      },
    },
  };
}

const unbound = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: planSha256,
  operator,
  target,
  approvedAt: "2026-08-05T18:00:00Z",
  expiresAt: "2026-08-05T22:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, {
  namespaceResource: namespaceResource(),
  operator,
  target,
  observedAt: "2026-08-05T18:01:00Z",
});
const namespace = { name: identity.namespace, uid: admission.namespaceUid };
const loginApplyAuthorization = {
  planSha256,
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: artifacts.find((value) => value.id === "codex-login").sha256,
  namespace,
};
const loginResources = sessionProofApplyResourceIdentities("codex-login").map((resource, index) => ({
  ...resource,
  uid: resource.kind === "Job" ? "login-job-uid" : `retained-resource-uid-${index}`,
}));
const loginApplyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: loginApplyAuthorization,
  observedAt: "2026-08-05T18:15:00Z",
  resources: loginResources,
}));
const loginApplyReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 10,
  stepId: "codex-login",
  action: "operator-apply",
  artifact: "codex-login",
  artifactSha256: loginApplyAuthorization.artifactSha256,
  evidenceSha256: createHash("sha256").update(loginApplyEvidenceSource).digest("hex"),
});
const loginWaitAuthorization = {
  planSha256,
  stepIndex: 11,
  stepId: "wait-codex-login",
  action: "operator-wait-complete",
  artifact: null,
  namespace,
  previousReceiptSha256: createHash("sha256").update(loginApplyReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T18:15:30Z",
};
const loginCompletionEvidenceSource = JSON.stringify(buildSessionProofCodexLoginCompletionEvidence({
  authorization: loginWaitAuthorization,
  loginApplyReceiptSource,
  loginApplyEvidenceSource,
  job: {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "codeops-codex-auth-login", namespace: identity.namespace, uid: "login-job-uid", generation: 1 },
    spec: { completions: 1, parallelism: 1, backoffLimit: 0, activeDeadlineSeconds: 900, ttlSecondsAfterFinished: 3600 },
    status: {
      active: 0,
      succeeded: 1,
      failed: 0,
      startTime: "2026-08-05T18:16:00Z",
      completionTime: "2026-08-05T18:17:00Z",
      conditions: [{ type: "Complete", status: "True" }],
    },
  },
  persistentVolumeClaim: {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: "codeops-codex-auth", namespace: identity.namespace, uid: "retained-resource-uid-2" },
    status: { phase: "Bound" },
  },
  observedAt: "2026-08-05T18:18:00Z",
}));
const loginCompletionReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  planSha256,
  namespace,
  stepIndex: 11,
  stepId: "wait-codex-login",
  action: "operator-wait-complete",
  artifact: null,
  artifactSha256: null,
  evidenceSha256: createHash("sha256").update(loginCompletionEvidenceSource).digest("hex"),
});
const authorization = {
  apiVersion: "codeops.example/session-proof-step-authorization/v1",
  planSha256,
  admission,
  namespace,
  stepIndex: 12,
  stepId: "codex-smoke",
  action: "operator-replace-auth-job",
  artifact: "codex-smoke",
  artifactSha256: artifacts.find((value) => value.id === "codex-smoke").sha256,
  previousReceiptSha256: createHash("sha256").update(loginCompletionReceiptSource).digest("hex"),
  authorizedAt: "2026-08-05T18:18:30Z",
};

const typeByIdentity = new Map([
  ["batch/v1/Job", "job.batch"],
  ["networking.k8s.io/v1/NetworkPolicy", "networkpolicy.networking.k8s.io"],
  ["v1/PersistentVolumeClaim", "persistentvolumeclaim"],
  ["v1/ServiceAccount", "serviceaccount"],
]);

function makeDependencies(options = {}) {
  let loginExists = options.loginExists ?? true;
  let smokeExists = options.smokePreexists ?? false;
  let created = false;
  const calls = [];
  const runner = (file, args, executionOptions = {}) => {
    calls.push({ file, args, options: executionOptions });
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
        clusters: [{ cluster: { server: target.server, "certificate-authority-data": Buffer.from("ca").toString("base64") } }],
        users: [{ user: { "client-certificate-data": certificateData, "client-key-data": Buffer.from("key").toString("base64") } }],
      });
    }
    if (file === "kubectl" && key.startsWith(`get namespace ${identity.namespace}`)) {
      return JSON.stringify(namespaceResource(options.replaceNamespaceAfterCreate && created ? "replacement-uid" : "namespace-uid-1"));
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "create") {
      const documents = parseAllDocuments(executionOptions.input).map((document) => document.toJS());
      assert.equal(documents.length, 1);
      assert.equal(documents[0].kind, "Job");
      assert.equal(documents[0].metadata.name, "codeops-codex-auth-smoke");
      created = true;
      smokeExists = !options.missingAfterCreate;
      return "job.batch/codeops-codex-auth-smoke created\n";
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get") {
      const expected = [
        { apiVersion: "batch/v1", kind: "Job", name: "codeops-codex-auth-login" },
        ...sessionProofApplyResourceIdentities("codex-smoke"),
      ].find((resource) =>
        typeByIdentity.get(`${resource.apiVersion}/${resource.kind}`) === args[3] && resource.name === args[4]);
      assert.ok(expected);
      if (expected.name === "codeops-codex-auth-login" && !loginExists) return "";
      if (expected.name === "codeops-codex-auth-smoke" && !smokeExists) return "";
      let uid;
      if (expected.name === "codeops-codex-auth-login") uid = "login-job-uid";
      else if (expected.name === "codeops-codex-auth-smoke") uid = "smoke-job-uid";
      else {
        const index = loginResources.findIndex((resource) => resource.kind === expected.kind);
        uid = options.replaceRetained && expected.kind === "NetworkPolicy"
          ? "replacement-retained-uid"
          : `retained-resource-uid-${index}`;
      }
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
    assert.equal(input.uid, "login-job-uid");
    if (!options.rejectDelete) loginExists = false;
    return options.rejectDelete
      ? { statusCode: 409, contentType: "application/json", body: JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure" }) }
      : { statusCode: 200, contentType: "application/json", body: JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Success" }) };
  };
  return { calls, deleteRequest, now: () => new Date("2026-08-05T18:19:00Z"), runner, sleep: async () => {} };
}

function replace(dependencies, overrides = {}) {
  return replaceSessionProofCodexSmoke({
    authorization,
    manifestSource,
    loginCompletionReceiptSource,
    loginCompletionEvidenceSource,
    startedAt: "2026-08-05T18:18:40Z",
    completedAt: "2026-08-05T18:19:00Z",
    ...overrides,
  }, dependencies);
}

test("UID-deletes only the completed login Job and creates only the reviewed smoke Job", async () => {
  const dependencies = makeDependencies();
  const result = await replace(dependencies);
  assert.equal(result.receipt.stepId, "codex-smoke");
  assert.equal(result.receipt.result, "completed");
  assert.equal(dependencies.calls.filter((call) => call.deleteInput).length, 1);
  assert.equal(dependencies.calls.filter((call) => call.args?.[2] === "create").length, 1);
  const evidence = JSON.parse(result.evidenceSource);
  assert.equal(evidence.replacedLoginJobUid, "login-job-uid");
  assert.equal(evidence.loginJobAbsent, true);
});

test("resumes smoke creation after the exact login Job deletion completed", async () => {
  const dependencies = makeDependencies({ loginExists: false });
  const result = await replace(dependencies, { resumeAfterLoginDeletion: true });
  assert.equal(result.receipt.stepId, "codex-smoke");
  assert.equal(dependencies.calls.filter((call) => call.deleteInput).length, 0);
  assert.equal(dependencies.calls.filter((call) => call.args?.[2] === "create").length, 1);
});

test("builds an exact UID-preconditioned foreground Job deletion request", () => {
  const request = createCodexLoginJobDeleteRequest({ namespace: identity.namespace, uid: "login-job-uid" });
  assert.equal(request.path, `/apis/batch/v1/namespaces/${identity.namespace}/jobs/codeops-codex-auth-login`);
  assert.deepEqual(JSON.parse(request.body), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    propagationPolicy: "Foreground",
    preconditions: { uid: "login-job-uid" },
  });
});

test("rejects artifact, action, predecessor, or time drift before Kubernetes access", async () => {
  for (const overrides of [
    { manifestSource: `${manifestSource}\n` },
    { authorization: { ...authorization, action: "operator-apply" } },
    { loginCompletionReceiptSource: `${loginCompletionReceiptSource}\n` },
    { startedAt: "2026-08-05T18:18:29Z" },
  ]) {
    const dependencies = makeDependencies();
    await assert.rejects(() => replace(dependencies, overrides));
    assert.equal(dependencies.calls.length, 0);
  }
});

test("withholds a receipt on retained drift, an existing smoke Job, delete rejection, or incomplete creation", async () => {
  for (const options of [
    { replaceRetained: true },
    { smokePreexists: true },
    { rejectDelete: true },
    { missingAfterCreate: true },
    { replaceNamespaceAfterCreate: true },
  ]) {
    const dependencies = makeDependencies(options);
    await assert.rejects(() => replace(dependencies));
  }
});
