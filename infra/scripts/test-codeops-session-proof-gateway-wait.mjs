import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { buildSessionProofApplyEvidence, sessionProofApplyResourceIdentities } from "./codeops-session-proof-apply-evidence.mjs";
import { waitForSessionProofGatewayMigration } from "./codeops-session-proof-gateway-wait.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = { namespace: "codeops-session-proof-video-1", runId: "video-1", baseSha: "1".repeat(40), sessionSuffix: "video-1" };
const certificateData = Buffer.from("synthetic-client-certificate").toString("base64");
const operator = { username: "kubernetes-admin", uid: null, credentialSha256: createHash("sha256").update(Buffer.from(certificateData, "base64")).digest("hex") };
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const artifacts = ["codex-login", "codex-smoke", "database", "gateway", "grants", "namespace", "runtime", "ui"]
  .map((id) => ({ id, sha256: createHash("sha256").update(`${id}\n`).digest("hex") }));
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1", admission: "closed",
  execution: "render-and-review-only", identity, artifacts, sequence: sessionProofSequence(),
});
const planSha256 = createHash("sha256").update(planSource).digest("hex");

function namespaceResource(uid = "namespace-uid-1") {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name: identity.namespace, uid, labels: {
    "app.kubernetes.io/part-of": "codeops-session-proof", "codeops.renoconcierge.ca/proof-run": identity.runId,
    "codeops.renoconcierge.ca/base-sha": identity.baseSha,
  } } };
}

const unbound = createSessionProofAdmission({
  planSource, reviewedPlanSha256: planSha256, operator, target,
  approvedAt: "2026-08-05T18:00:00Z", expiresAt: "2026-08-05T21:00:00Z",
});
const admission = bindSessionProofNamespace(unbound, { namespaceResource: namespaceResource(), operator, target, observedAt: "2026-08-05T18:01:00Z" });
const applyEvidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
  authorization: {
    planSha256, stepId: "start-gateway", action: "operator-apply", artifact: "gateway",
    artifactSha256: artifacts.find((value) => value.id === "gateway").sha256,
    namespace: { name: identity.namespace, uid: admission.namespaceUid },
  },
  observedAt: "2026-08-05T18:10:00Z",
  resources: sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
    ...resource, uid: resource.kind === "Deployment" ? "gateway-deployment-uid" : `gateway-resource-uid-${index}`,
  })),
}));
const applyReceiptSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-receipt/v1", result: "completed", proceed: true,
  planSha256, namespace: { name: identity.namespace, uid: admission.namespaceUid }, stepIndex: 6,
  stepId: "start-gateway", action: "operator-apply", artifact: "gateway",
  artifactSha256: artifacts.find((value) => value.id === "gateway").sha256,
  evidenceSha256: createHash("sha256").update(applyEvidenceSource).digest("hex"),
});
const authorization = {
  apiVersion: "codeops.renoconcierge.ca/session-proof-step-authorization/v1", planSha256, admission,
  namespace: { name: identity.namespace, uid: admission.namespaceUid }, stepIndex: 7,
  stepId: "wait-gateway-migration", action: "operator-wait-ready", artifact: null, artifactSha256: null,
  previousReceiptSha256: createHash("sha256").update(applyReceiptSource).digest("hex"), authorizedAt: "2026-08-05T18:11:00Z",
};

function deployment({ ready = true, uid = "gateway-deployment-uid", namespace = identity.namespace, generation = 1 } = {}) {
  return {
    apiVersion: "apps/v1", kind: "Deployment",
    metadata: { name: "codeops-control-gateway", namespace, uid, generation }, spec: { replicas: 1 },
    status: { observedGeneration: generation, replicas: 1, updatedReplicas: 1, readyReplicas: ready ? 1 : 0,
      availableReplicas: ready ? 1 : 0, unavailableReplicas: ready ? 0 : 1,
      conditions: [{ type: "Available", status: ready ? "True" : "False" }, { type: "Progressing", status: "True" }] },
  };
}

const checkDefinitions = [
  "(dispatch_digest ~ '^sha256:[0-9a-f]{64}$'::text)",
  "(status = ANY (ARRAY['started'::text, 'completed'::text]))",
  "(((status = 'started'::text) AND (result_json IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (result_json IS NOT NULL) AND (completed_at IS NOT NULL) AND (completed_at >= created_at)))",
  "((result_json IS NULL) OR ((jsonb_typeof(result_json) = 'object'::text) AND (result_json ? 'type'::text) AND ((result_json ->> 'type'::text) = ANY (ARRAY['prompt'::text, 'checkpoint'::text, 'hibernate'::text, 'resume'::text, 'fork'::text]))))",
].sort();

