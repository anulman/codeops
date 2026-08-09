import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSessionProofAdmission } from "./codeops-session-proof-admission.mjs";
import { sessionProofSequence } from "./codeops-session-proof-plan.mjs";
import {
  createSessionProofReadSnapshot,
  runSessionProofPreflight,
} from "./codeops-session-proof-preflight.mjs";

const certificateData = Buffer.from("synthetic-client-certificate").toString("base64");
const credentialSha256 = createHash("sha256")
  .update(Buffer.from(certificateData, "base64"))
  .digest("hex");
const operator = { username: "kubernetes-admin", uid: null, credentialSha256 };
const target = { context: "proof-context", server: "https://cluster.example.invalid" };
const identity = {
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
  baseSha: "a".repeat(40),
  sessionSuffix: "video-1",
};
const artifactIds = [
  "namespace", "database", "gateway", "grants", "codex-login", "codex-smoke", "ui", "runtime",
];
const planSource = JSON.stringify({
  apiVersion: "codeops.renoconcierge.ca/session-proof-plan/v1",
  admission: "closed",
  execution: "render-and-review-only",
  identity,
  artifacts: artifactIds.map((id, index) => ({ id, sha256: `${index}`.repeat(64) })),
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

function runner(overrides = {}) {
  const calls = [];
  const execute = (_file, args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "config current-context") return `${target.context}\n`;
    if (key === "config view --minify -o json") {
      return JSON.stringify({ clusters: [{ cluster: { server: target.server } }] });
    }
    if (key === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: operator.username } } });
    }
    if (key.includes("jsonpath={.users[0].user.client-certificate-data}")) {
      return certificateData;
    }
    if (key.startsWith("get namespace ")) return overrides.namespace ?? "";
    throw new Error(`unexpected kubectl call: ${key}`);
  };
  return { calls, execute };
}

test("attests the exact live principal, certificate, target, plan, and namespace absence", () => {
  const stub = runner();
  const result = runSessionProofPreflight({
    planSource,
    admission,
    observedAt: "2026-08-05T06:00:00Z",
  }, stub.execute);
  assert.equal(result.result, "ready-for-reviewed-namespace-creation");
  assert.deepEqual(result.operator, operator);
  assert.deepEqual(result.target, target);
  assert.equal(result.namespace.state, "absent");
  assert.equal(stub.calls.length, 5);
  assert.ok(stub.calls.every((args) => ["config", "auth", "get"].includes(args[0])));
});

test("rejects an existing namespace, principal drift, and plan drift without mutation", () => {
  const existing = runner({ namespace: JSON.stringify({
    apiVersion: "v1", kind: "Namespace", metadata: { name: identity.namespace, uid: "replacement" },
  }) });
  assert.throws(() => runSessionProofPreflight({
    planSource, admission, observedAt: "2026-08-05T06:00:00Z",
  }, existing.execute));
  const wrongPrincipal = runner();
  wrongPrincipal.execute = (_file, args) => {
    if (args.join(" ") === "auth whoami -o json") {
      return JSON.stringify({ status: { userInfo: { username: "other" } } });
    }
    return runner().execute(_file, args);
  };
  assert.throws(() => runSessionProofPreflight({
    planSource, admission, observedAt: "2026-08-05T06:00:00Z",
  }, wrongPrincipal.execute));
  assert.throws(() => runSessionProofPreflight({
    planSource: `${planSource}\n`, admission, observedAt: "2026-08-05T06:00:00Z",
  }, runner().execute));
});

test("snapshots each reviewed Kubernetes read once and rejects mutation commands", () => {
  const stub = runner();
  const snapshot = createSessionProofReadSnapshot(stub.execute);
  const options = { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000 };
  assert.equal(snapshot("kubectl", ["config", "current-context"], options), `${target.context}\n`);
  assert.equal(snapshot("kubectl", ["config", "current-context"], options), `${target.context}\n`);
  assert.equal(stub.calls.length, 1);
  assert.equal(createSessionProofReadSnapshot(snapshot), snapshot);
  assert.throws(
    () => snapshot("kubectl", ["create", "namespace", identity.namespace], options),
    /admits only reviewed Kubernetes identity and Namespace reads/,
  );
  assert.throws(
    () => snapshot("sh", ["-c", "true"], options),
    /admits only reviewed kubectl reads/,
  );
  assert.equal(stub.calls.length, 1);
});
