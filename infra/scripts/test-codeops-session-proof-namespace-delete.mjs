import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  createNamespaceDeleteRequest,
  deleteSessionProofNamespace,
} from "./codeops-session-proof-namespace-delete.mjs";
import {
  deleteSessionProofNamespaceFromOperatorPacket,
  persistSessionProofNamespaceDeletionFromOperatorPacket,
  readSessionProofNamespaceDeletionOutputsFromOperatorPacket,
} from "./codeops-session-proof-operator-namespace-delete.mjs";
import {
  buildSessionProofCredentialRevocationEvidence,
  sessionProofCredentialNames,
} from "./codeops-session-proof-credential-revocation-evidence.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
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
const artifactIds = [
  "namespace", "database", "gateway", "grants", "codex-login", "codex-smoke", "ui", "runtime",
];
const planSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts: artifactIds.map((id, index) => ({ id, sha256: `${index}`.repeat(64) })),
  sequence: sessionProofSequence(),
});
const unbound = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: createHash("sha256").update(planSource).digest("hex"),
  operator,
  target,
  approvedAt: "2026-08-05T05:00:00Z",
  expiresAt: "2026-08-05T08:00:00Z",
});
const admission = { ...unbound, state: "approved-bound", namespaceUid: "namespace-uid-1" };
const creationReceipt = {
  apiVersion: "codeops.example/session-proof-namespace-create/v1",
  result: "created-and-uid-bound",
  checkedAt: "2026-08-05T06:00:00Z",
  planSha256: admission.planSha256,
  namespaceManifestSha256: "f".repeat(64),
  namespace: { name: identity.namespace, uid: admission.namespaceUid },
  proceed: true,
  admission,
};
const revocationAuthorization = {
  planSha256: admission.planSha256,
  stepId: "revoke-capabilities",
  action: "operator-revoke-exact-secrets",
  namespace: creationReceipt.namespace,
};
const revocationEvidenceSource = JSON.stringify(buildSessionProofCredentialRevocationEvidence({
  authorization: revocationAuthorization,
  observedAt: "2026-08-05T06:20:00Z",
  absentCredentialNames: sessionProofCredentialNames(),
}));
const revocationReceiptSource = JSON.stringify({
  apiVersion: "codeops.example/session-proof-step-receipt/v1",
  result: "completed",
  proceed: true,
  checkedAt: "2026-08-05T06:21:00Z",
  planSha256: admission.planSha256,
  namespace: creationReceipt.namespace,
  stepIndex: sessionProofSequence().findIndex((step) => step.id === "revoke-capabilities"),
  stepId: "revoke-capabilities",
  action: "operator-revoke-exact-secrets",
  artifact: null,
  artifactSha256: null,
  previousReceiptSha256: "b".repeat(64),
  evidenceSha256: createHash("sha256").update(revocationEvidenceSource).digest("hex"),
});

function deletionInput(overrides = {}) {
  return {
    planSource,
    creationReceipt,
    revocationReceiptSource,
    revocationEvidenceSource,
    observedAt: "2026-08-05T06:30:00Z",
    ...overrides,
  };
}

