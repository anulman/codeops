import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import {
  issueFirstSessionProofCredentialsFromOperatorPacket,
} from "./codeops-session-proof-credential-issuer.mjs";
import { createSessionProofNamespace } from "./codeops-session-proof-namespace-create.mjs";
import { attachSessionProofOperatorAdmission } from "./codeops-session-proof-operator-admission.mjs";
import { createSessionProofNamespaceFromOperatorPacket } from "./codeops-session-proof-operator-namespace-create.mjs";
import {
  authorizeFirstSessionProofStepFromOperatorPacket,
  persistFirstSessionProofStepAuthorizationFromOperatorPacket,
} from "./codeops-session-proof-operator-step-authorization.mjs";
import { persistSessionProofOperatorPacket } from "./codeops-session-proof-operator-packet.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";

const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};
const namespaceManifestSource = "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: codeops-session-proof-video-1\n";
const certificateData = Buffer.from("synthetic-client-certificate").toString("base64");
const operator = {
  username: "kubernetes-admin",
  uid: null,
  credentialSha256: createHash("sha256")
    .update(Buffer.from(certificateData, "base64"))
    .digest("hex"),
};
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const artifactIds = [
  "namespace", "database", "gateway", "grants", "codex-login", "codex-smoke", "ui", "runtime",
];
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts: artifactIds.map((id, index) => ({
    id,
    sha256: id === "namespace"
      ? createHash("sha256").update(namespaceManifestSource).digest("hex")
      : `${index}`.repeat(64),
  })),
  sequence: sessionProofSequence(),
});
const admission = createSessionProofAdmission({
  planSource,
  reviewedPlanSha256: createHash("sha256").update(planSource).digest("hex"),
  operator,
  target,
  approvedAt: "2026-08-05T05:00:00Z",
  expiresAt: "2026-08-05T08:00:00Z",
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

function persistOperatorInputs(root) {
  const artifactSources = Object.fromEntries(artifactIds.map((id) => [
    id,
    id === "namespace" ? namespaceManifestSource : `synthetic-${id}-artifact\n`,
  ]));
  const packetPlanSource = JSON.stringify({
    apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
    admission: "closed",
    execution: "render-and-review-only",
    identity,
    artifacts: artifactIds.map((id) => ({
      id,
      sha256: createHash("sha256").update(artifactSources[id]).digest("hex"),
    })),
    sequence: sessionProofSequence(),
  });
  const packetPath = join(root, `${identity.namespace}.packet`);
  const admissionPath = join(root, `${identity.namespace}.admission.json`);
  const receiptPath = join(root, `${identity.namespace}.namespace-create-receipt.json`);
  const authorizationPath = join(
    root,
    `${identity.namespace}.step-02-issue-broker-capabilities.authorization.json`,
  );
  persistSessionProofOperatorPacket({ packetPath, planSource: packetPlanSource, artifactSources });
  attachSessionProofOperatorAdmission({
    packetPath,
    admissionPath,
    operator,
    target,
    approvedAt: "2026-08-05T05:00:00Z",
    expiresAt: "2026-08-05T08:00:00Z",
  });
  return { packetPath, admissionPath, receiptPath, authorizationPath };
}

function namespace() {
  return {
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
}

function runner(initiallyPresent = false, failCreateAfterNamespace = false) {
  let created = initiallyPresent;
  let issued = false;
  const calls = [];
  const execute = (file, args, options = {}) => {
    calls.push({ file, args, options });
    const key = args.join(" ");
    if (file.endsWith("issue-codeops-session-proof-secrets.sh")) {
      issued = true;
      return "issued\n";
    }
    if (
      file === "kubectl" &&
      args[0] === "-n" &&
      args[2] === "get" &&
      args[3] === "secret"
    ) {
      assert.equal(issued, true);
      const name = args[4];
      return [
        `secret-uid-${name}`,
        "Opaque",
        "codeops-session-proof",
        "session-video-proof",
        ...brokerContracts[name],
        "",
      ].join("\n");
    }
    if (key === "config current-context") return `${target.context}\n`;
    if (key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (key.includes("jsonpath={.users[0].user.client-certificate-data}")) return certificateData;
    if (key.startsWith("get namespace ")) return created ? JSON.stringify(namespace()) : "";
    if (key === "create --filename - --request-timeout=30s") {
      assert.equal(options.input, namespaceManifestSource);
      created = true;
      if (failCreateAfterNamespace) throw new Error("synthetic partial create");
      return "created\n";
    }
    throw new Error(`unexpected kubectl call: ${key}`);
  };
  return { calls, execute };
}

test("creates only the reviewed namespace package after live preflight and binds its UID", () => {
  const stub = runner();
  const result = createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  assert.equal(result.result, "created-and-uid-bound");
  assert.equal(result.namespace.uid, "namespace-uid-1");
  assert.equal(result.admission.state, "approved-bound");
  assert.equal(result.proceed, true);
  const mutations = stub.calls.filter(({ args }) => args[0] === "create");
  assert.equal(mutations.length, 1);
  assert.deepEqual(mutations[0].args, ["create", "--filename", "-", "--request-timeout=30s"]);
});

test("returns a UID-bound non-proceed receipt after partial package creation", () => {
  const stub = runner(false, true);
  const result = createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  assert.equal(result.result, "namespace-uid-bound-create-incomplete");
  assert.equal(result.proceed, false);
  assert.equal(result.admission.namespaceUid, "namespace-uid-1");
});

test("rejects manifest drift or an existing namespace before create", () => {
  const drift = runner();
  assert.throws(() => createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource: `${namespaceManifestSource}\n`,
    observedAt: "2026-08-05T06:00:00Z",
  }, drift.execute));
  assert.equal(drift.calls.length, 0);
  const existing = runner(true);
  assert.throws(() => createSessionProofNamespace({
    planSource,
    admission,
    namespaceManifestSource,
    observedAt: "2026-08-05T06:00:00Z",
  }, existing.execute));
  assert.equal(existing.calls.some(({ args }) => args[0] === "create"), false);
});

test("creates from only the exact operator packet and attached admission", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    const result = createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    assert.equal(result.result, "created-and-uid-bound");
    assert.equal(result.admission.namespaceUid, "namespace-uid-1");
    assert.deepEqual(Object.keys(result).sort(), [
      "admission",
      "apiVersion",
      "checkedAt",
      "namespace",
      "namespaceManifestSha256",
      "planSha256",
      "proceed",
      "result",
    ]);
    assert.equal(stub.calls.filter(({ args }) => args[0] === "create").length, 1);
    assert.equal(statSync(inputs.receiptPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(inputs.receiptPath, "utf8")), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a substituted or existing creation receipt before Kubernetes access", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    assert.throws(() => createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      receiptPath: join(root, "substituted-receipt.json"),
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute), /derive exactly/i);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.receiptPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists the UID-bound non-proceed receipt after partial package creation", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner(false, true);
    const result = createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    assert.equal(result.result, "namespace-uid-bound-create-incomplete");
    assert.equal(result.proceed, false);
    assert.equal(result.namespace.uid, "namespace-uid-1");
    assert.deepEqual(JSON.parse(readFileSync(inputs.receiptPath, "utf8")), result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorizes only the first intermediate step from the exact persisted operator artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    const mutationCount = stub.calls.filter(({ args }) => args[0] === "create").length;
    const authorization = persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    assert.equal(authorization.stepIndex, 2);
    assert.equal(authorization.stepId, "issue-broker-capabilities");
    assert.equal(authorization.artifact, null);
    assert.equal(statSync(inputs.authorizationPath).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(inputs.authorizationPath, "utf8")),
      authorization,
    );
    assert.equal(
      stub.calls.filter(({ args }) => args[0] === "create").length,
      mutationCount,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the broker issuer consumes only the exact persisted first-step authorization", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    const result = issueFirstSessionProofCredentialsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute);
    assert.equal(result.receipt.stepId, "issue-broker-capabilities");
    assert.equal(result.receipt.previousReceiptSha256,
      createHash("sha256").update(readFileSync(inputs.receiptPath)).digest("hex"));
    assert.equal(
      stub.calls.filter(({ file }) => file.endsWith("issue-codeops-session-proof-secrets.sh")).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorization drift fails before the broker issuer is invoked", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const stub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute);
    persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute);
    const authorization = JSON.parse(readFileSync(inputs.authorizationPath, "utf8"));
    writeFileSync(inputs.authorizationPath, `${JSON.stringify({
      ...authorization,
      action: "operator-apply",
    }, null, 2)}\n`);
    assert.throws(() => issueFirstSessionProofCredentialsFromOperatorPacket({
      ...inputs,
      startedAt: "2026-08-05T06:02:00Z",
      completedAt: "2026-08-05T06:03:00Z",
    }, stub.execute), /exact persisted artifact/);
    assert.equal(
      stub.calls.some(({ file }) => file.endsWith("issue-codeops-session-proof-secrets.sh")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a substituted or existing first-step authorization before live reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, runner().execute);
    const stub = runner(true);
    assert.throws(() => persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      authorizationPath: join(root, "substituted.authorization.json"),
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute), /derive exactly/);
    assert.equal(stub.calls.length, 0);

    writeFileSync(inputs.authorizationPath, "occupied\n", { mode: 0o600 });
    assert.throws(() => persistFirstSessionProofStepAuthorizationFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute), /already exists/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects creation-receipt drift or an incomplete create before live authorization reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const driftedInputs = persistOperatorInputs(root);
    const createStub = runner();
    createSessionProofNamespaceFromOperatorPacket({
      ...driftedInputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, createStub.execute);
    const receipt = JSON.parse(readFileSync(driftedInputs.receiptPath, "utf8"));
    writeFileSync(
      driftedInputs.receiptPath,
      `${JSON.stringify({ ...receipt, checkedAt: "2026-08-05T09:00:00Z" }, null, 2)}\n`,
    );
    const timeDriftStub = runner(true);
    assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
      ...driftedInputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, timeDriftStub.execute), /outcome drifted/);
    assert.equal(timeDriftStub.calls.length, 0);

    writeFileSync(
      driftedInputs.receiptPath,
      `${JSON.stringify({ ...receipt, extra: true }, null, 2)}\n`,
    );
    const driftStub = runner(true);
    assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
      ...driftedInputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, driftStub.execute), /exact persisted artifact/);
    assert.equal(driftStub.calls.length, 0);

    const incompleteRoot = mkdtempSync(join(tmpdir(), "session-proof-create-incomplete-"));
    try {
      const incompleteInputs = persistOperatorInputs(incompleteRoot);
      createSessionProofNamespaceFromOperatorPacket({
        ...incompleteInputs,
        observedAt: "2026-08-05T06:00:00Z",
      }, runner(false, true).execute);
      const incompleteStub = runner(true);
      assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
        ...incompleteInputs,
        observedAt: "2026-08-05T06:01:00Z",
      }, incompleteStub.execute), /did not admit/);
      assert.equal(incompleteStub.calls.length, 0);
    } finally {
      rmSync(incompleteRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a permission-weakened creation receipt before live authorization reads", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, runner().execute);
    chmodSync(inputs.receiptPath, 0o644);
    const stub = runner(true);
    assert.throws(() => authorizeFirstSessionProofStepFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:01:00Z",
    }, stub.execute), /bounded private regular file/);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects packet attachment drift before any create preflight read", () => {
  const root = mkdtempSync(join(tmpdir(), "session-proof-create-"));
  try {
    const inputs = persistOperatorInputs(root);
    const admissionValue = JSON.parse(readFileSync(inputs.admissionPath, "utf8"));
    writeFileSync(
      inputs.admissionPath,
      `${JSON.stringify({ ...admissionValue, extra: true }, null, 2)}\n`,
    );
    const stub = runner();
    assert.throws(() => createSessionProofNamespaceFromOperatorPacket({
      ...inputs,
      observedAt: "2026-08-05T06:00:00Z",
    }, stub.execute), /exact attached artifact/i);
    assert.equal(stub.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
