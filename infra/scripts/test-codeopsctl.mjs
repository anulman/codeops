import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSmokeReport,
  buildCompensatingRollbackPlan,
  parseArguments,
  formatError,
  validateLock,
  validatePolicy,
} from "./codeopsctl.mjs";

function lock() {
  return {
    schemaVersion: "codeops.consumer-lock/v1",
    release: {
      repository: "anulman/codeops",
      tag: "v1.2.3",
      sourceSha: "a".repeat(40),
      manifestAsset: "release-manifest.json",
      manifestSha256: "b".repeat(64),
    },
    chart: {
      repository: "oci://ghcr.io/anulman/codeops/charts/codeops",
      version: "1.2.3",
      digest: `sha256:${"c".repeat(64)}`,
      asset: "codeops-1.2.3.tgz",
      packageSha256: "d".repeat(64),
    },
  };
}

function policy() {
  return {
    schemaVersion: "codeops.consumer-policy/v1",
    helmTimeout: "20m",
    httpTimeoutMs: 15000,
    requiredSecrets: ["codeops-access", "codeops-postgres"],
    cluster: {
      kubernetesServiceCidrs: ["10.3.0.1/32"],
      readyNodeSelector: "example.com/codeops=true",
    },
    postDeployHttpChecks: [
      { url: "https://work.example.com", acceptedStatuses: [200] },
    ],
  };
}

test("parses the three stable operator commands", () => {
  assert.deepEqual(
    parseArguments([
      "verify",
      "--lock",
      "lock.json",
      "--values",
      "values.yaml",
    ]),
    {
      command: "verify",
      release: "codeops",
      namespace: "codeops",
      lock: "lock.json",
      values: "values.yaml",
    },
  );
  assert.equal(
    parseArguments([
      "deploy",
      "--lock",
      "lock.json",
      "--values",
      "values.yaml",
      "--policy",
      "policy.json",
      "--release",
      "agents-system",
    ]).namespace,
    "agents-system",
  );
  assert.equal(parseArguments(["smoke"]).command, "smoke");
});

test("validates the small lock and consumer-owned policy", () => {
  assert.equal(validateLock(lock()).schemaVersion, "codeops.consumer-lock/v1");
  assert.equal(validatePolicy(policy()).requiredSecrets.length, 2);
  const compatible = policy();
  delete compatible.helmTimeout;
  delete compatible.httpTimeoutMs;
  delete compatible.postDeployHttpChecks[0].acceptedStatuses;
  assert.equal(validatePolicy(compatible).helmTimeout, "20m");
  assert.equal(compatible.postDeployHttpChecks[0].acceptedStatuses[0], 200);
  assert.throws(
    () => validateLock({ ...lock(), images: {} }),
    /consumer lock|release|chart|schema|image|./,
  );
});

test("rejects unsafe policy drift", () => {
  assert.throws(
    () => validatePolicy({ ...policy(), requiredSecrets: ["same", "same"] }),
    /duplicates/,
  );
  assert.throws(
    () =>
      validatePolicy({
        ...policy(),
        postDeployHttpChecks: [{ url: "http://work.example.com" }],
      }),
    /HTTPS/,
  );
  assert.throws(() => validatePolicy({ ...policy(), helmTimeout: "0m" }), /helmTimeout/);
  assert.throws(
    () => validatePolicy({ ...policy(), postDeployHttpChecks: [{ url: "https://work.example.com", acceptedStatuses: [99] }] }),
    /statuses/,
  );
  assert.throws(() => validatePolicy({ ...policy(), extra: true }), /unsupported fields/);
});

test("plans a hook-free compensating rollback for upgrades and cleans fresh installs", () => {
  assert.deepEqual(
    buildCompensatingRollbackPlan({
      release: "agents-system",
      namespace: "agents-system",
      previousRelease: { revision: "7" },
      namespaceExisted: true,
      helmTimeout: "20m",
    }),
    [["helm", ["rollback", "agents-system", "7", "--namespace", "agents-system", "--no-hooks", "--wait", "--wait-for-jobs", "--timeout", "20m"]]],
  );
  assert.equal(
    buildCompensatingRollbackPlan({
      release: "codeops",
      namespace: "codeops",
      previousRelease: undefined,
      namespaceExisted: false,
      helmTimeout: "20m",
    }).length,
    2,
  );
});

test("reports both deployment and rollback failures", () => {
  assert.equal(
    formatError(new AggregateError([new Error("deploy failed"), new Error("rollback failed")], "transaction failed")),
    "transaction failed\ncaused by: deploy failed\ncaused by: rollback failed",
  );
});

test("builds credential-safe smoke evidence", () => {
  const labels = {
    "app.kubernetes.io/instance": "agents-system",
    "app.kubernetes.io/part-of": "codeops",
  };
  const resources = [
    {
      kind: "Deployment",
      metadata: { name: "agents-system-ui", generation: 2, labels },
      spec: { replicas: 1 },
      status: { observedGeneration: 2, readyReplicas: 1 },
    },
    {
      kind: "StatefulSet",
      metadata: { name: "agents-system-postgres", generation: 2, labels },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        readyReplicas: 1,
        currentRevision: "r2",
        updateRevision: "r2",
      },
    },
    {
      kind: "PersistentVolumeClaim",
      metadata: { name: "agents-system-data", labels },
      status: { phase: "Bound" },
    },
  ];
  const report = buildSmokeReport("agents-system", "agents-system", resources, {
    status: "deployed",
    revision: 4,
    chart: "codeops-1.2.3",
    app_version: "a".repeat(40),
  });
  assert.equal(report.schemaVersion, "codeops.smoke/v1");
  assert.equal(report.ok, true);
  assert.equal(report.summary.failed, 0);
  assert.equal(JSON.stringify(report).includes("Secret"), false);
});

test("operator source accepts Helm digest output from stderr", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./codeopsctl.mjs", import.meta.url), "utf8"),
  );
  assert.match(source, /executeCombined/);
  assert.match(source, /result\.stdout.*result\.stderr/);
  assert.match(source, /namespaceExisted: namespaceExists/);
});
