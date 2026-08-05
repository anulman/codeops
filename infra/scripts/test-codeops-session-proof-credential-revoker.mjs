import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { bindSessionProofNamespace, createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  buildSessionProofApplyEvidence,
  sessionProofApplyResourceIdentities,
} from "./codeops-session-proof-apply-evidence.mjs";
import {
  createCredentialDeleteRequest,
  revokeSessionProofCredentials,
} from "./codeops-session-proof-credential-revoker.mjs";
import { buildSessionProofCredentialEvidence } from "./codeops-session-proof-credential-evidence.mjs";
import { buildSessionProofReadinessEvidence } from "./codeops-session-proof-readiness-evidence.mjs";
import {
  buildSessionProofGatewayReadinessEvidence,
  sessionProofGatewayMigrationRelation,
} from "./codeops-session-proof-gateway-readiness-evidence.mjs";
import { authorizeSessionProofStep, completeSessionProofStep } from "./codeops-session-proof-step-receipts.mjs";
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
const namespaceResource = (uid = "namespace-uid-1") => ({
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
});
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

const brokerContracts = {
  "codeops-session-proof-database-owner": ["database", "password", "username"],
  "codeops-session-broker-database": ["database-url"],
  "codeops-session-broker-read-auth": ["token"],
  "codeops-session-broker-write-auth": ["token"],
  "codeops-session-runtime-worker-auth": ["token"],
  "codeops-session-job-initialization-auth": ["token"],
  "codeops-session-runtime-worker-database": ["database-url", "password"],
};
const runtimeContracts = {
  "ghcr-renoconcierge": [".dockerconfigjson"],
  "codeops-agent-source-credentials": ["repository-read-token"],
};