function namespace(uid = admission.namespaceUid) {
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

function runner(namespaceReads = [namespace(), null, null]) {
  const calls = [];
  const reads = [...namespaceReads];
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
  const execute = (_file, args) => {
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
    if (key.startsWith("get namespace ")) {
      const value = reads.length > 1 ? reads.shift() : reads[0];
      return value ? JSON.stringify(value) : "";
    }
    throw new Error(`unexpected kubectl call: ${key}`);
  };
  return { calls, execute };
}

const success = {
  statusCode: 200,
  contentType: "application/json",
  body: JSON.stringify({ apiVersion: "v1", kind: "Status", status: "Success" }),
};

test("hands only exact persisted revocation outputs to Namespace deletion", async () => {
  const receiptKeys = [
    "stepReceiptSource", "secondStepReceiptSource", "thirdStepReceiptSource",
    "fourthStepReceiptSource", "fifthStepReceiptSource", "sixthStepReceiptSource",
    "seventhStepReceiptSource", "eighthStepReceiptSource", "ninthStepReceiptSource",
    "tenthStepReceiptSource", "eleventhStepReceiptSource", "twelfthStepReceiptSource",
    "thirteenthStepReceiptSource", "fourteenthStepReceiptSource", "fifteenthStepReceiptSource",
    "sixteenthStepReceiptSource", "seventeenthStepReceiptSource", "eighteenthStepReceiptSource",
    "nineteenthStepReceiptSource",
  ];
  const outputs = {
    planSource,
    creationReceipt,
    creationReceiptSource: JSON.stringify(creationReceipt),
    nineteenthEvidenceSource: revocationEvidenceSource,
    ...Object.fromEntries(receiptKeys.map((key, index) => [key, `receipt-${index + 1}`])),
  };
  outputs.nineteenthStepReceiptSource = revocationReceiptSource;
  const stub = runner([namespace(), namespace()]);
  let received;
  const result = await deleteSessionProofNamespaceFromOperatorPacket(
    { packetPath: "/private/operator.packet", observedAt: "2026-08-05T06:30:00Z" },
    stub.execute,
    async (deletionInput, dependencies) => {
      received = deletionInput;
      assert.equal(dependencies.runner, stub.execute);
      return { accepted: true };
    },
    () => outputs,
    (authorizationInput) => {
      assert.deepEqual(authorizationInput.priorReceiptSources, receiptKeys.map((key) => outputs[key]));
      assert.equal(authorizationInput.namespaceResource.metadata.uid, admission.namespaceUid);
      return { stepId: "delete-namespace", authorizedAt: "2026-08-05T06:30:00Z" };
    },
  );
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(received, {
    planSource,
    creationReceipt,
    revocationReceiptSource,
    revocationEvidenceSource,
    observedAt: "2026-08-05T06:30:00Z",
  });
});

test("reserves and persists exact private Namespace deletion and final absence outputs", async () => {
  const deletionRunner = runner();
  const completed = await deleteSessionProofNamespace(deletionInput(), {
    runner: deletionRunner.execute,
    deleteRequest: async () => success,
    now: () => new Date("2026-08-05T06:30:00Z"),
    sleep: async () => {},
  });
  const root = mkdtempSync(join(tmpdir(), "session-proof-namespace-deletion-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const paths = {
      twentiethEvidencePath: join(root, `${identity.namespace}.step-24-delete-namespace.evidence.json`),
      twentiethStepReceiptPath: join(root, `${identity.namespace}.step-24-delete-namespace.receipt.json`),
      twentyFirstEvidencePath: join(root, `${identity.namespace}.step-25-verify-teardown.evidence.json`),
      twentyFirstStepReceiptPath: join(root, `${identity.namespace}.step-25-verify-teardown.receipt.json`),
    };
    let deleteCalls = 0;
    const persisted = await persistSessionProofNamespaceDeletionFromOperatorPacket({
      packetPath,
      ...paths,
    }, undefined, async () => {
      deleteCalls += 1;
      for (const path of Object.values(paths)) {
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(path).size, 0);
      }
      return completed;
    });
    assert.equal(deleteCalls, 1);
    assert.deepEqual(persisted, {
      deletionEvidenceSource: completed.deleteEvidenceSource,
      deletionReceiptSource: completed.deleteReceiptSource,
      teardownEvidenceSource: completed.teardownEvidenceSource,
      teardownReceiptSource: JSON.stringify(completed.teardownReceipt),
    });
    assert.equal(readFileSync(paths.twentiethEvidencePath, "utf8"), completed.deleteEvidenceSource);
    assert.equal(readFileSync(paths.twentiethStepReceiptPath, "utf8"), completed.deleteReceiptSource);
    assert.equal(readFileSync(paths.twentyFirstEvidencePath, "utf8"), completed.teardownEvidenceSource);
    assert.equal(
      readFileSync(paths.twentyFirstStepReceiptPath, "utf8"),
      JSON.stringify(completed.teardownReceipt),
    );
    for (const path of Object.values(paths)) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.deepEqual(readSessionProofNamespaceDeletionOutputsFromOperatorPacket({
      packetPath,
      ...paths,
    }), {
      twentiethEvidenceSource: completed.deleteEvidenceSource,
      twentiethStepReceiptSource: completed.deleteReceiptSource,
      twentyFirstEvidenceSource: completed.teardownEvidenceSource,
      twentyFirstStepReceiptSource: JSON.stringify(completed.teardownReceipt),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects drifted persisted Namespace deletion or final absence outputs", async () => {
  const completed = await deleteSessionProofNamespace(deletionInput(), {
    runner: runner().execute,
    deleteRequest: async () => success,
    now: () => new Date("2026-08-05T06:30:00Z"),
    sleep: async () => {},
  });
  const root = mkdtempSync(join(tmpdir(), "session-proof-namespace-deletion-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const paths = {
      twentiethEvidencePath: join(root, `${identity.namespace}.step-24-delete-namespace.evidence.json`),
      twentiethStepReceiptPath: join(root, `${identity.namespace}.step-24-delete-namespace.receipt.json`),
      twentyFirstEvidencePath: join(root, `${identity.namespace}.step-25-verify-teardown.evidence.json`),
      twentyFirstStepReceiptPath: join(root, `${identity.namespace}.step-25-verify-teardown.receipt.json`),
    };
    await persistSessionProofNamespaceDeletionFromOperatorPacket({
      packetPath,
      ...paths,
    }, undefined, async () => completed);
    writeFileSync(paths.twentyFirstStepReceiptPath, JSON.stringify({
      ...completed.teardownReceipt,
      checkedAt: "2026-08-05T06:31:00Z",
    }), { mode: 0o600 });
    assert.throws(() => readSessionProofNamespaceDeletionOutputsFromOperatorPacket({
      packetPath,
      ...paths,
    }), /exact persisted artifacts/);
    writeFileSync(
      paths.twentyFirstStepReceiptPath,
      JSON.stringify(completed.teardownReceipt),
    );
    chmodSync(paths.twentyFirstStepReceiptPath, 0o644);
    assert.throws(() => readSessionProofNamespaceDeletionOutputsFromOperatorPacket({
      packetPath,
      ...paths,
    }), /bounded private regular file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsafe or occupied Namespace deletion outputs before the deleter", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-namespace-deletion-"));
  try {
    const packetPath = join(root, `${identity.namespace}.packet`);
    const paths = {
      twentiethEvidencePath: join(root, `${identity.namespace}.step-24-delete-namespace.evidence.json`),
      twentiethStepReceiptPath: join(root, `${identity.namespace}.step-24-delete-namespace.receipt.json`),
      twentyFirstEvidencePath: join(root, `${identity.namespace}.step-25-verify-teardown.evidence.json`),
      twentyFirstStepReceiptPath: join(root, `${identity.namespace}.step-25-verify-teardown.receipt.json`),
    };
    let deleteCalls = 0;
    await assert.rejects(() => persistSessionProofNamespaceDeletionFromOperatorPacket({
      packetPath,
      ...paths,
      twentiethEvidencePath: join(root, "substituted.evidence.json"),
    }, undefined, async () => { deleteCalls += 1; }), /derive exactly/);
    writeFileSync(paths.twentyFirstStepReceiptPath, "occupied\n", { mode: 0o600 });
    await assert.rejects(() => persistSessionProofNamespaceDeletionFromOperatorPacket({
      packetPath,
      ...paths,
    }, undefined, async () => { deleteCalls += 1; }), /already exists/);
    assert.equal(deleteCalls, 0);
    assert.throws(() => statSync(paths.twentiethEvidencePath), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constructs one foreground DELETE with an exact Namespace UID precondition", () => {
  const value = createNamespaceDeleteRequest({
    namespace: identity.namespace,
    namespaceUid: admission.namespaceUid,
  });
  assert.equal(value.path, `/api/v1/namespaces/${identity.namespace}`);
  assert.deepEqual(JSON.parse(value.body), {
    apiVersion: "v1",
    kind: "DeleteOptions",
    propagationPolicy: "Foreground",
    preconditions: { uid: admission.namespaceUid },
  });
});

test("deletes only the UID-bound Namespace through an API precondition and verifies absence", async () => {
  const stub = runner();
  let request;
  const result = await deleteSessionProofNamespace(deletionInput(), {
    runner: stub.execute,
    deleteRequest: async (value) => {
      request = value;
      return success;
    },
    now: () => new Date("2026-08-05T06:30:00Z"),
    sleep: async () => {},
  });
  assert.equal(result.result, "deleted-and-absence-verified");
  assert.equal(result.proceed, true);
  assert.equal(request.namespace, identity.namespace);
  assert.equal(request.namespaceUid, admission.namespaceUid);
  assert.deepEqual(Object.keys(request).sort(), ["ca", "cert", "key", "namespace", "namespaceUid", "target"]);
  assert.equal(stub.calls.some((args) => ["delete", "apply", "patch"].includes(args[0])), false);
  assert.equal(JSON.parse(result.deleteReceiptSource).stepId, "delete-namespace");
  assert.equal(result.teardownReceipt.stepId, "verify-teardown");
  assert.equal(result.teardownReceipt.previousReceiptSha256,
    createHash("sha256").update(result.deleteReceiptSource).digest("hex"));
  assert.equal(JSON.parse(result.teardownEvidenceSource).namespaceAbsent, true);
});

test("accepts the exact deleting Namespace returned by Kubernetes", async () => {
  const result = await deleteSessionProofNamespace(deletionInput(), {
    runner: runner().execute,
    deleteRequest: async () => ({
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        ...namespace(),
        metadata: {
          ...namespace().metadata,
          deletionTimestamp: "2026-08-05T06:30:00Z",
        },
      }),
    }),
    now: () => new Date("2026-08-05T06:30:00Z"),
    sleep: async () => {},
  });
  assert.equal(result.result, "deleted-and-absence-verified");
  assert.equal(result.proceed, true);
});

test("rejects a drifted or non-deleting Namespace response", async () => {
  for (const responseNamespace of [
    namespace("replacement-uid"),
    { ...namespace(), metadata: { ...namespace().metadata, name: "other" } },
    namespace(),
  ]) {
    await assert.rejects(deleteSessionProofNamespace(deletionInput(), {
      runner: runner().execute,
      deleteRequest: async () => ({
        statusCode: 200,
        contentType: "application/json",
        body: JSON.stringify(responseNamespace),
      }),
      now: () => new Date("2026-08-05T06:30:00Z"),
      sleep: async () => {},
    }), /did not acknowledge/);
  }
});

test("rejects a replaced Namespace, receipt drift, or plan drift before deletion", async () => {
  let deleted = false;
  const deleteRequest = async () => {
    deleted = true;
    return success;
  };
  await assert.rejects(deleteSessionProofNamespace(deletionInput(), {
    runner: runner([namespace("replacement-uid")]).execute,
    deleteRequest,
    now: () => new Date("2026-08-05T06:30:00Z"),
  }));
  await assert.rejects(deleteSessionProofNamespace(deletionInput({
    creationReceipt: { ...creationReceipt, namespace: { ...creationReceipt.namespace, uid: "other" } },
  }), {
    runner: runner().execute,
    deleteRequest,
    now: () => new Date("2026-08-05T06:30:00Z"),
  }));
  await assert.rejects(deleteSessionProofNamespace(deletionInput({
    planSource: `${planSource}\n`,
  }), {
    runner: runner().execute,
    deleteRequest,
    now: () => new Date("2026-08-05T06:30:00Z"),
  }));
  assert.equal(deleted, false);
});

test("does not report teardown after the API rejects the UID precondition", async () => {
  await assert.rejects(deleteSessionProofNamespace(deletionInput(), {
    runner: runner().execute,
    deleteRequest: async () => ({
      statusCode: 409,
      contentType: "application/json",
      body: JSON.stringify({ apiVersion: "v1", kind: "Status", status: "Failure" }),
    }),
    now: () => new Date("2026-08-05T06:30:00Z"),
  }), /UID-preconditioned/);
});

test("fails closed if the active raw client certificate changes before deletion", async () => {
  const stub = runner();
  const base = stub.execute;
  stub.execute = (file, args) => {
    if (args.join(" ") === "config view --minify --raw -o json") {
      const value = JSON.parse(base(file, args));
      value.users[0].user["client-certificate-data"] = Buffer.from("other-certificate").toString("base64");
      return JSON.stringify(value);
    }
    return base(file, args);
  };
  await assert.rejects(deleteSessionProofNamespace(deletionInput(), {
    runner: stub.execute,
    deleteRequest: async () => success,
    now: () => new Date("2026-08-05T06:30:00Z"),
  }), /certificate drifted/);
});

test("rejects missing, substituted, oversized, or late revocation evidence before live access", async () => {
  const substitutions = [
    { revocationReceiptSource: undefined },
    { revocationEvidenceSource: undefined },
    { revocationEvidenceSource: "x".repeat(65 * 1024) },
    { revocationEvidenceSource: `${revocationEvidenceSource}\n` },
    { observedAt: "2026-08-05T06:20:30Z" },
  ];
  for (const override of substitutions) {
    const stub = runner();
    await assert.rejects(deleteSessionProofNamespace(deletionInput(override), {
      runner: stub.execute,
      deleteRequest: async () => success,
      now: () => new Date("2026-08-05T06:30:00Z"),
    }), /credential[- ]revocation|bounded|revoke-capabilities/);
    assert.equal(stub.calls.length, 0);
  }
});

test("keeps UID-bound emergency cleanup available after incomplete namespace creation", async () => {
  const incompleteReceipt = {
    ...creationReceipt,
    result: "namespace-uid-bound-create-incomplete",
    proceed: false,
  };
  const stub = runner();
  const result = await deleteSessionProofNamespace({
    planSource,
    creationReceipt: incompleteReceipt,
    observedAt: "2026-08-05T06:30:00Z",
  }, {
    runner: stub.execute,
    deleteRequest: async () => success,
    now: () => new Date("2026-08-05T06:30:00Z"),
    sleep: async () => {},
  });
  assert.equal(result.result, "deleted-and-absence-verified");
  assert.equal(result.deleteReceiptSource, null);
  assert.equal(result.teardownReceipt, null);
});