function relation(overrides = {}) {
  return {
    schema: "codeops", name: "session_runtime_execution_receipts", oid: 12345,
    columns: [
      { name: "dispatch_id", dataType: "uuid", nullable: false },
      { name: "dispatch_digest", dataType: "text", nullable: false },
      { name: "status", dataType: "text", nullable: false },
      { name: "result_json", dataType: "jsonb", nullable: true },
      { name: "created_at", dataType: "timestamp with time zone", nullable: false },
      { name: "completed_at", dataType: "timestamp with time zone", nullable: true },
    ],
    primaryKey: ["dispatch_id"],
    foreignKeys: [{ columns: ["dispatch_id"], referencedSchema: "codeops", referencedTable: "session_runtime_outbox", referencedColumns: ["dispatch_id"] }],
    checkDefinitions, ...overrides,
  };
}

function makeRunner(deployments, relations = [relation()]) {
  const calls = []; let deploymentReads = 0; let relationReads = 0;
  const runner = (file, args) => {
    calls.push({ file, args }); const key = args.join(" ");
    if (file === "kubectl" && key === "config current-context") return `${target.context}\n`;
    if (file === "kubectl" && key === "config view --minify -o json") return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    if (file === "kubectl" && key === "auth whoami -o json") return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    if (file === "kubectl" && key.includes("client-certificate-data")) return certificateData;
    if (file === "kubectl" && key.startsWith(`get namespace ${identity.namespace}`)) return JSON.stringify(namespaceResource());
    if (file === "kubectl" && args[0] === "-n" && args[2] === "get") {
      const value = deployments[Math.min(deploymentReads, deployments.length - 1)]; deploymentReads += 1; return JSON.stringify(value);
    }
    if (file === "kubectl" && args[0] === "-n" && args[2] === "exec") {
      const value = relations[Math.min(relationReads, relations.length - 1)]; relationReads += 1;
      return value === null ? "" : `${JSON.stringify(value)}\n`;
    }
    throw new Error(`unexpected command: ${file} ${key}`);
  };
  return { calls, runner, get deploymentReads() { return deploymentReads; }, get relationReads() { return relationReads; } };
}

function wait(stub, overrides = {}, waitCalls = []) {
  return waitForSessionProofGatewayMigration({
    authorization, gatewayApplyReceiptSource: applyReceiptSource, gatewayApplyEvidenceSource: applyEvidenceSource,
    startedAt: "2026-08-05T18:12:00Z", completedAt: "2026-08-05T18:13:00Z",
    maxAttempts: 3, pollIntervalMs: 1000, ...overrides,
  }, stub.runner, (milliseconds) => waitCalls.push(milliseconds));
}

test("polls only gateway rollout and catalog metadata before stable completion", () => {
  const stub = makeRunner([deployment({ ready: false }), deployment(), deployment()]); const waits = [];
  const result = wait(stub, {}, waits); const evidence = JSON.parse(result.evidenceSource);
  assert.equal(result.receipt.stepId, "wait-gateway-migration");
  assert.equal(evidence.deployment.uid, "gateway-deployment-uid");
  assert.deepEqual(evidence.migrationRelation.checkConstraints, ["dispatch-digest-sha256", "receipt-state-shape", "result-type-lifecycle", "status-enum"]);
  assert.deepEqual(waits, [1000]); assert.equal(stub.deploymentReads, 3); assert.equal(stub.relationReads, 3);
  const query = stub.calls.find(({ args }) => args[2] === "exec").args.at(-1);
  assert.match(query, /pg_catalog\.pg_constraint/); assert.doesNotMatch(query, /result_json\s+FROM|SELECT\s+\*|crm\./i);
  assert.equal(stub.calls.some(({ args }) => args.some((arg) => ["create", "apply", "patch", "delete"].includes(arg))), false);
});

test("rejects action, time, chain, or polling drift before Kubernetes access", () => {
  for (const overrides of [
    { authorization: { ...authorization, action: "operator-apply" } }, { startedAt: "2026-08-05T18:10:59Z" },
    { maxAttempts: 121 }, { maxAttempts: 120, pollIntervalMs: 10_000 },
    { gatewayApplyReceiptSource: `${applyReceiptSource}\n` },
  ]) {
    const stub = makeRunner([deployment()]); assert.throws(() => wait(stub, overrides)); assert.equal(stub.calls.length, 0);
  }
});

test("withholds completion on bounded rollout or relation absence", () => {
  for (const [deployments, relations] of [
    [[deployment({ ready: false })], [relation()]],
    [[deployment()], [null]],
  ]) {
    const stub = makeRunner(deployments, relations); const waits = [];
    assert.throws(() => wait(stub, {}, waits), /did not become ready/);
    assert.deepEqual(waits, [1000, 1000]);
  }
});

test("fails closed on replacement, catalog semantics drift, or final state loss", () => {
  for (const [deployments, relations] of [
    [[deployment({ uid: "replacement-uid" })], [relation()]],
    [[deployment()], [relation({ checkDefinitions: checkDefinitions.slice(1) })]],
    [[deployment()], [relation({ checkDefinitions: [...checkDefinitions.slice(0, 3), "(true)"] })]],
    [[deployment(), deployment({ ready: false })], [relation(), relation()]],
    [[deployment(), deployment()], [relation(), relation({ oid: 0 })]],
  ]) {
    const stub = makeRunner(deployments, relations); assert.throws(() => wait(stub));
  }
});