function buildRevocationInputs() {
  const priorReceiptSources = [];
  const priorEvidenceSources = [];
  const issuanceEvidenceSources = [];
  for (let stepIndex = 2; stepIndex <= 18; stepIndex += 1) {
    const step = sessionProofSequence()[stepIndex];
    const authorization = authorizeSessionProofStep({
      planSource,
      creationReceiptSource,
      priorReceiptSources,
      artifactSource: step.artifact ? `${step.artifact}\n` : undefined,
      namespaceResource: namespaceResource(),
      operator,
      target,
      observedAt: `2026-08-05T18:10:${String(stepIndex).padStart(2, "0")}Z`,
    });
    let evidenceSource;
    if ([2, 3].includes(stepIndex)) {
      const contracts = stepIndex === 2 ? brokerContracts : runtimeContracts;
      const runtime = stepIndex === 3;
      evidenceSource = JSON.stringify(buildSessionProofCredentialEvidence({
        authorization,
        observedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
        secrets: Object.entries(contracts).map(([name, dataKeys]) => ({
          name,
          namespace: identity.namespace,
          uid: `issued-uid-${name}`,
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
      issuanceEvidenceSources.push(evidenceSource);
    } else if (step.id === "start-database") {
      evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
        authorization,
        observedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
        resources: sessionProofApplyResourceIdentities("start-database").map((resource, index) => ({
          ...resource,
          uid: `database-resource-uid-${index}`,
        })),
      }));
    } else if (step.id === "start-gateway") {
      evidenceSource = JSON.stringify(buildSessionProofApplyEvidence({
        authorization,
        observedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
        resources: sessionProofApplyResourceIdentities("start-gateway").map((resource, index) => ({
          ...resource,
          uid: `gateway-resource-uid-${index}`,
        })),
      }));
    } else if (step.id === "wait-database") {
      evidenceSource = JSON.stringify(buildSessionProofReadinessEvidence({
        authorization,
        databaseApplyReceiptSource: priorReceiptSources.at(-1),
        databaseApplyEvidenceSource: priorEvidenceSources.at(-1),
        deployment: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "codeops-session-proof-database",
            namespace: identity.namespace,
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
        observedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
      }));
    } else if (step.id === "wait-gateway-migration") {
      evidenceSource = JSON.stringify(buildSessionProofGatewayReadinessEvidence({
        authorization,
        gatewayApplyReceiptSource: priorReceiptSources.at(-1),
        gatewayApplyEvidenceSource: priorEvidenceSources.at(-1),
        deployment: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: {
            name: "codeops-control-gateway",
            namespace: identity.namespace,
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
        observedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
      }));
    } else {
      evidenceSource = JSON.stringify({
        apiVersion: "codeops.renoconcierge.ca/session-proof-step-evidence/v1",
        result: "verified",
        observedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
        planSha256,
        stepId: step.id,
        namespace: { name: identity.namespace, uid: admission.namespaceUid },
      });
    }
    priorEvidenceSources.push(evidenceSource);
    priorReceiptSources.push(JSON.stringify(completeSessionProofStep(authorization, {
      namespaceResource: namespaceResource(),
      operator,
      target,
      completedAt: `2026-08-05T18:11:${String(stepIndex).padStart(2, "0")}Z`,
      evidenceSource,
    })));
  }
  const authorization = authorizeSessionProofStep({
    planSource,
    creationReceiptSource,
    priorReceiptSources,
    namespaceResource: namespaceResource(),
    operator,
    target,
    observedAt: "2026-08-05T19:20:00Z",
  });
  return { authorization, priorReceiptSources, issuanceEvidenceSources };
}

function makeRunner(inputs, options = {}) {
  const calls = [];
  const uids = new Map();
  for (const source of inputs.issuanceEvidenceSources) {
    for (const secret of JSON.parse(source).credentialInventory) uids.set(secret.name, secret.uid);
  }
  const issuedCount = uids.size;
  const firstName = [...uids.keys()].sort()[0];
  let recreated = false;
  if (options.replacementName) uids.set(options.replacementName, "replacement-uid");
  let deleteCount = 0;
  const rawConfig = JSON.stringify({
    clusters: [{ cluster: {
      server: target.server,
      "certificate-authority-data": Buffer.from("synthetic-ca").toString("base64"),
    } }],
    users: [{ user: {
      "client-certificate-data": certificateData,
      "client-key-data": Buffer.from("synthetic-client-key").toString("base64"),
    } }],
  });
  const runner = (_file, args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "config current-context") return `${target.context}\n`;
    if (key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (key === "config view --minify --raw -o json") return rawConfig;
    if (key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (key.includes("jsonpath={.users[0].user.client-certificate-data}")) return certificateData;
    if (key.startsWith(`get namespace ${identity.namespace}`)) {
      if (options.recreateAfterFinalIdentity && deleteCount === issuedCount && !recreated) {
        uids.set(firstName, "replacement-after-absence-uid");
        recreated = true;
      }
      return JSON.stringify(namespaceResource(
        options.replaceNamespaceAfterDelete && deleteCount === issuedCount
          ? "replacement-namespace-uid"
          : admission.namespaceUid,
      ));
    }
    if (args[2] === "get" && args[3] === "secret") return `${uids.get(args[4]) ?? ""}\n`;
    throw new Error(`unexpected kubectl call: ${key}`);
  };
  const deleteRequest = async ({ name, uid }) => {
    deleteCount += 1;
    if (options.rejectDelete) {
      return { statusCode: 409, contentType: "application/json", body: "{}" };
    }
    assert.equal(uids.get(name), uid);
    uids.delete(name);
    return {
      statusCode: 200,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: "v1", kind: "Status", status: "Success" }),
    };
  };
  return { calls, deleteRequest, runner, uids, get deleteCount() { return deleteCount; } };
}

test("constructs a namespaced Secret DELETE with one exact UID precondition", () => {
  const value = createCredentialDeleteRequest({
    namespace: identity.namespace,
    name: "codeops-session-broker-read-auth",
    uid: "issued-uid",
  });
  assert.equal(value.path, `/api/v1/namespaces/${identity.namespace}/secrets/codeops-session-broker-read-auth`);
  assert.deepEqual(JSON.parse(value.body), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    preconditions: { uid: "issued-uid" },
  });
});

test("deletes exactly the nine issued Secret UIDs and receipts verified absence", async () => {
  const inputs = buildRevocationInputs();
  const stub = makeRunner(inputs);
  const result = await revokeSessionProofCredentials({
    ...inputs,
    startedAt: "2026-08-05T19:21:00Z",
    completedAt: "2026-08-05T19:22:00Z",
  }, {
    runner: stub.runner,
    deleteRequest: stub.deleteRequest,
    now: () => new Date("2026-08-05T19:22:00Z"),
    sleep: async () => {},
  });
  assert.equal(stub.deleteCount, 9);
  assert.equal(stub.uids.size, 0);
  assert.equal(result.receipt.stepId, "revoke-capabilities");
  assert.equal(result.receipt.result, "completed");
  assert.equal(JSON.parse(result.evidenceSource).absentCredentialNames.length, 9);
  assert.equal(stub.calls.some((args) => ["delete", "apply", "patch"].includes(args[0])), false);
});

test("resumes safely when an originally issued Secret is already absent", async () => {
  const inputs = buildRevocationInputs();
  const stub = makeRunner(inputs);
  const firstName = JSON.parse(inputs.issuanceEvidenceSources[1]).credentialInventory[0].name;
  stub.uids.delete(firstName);
  const result = await revokeSessionProofCredentials({
    ...inputs,
    startedAt: "2026-08-05T19:21:00Z",
    completedAt: "2026-08-05T19:22:00Z",
  }, { runner: stub.runner, deleteRequest: stub.deleteRequest });
  assert.equal(stub.deleteCount, 8);
  assert.equal(result.receipt.result, "completed");
});

test("rejects a same-name replacement before deleting any Secret", async () => {
  const inputs = buildRevocationInputs();
  const firstName = [...new Map(
    inputs.issuanceEvidenceSources.flatMap((source) =>
      JSON.parse(source).credentialInventory.map((secret) => [secret.name, secret.uid])),
  ).keys()].sort()[0];
  const stub = makeRunner(inputs, { replacementName: firstName });
  await assert.rejects(revokeSessionProofCredentials({
    ...inputs,
    startedAt: "2026-08-05T19:21:00Z",
    completedAt: "2026-08-05T19:22:00Z",
  }, { runner: stub.runner, deleteRequest: stub.deleteRequest }), /UID drifted/);
  assert.equal(stub.deleteCount, 0);
});

test("rejects issuance evidence or receipt-chain drift before live access", async () => {
  const inputs = buildRevocationInputs();
  const evidence = JSON.parse(inputs.issuanceEvidenceSources[0]);
  evidence.credentialInventory[0].uid = "substituted-uid";
  const stub = makeRunner(inputs);
  await assert.rejects(revokeSessionProofCredentials({
    ...inputs,
    issuanceEvidenceSources: [JSON.stringify(evidence), inputs.issuanceEvidenceSources[1]],
    startedAt: "2026-08-05T19:21:00Z",
    completedAt: "2026-08-05T19:22:00Z",
  }, { runner: stub.runner, deleteRequest: stub.deleteRequest }), /evidence digest drifted/);
  assert.equal(stub.calls.length, 0);
});

test("withholds the receipt after delete rejection, replacement, or final absence drift", async () => {
  for (const [options, pattern] of [
    [{ rejectDelete: true }, /UID-preconditioned/],
    [{ replaceNamespaceAfterDelete: true }, /Namespace UID drifted/],
    [{ recreateAfterFinalIdentity: true }, /absence drifted/],
  ]) {
    const inputs = buildRevocationInputs();
    const stub = makeRunner(inputs, options);
    await assert.rejects(revokeSessionProofCredentials({
      ...inputs,
      startedAt: "2026-08-05T19:21:00Z",
      completedAt: "2026-08-05T19:22:00Z",
    }, { runner: stub.runner, deleteRequest: stub.deleteRequest }), pattern);
  }
});
