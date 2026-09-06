import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSmokeReport,
  buildCompensatingRollbackPlan,
  buildHelmUpgradeArguments,
  parseArguments,
  referencedPersistentVolumeClaimNames,
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
    requiredSecrets: ["codeops-postgres", "codeops-session-secrets"],
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

test("validates structured prerelease locks", () => {
  const prerelease = lock();
  prerelease.release.tag = "v1.2.3-alpha.0";
  prerelease.chart.version = "1.2.3-alpha.0";
  prerelease.chart.asset = "codeops-1.2.3-alpha.0.tgz";
  assert.equal(validateLock(prerelease).release.tag, "v1.2.3-alpha.0");

  prerelease.release.tag = "v1.2.3-alpha.01";
  assert.throws(() => validateLock(prerelease), /release version/);
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

test("preserves installed provider and auth-PVC values only during upgrades", () => {
  const input = {
    release: "agents-system",
    chartPath: "/tmp/codeops.tgz",
    namespace: "agents-system",
    valuesPath: "values.yaml",
    helmTimeout: "20m",
  };
  assert.ok(buildHelmUpgradeArguments({
    ...input,
    preserveInstalledValues: true,
  }).includes("--reset-then-reuse-values"));
  assert.equal(buildHelmUpgradeArguments({
    ...input,
    preserveInstalledValues: false,
  }).includes("--reset-then-reuse-values"), false);
});

test("includes an external ChatGPT auth PVC in upgrade and rollback preservation", () => {
  assert.deepEqual(referencedPersistentVolumeClaimNames([{
    kind: "Deployment",
    spec: { template: { spec: { volumes: [
      { name: "chatgpt-auth", persistentVolumeClaim: {
        claimName: "agents-system-codex-auth",
      } },
      { name: "config", configMap: { name: "config" } },
    ] } } },
  }]), ["agents-system-codex-auth"]);
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

// COAUTO-49: these fixtures never invoke Helm, kubectl, or a network endpoint.
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  upgradeBinding, upgradeSummary, validateUpgradeProof, startupDiagnostics,
  reconcileUpgradeIdentity, deliverUpgradeEvent, runUpgrade,
} from "./codeopsctl.mjs";

function upgradeProof() {
  return { version: "codeops.golden-release-report/v2", passed: true,
    sourceSha: lock().release.sourceSha,
    sourceProof: { evidence: { kind: "simulated-provider", providerMode: "fake" } },
    artifactProof: { evidence: { kind: "released-image", sourceCheckout: false, immutableImageRefs: true },
      chartVersion: lock().chart.version, chartDigest: lock().chart.digest,
      smokeStatus: "passed", rollbackStatus: "passed", cleanupStatus: "passed",
      images: [{ name: "agent", immutableRef: `example.invalid/agent@sha256:${"e".repeat(64)}` }] } };
}

async function upgradeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "codeops-upgrade-test-"));
  for (const [name, bytes] of [["lock", JSON.stringify(lock())], ["values", "{}"], ["policy", JSON.stringify(policy())]]) {
    await writeFile(path.join(root, name), bytes);
  }
  const options = { command: "upgrade", release: "codeops", namespace: "codeops",
    lock: path.join(root, "lock"), values: path.join(root, "values"), policy: path.join(root, "policy"),
    operation_dir: path.join(root, "operation"), notification_url: "https://notify.example.com/events" };
  const calls = { deploy: 0, preflight: 0, delivery: [] };
  const adapters = {
    target: () => ({ clusterUid: "cluster", namespaceUid: "namespace", release: "codeops", namespace: "codeops" }),
    verify: async () => ({ prepared: { manifest: { images: { agent: { immutableRef: upgradeProof().artifactProof.images[0].immutableRef } } },
      expectedImages: [upgradeProof().artifactProof.images[0].immutableRef] } }),
    downloadProof: async (_lock, _asset, file) => writeFile(file, JSON.stringify(upgradeProof())),
    preflight: async () => { calls.preflight += 1; },
    deploy: async (input) => {
      calls.deploy += 1;
      await input.beforeUpgrade({ previousRelease: { revision: "7" }, pvcsBefore: [], secretsBefore: [] });
      const receipt = JSON.parse(await readFile(path.join(options.operation_dir, "state.json")));
      assert.equal(receipt.status, "unknown", "intent is durable before the effect");
    },
    reconcile: async () => "unknown",
    diagnostics: () => false,
    deliver: async (_url, event) => { calls.delivery.push(event); return true; },
  };
  t.after(async () => {
    try {
      const state = JSON.parse(await readFile(path.join(options.operation_dir, "state.json")));
      await rm(state.logDirectory, { recursive: true, force: true });
    } catch { /* A plan creates no operation. */ }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  return { root, options, calls, adapters };
}

test("upgrade plan is local, nonmutating and has no effect calls", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  const result = await runUpgrade({ ...options, plan: true }, adapters);
  assert.equal(result.status, "planned");
  assert.equal(calls.deploy, 0);
  await assert.rejects(stat(options.operation_dir), { code: "ENOENT" });
  assert.equal(parseArguments(["upgrade", "--lock", "l", "--values", "v", "--policy", "p", "--dry-run"]).plan, true);
  assert.equal(parseArguments(["upgrade", "--operation-dir", "d", "--status"]).status, true);
  assert.throws(() => parseArguments(["upgrade", "--lock", "l", "--values", "v", "--policy", "p"]), /operation-dir/);
});

test("successful upgrade rechecks preflight, acknowledges once and cleans transient logs", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  const result = await runUpgrade(options, adapters);
  assert.equal(result.status, "complete");
  assert.equal(result.notification, "acknowledged");
  assert.equal(calls.preflight, 2);
  assert.equal(calls.deploy, 1);
  const state = JSON.parse(await readFile(path.join(options.operation_dir, "state.json")));
  assert.equal((await stat(path.join(options.operation_dir, "state.json"))).mode & 0o777, 0o600);
  await assert.rejects(stat(state.logDirectory), { code: "ENOENT" });
  await runUpgrade({ ...options, resume: true }, adapters);
  assert.equal(calls.deploy, 1);
  assert.equal(calls.delivery.length, 1);
});

test("preflight rejection blocks effects and retains diagnostics", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  adapters.preflight = async () => { throw new Error("synthetic missing prerequisite"); };
  const result = await runUpgrade(options, adapters);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 3);
  assert.equal(calls.deploy, 0);
  assert.equal((await stat(result.diagnosticPath)).mode & 0o777, 0o700);
});

test("lost acknowledgement retries the same terminal event without redeployment", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  adapters.deliver = async (_url, event) => { calls.delivery.push(event); return false; };
  const pending = await runUpgrade(options, adapters);
  assert.equal(pending.exitCode, 5);
  await stat(pending.diagnosticPath);
  adapters.target = () => { throw new Error("cluster unavailable during delivery retry"); };
  adapters.deliver = async (_url, event) => { calls.delivery.push(event); return true; };
  const done = await runUpgrade({ ...options, resume: true }, adapters);
  assert.equal(done.notification, "acknowledged");
  assert.equal(calls.deploy, 1);
  assert.equal(new Set(calls.delivery.map((event) => event.eventId)).size, 1);
});

test("interrupted effect stays unknown until reconciled and never repeats Helm", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  const apply = adapters.deploy;
  adapters.deploy = async (input) => { await apply(input); throw new Error("interruption"); };
  assert.equal((await runUpgrade(options, adapters)).exitCode, 4);
  assert.equal((await runUpgrade({ ...options, resume: true }, adapters)).exitCode, 4);
  assert.equal(calls.delivery.length, 0);
  adapters.reconcile = async () => "complete";
  assert.equal((await runUpgrade({ ...options, resume: true }, adapters)).status, "complete");
  assert.equal(calls.deploy, 1);
});

test("resume rejects config drift before effects and never manufactures missing state", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  await assert.rejects(runUpgrade({ ...options, resume: true }, adapters), /missing operation/);
  await runUpgrade({ ...options, stage: "verify" }, adapters);
  await writeFile(options.values, "changed");
  await assert.rejects(runUpgrade({ ...options, resume: true }, adapters), /drift/);
  assert.equal(calls.deploy, 0);
});

test("reconciliation requires the exact next Helm revision and operation description", () => {
  const state = { operationId: "binding", before: { previousRelease: { revision: "7" } } };
  const effect = { revision: 8, status: "deployed", description: "codeops-upgrade:binding" };
  assert.equal(reconcileUpgradeIdentity(state, []), "unknown");
  assert.equal(reconcileUpgradeIdentity(state, [effect]), "validate");
  assert.equal(reconcileUpgradeIdentity(state, [{ ...effect, description: "another operation" }]), "unknown");
  assert.equal(reconcileUpgradeIdentity(state, [{ ...effect, status: "pending-upgrade" }]), "unknown");
  assert.equal(reconcileUpgradeIdentity(state, [{ ...effect, status: "failed" }]), "failed");
});

test("proof binds all tested digests and startup diagnostics exclude arbitrary strings", () => {
  const report = upgradeProof();
  const manifest = { images: { agent: { immutableRef: report.artifactProof.images[0].immutableRef } } };
  validateUpgradeProof(report, lock(), manifest);
  report.artifactProof.images[0].immutableRef = "different";
  assert.throws(() => validateUpgradeProof(report, lock(), manifest), /digests/);
  const diagnostics = startupDiagnostics({ items: [{ metadata: { name: "synthetic-secret" }, status: {
    containerStatuses: [{ state: { waiting: { reason: "CreateContainerConfigError", message: "synthetic-secret" } } }],
  } }] });
  assert.equal(diagnostics[0].containers[0].fatal, true);
  assert.equal(JSON.stringify(diagnostics).includes("synthetic-secret"), false);
});

test("notification requires matching acknowledgement, not just HTTP success", async () => {
  const event = { eventId: "operation:complete" };
  assert.equal(await deliverUpgradeEvent("https://example.com", event, async () => new Response('{"eventId":"other"}')), false);
  assert.equal(await deliverUpgradeEvent("https://example.com", event, async (_url, request) => {
    assert.equal(request.headers["idempotency-key"], event.eventId);
    assert.equal(request.redirect, "manual");
    return new Response(JSON.stringify(event));
  }), true);
});

test("binding changes with cluster, configuration or notification destination", () => {
  const input = { lockBytes: "lock", valuesBytes: "values", policyBytes: "policy", target: "cluster", notificationUrl: "https://one.example.com" };
  assert.notEqual(upgradeBinding(input), upgradeBinding({ ...input, target: "other" }));
  assert.notEqual(upgradeBinding(input), upgradeBinding({ ...input, valuesBytes: "other" }));
  assert.notEqual(upgradeBinding(input), upgradeBinding({ ...input, notificationUrl: "https://two.example.com" }));
  assert.equal(upgradeSummary({ status: "unknown" }).exitCode, 4);
});

import { buildHelmRenderArguments } from "./codeopsctl.mjs";

test("upgrade renders upgrade hooks with read-only lookup and resets to explicit values", () => {
  const options = { release: "codeops", namespace: "codeops", values: "values.yaml", operationId: "binding" };
  const rendered = buildHelmRenderArguments(options, "chart.tgz");
  assert.ok(rendered.includes("--is-upgrade"));
  assert.ok(rendered.includes("--dry-run=server"));
  const upgrade = buildHelmUpgradeArguments({ ...options, valuesPath: options.values, chartPath: "chart.tgz", helmTimeout: "20m", preserveInstalledValues: true });
  assert.ok(upgrade.includes("--reset-values"));
  assert.ok(upgrade.includes("codeops-upgrade:binding"));
  assert.equal(upgrade.includes("--reset-then-reuse-values"), false);
  assert.equal(buildHelmRenderArguments({ ...options, operationId: undefined }, "chart.tgz").includes("--dry-run=server"), false);
});

test("an active operation lock blocks a second writer", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  await runUpgrade({ ...options, stage: "verify" }, adapters);
  await writeFile(path.join(options.operation_dir, "active"), "123\n", { mode: 0o600 });
  await assert.rejects(runUpgrade({ ...options, resume: true }, adapters), { code: "EEXIST" });
  assert.equal(calls.deploy, 0);
});

// Exercise the real deploy, executeUpgrade and reconciliation paths. Only the
// external executables are synthetic; PATH contains no real infrastructure tools.
for (const failure of ["helm-failure", "validation-failure"]) {
  test(`forward-only upgrade retains ${failure} without rollback or repeat effects`, async (t) => {
    const { root, options, adapters } = await upgradeFixture(t);
    const { mkdir } = await import("node:fs/promises");
    const bin = path.join(root, "bin");
    const tracePath = path.join(root, "commands.jsonl");
    await mkdir(bin);
    const executable = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = ${JSON.stringify(root)};
const failure = ${JSON.stringify(failure)};
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\\n");
const effectPath = path.join(root, "effect.json");
const effect = existsSync(effectPath) ? JSON.parse(readFileSync(effectPath)) : undefined;
const emit = (value) => process.stdout.write(JSON.stringify(value));
if (tool === "helm" && args[0] === "upgrade") {
  const receipt = JSON.parse(readFileSync(path.join(root, "operation", "state.json")));
  if (receipt.status !== "unknown" || !receipt.before) throw new Error("missing durable intent");
  writeFileSync(effectPath, JSON.stringify({ description: args[args.indexOf("--description") + 1] }));
  process.exit(failure === "helm-failure" ? 1 : 0);
} else if (tool === "helm" && args[0] === "list") {
  emit([{ name: "codeops", status: effect && failure === "helm-failure" ? "failed" : "deployed",
    revision: effect ? 8 : 7, chart: "codeops-1.2.3", app_version: "b".repeat(40) }]);
} else if (tool === "helm" && args[0] === "history") {
  emit([{ revision: 8, description: effect.description,
    status: failure === "helm-failure" ? "failed" : "deployed" }]);
} else if (tool === "kubectl" && args[0] === "get") {
  if (args[1] === "namespace") process.stdout.write("namespace/codeops");
  else if (args[1] === "service") process.stdout.write("10.3.0.1");
  else if (args[1] === "nodes") emit({ items: [{ status: { conditions: [{ type: "Ready", status: "True" }] } }] });
  else if (args[1] === "secret") emit({ metadata: { uid: "synthetic-secret-uid" }, data: {} });
  else if (["pods", "deployments,statefulsets,persistentvolumeclaims,configmaps"].includes(args[1])) emit({ items: [] });
  else throw new Error("unexpected read");
} else throw new Error("unexpected effect");
`;
    // Extensionless executables use ESM explicitly, independent of the host's
    // package scope and without shell lookup of node.
    await writeFile(path.join(bin, "package.json"), '{"type":"module"}');
    for (const tool of ["helm", "kubectl"]) await writeFile(path.join(bin, tool), executable, { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    });
    delete adapters.deploy;
    delete adapters.reconcile;
    delete adapters.diagnostics;
    const verify = adapters.verify;
    adapters.verify = async () => {
      const verification = await verify();
      verification.prepared.chartPath = path.join(root, "synthetic-chart.tgz");
      return verification;
    };
    const result = await runUpgrade(options, adapters);
    assert.equal(result.status, failure === "helm-failure" ? "failed" : "unknown");
    assert.equal(result.exitCode, failure === "helm-failure" ? 3 : 4);
    const diagnostics = await readFile(path.join(result.diagnosticPath, "diagnostics.jsonl"), "utf8");
    assert.match(diagnostics, /"tool":"helm"/);
    assert.match(diagnostics, /"startup":/);
    const resumed = await runUpgrade({ ...options, resume: true }, adapters);
    assert.equal(resumed.status, result.status);
    const commands = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const upgrades = commands.filter(({ tool, args }) => tool === "helm" && args[0] === "upgrade");
    assert.equal(upgrades.length, 1, "resume must not repeat the recorded effect");
    assert.equal(upgrades[0].args.includes("--atomic"), false);
    assert.equal(upgrades[0].args.includes("--cleanup-on-fail"), false);
    assert.ok(commands.some(({ tool, args }) => tool === "helm" && args[0] === "history"));
    // No rollback/uninstall, Kubernetes mutation/exec, SQL or owner-role regrant.
    assert.ok(commands.every(({ tool, args }) =>
      (tool === "helm" && ["upgrade", "list", "history"].includes(args[0])) ||
      (tool === "kubectl" && args[0] === "get")));
  });
}

test("legacy deploy keeps atomic rollback while upgrade is forward-only", () => {
  const input = { release: "codeops", namespace: "codeops", chartPath: "chart.tgz",
    valuesPath: "values.yaml", helmTimeout: "20m", preserveInstalledValues: true };
  assert.ok(buildHelmUpgradeArguments(input).includes("--atomic"));
  assert.equal(buildHelmUpgradeArguments({ ...input, operationId: "binding" }).includes("--atomic"), false);
});

for (const phase of ["pending acknowledgement", "interrupted effect"]) {
  test(`durable recovery after legacy temporary log loss: ${phase}`, async (t) => {
    const { options, adapters, calls } = await upgradeFixture(t);
    adapters.deliver = async (_url, event) => { calls.delivery.push(event); return false; };
    if (phase === "interrupted effect") {
      const apply = adapters.deploy;
      adapters.deploy = async (input) => { await apply(input); throw new Error("interrupted"); };
    }
    await runUpgrade(options, adapters);
    const file = path.join(options.operation_dir, "state.json");
    const before = JSON.parse(await readFile(file));
    assert.equal(path.dirname(before.logDirectory), options.operation_dir);
    assert.equal((await stat(before.logDirectory)).mode & 0o777, 0o700);
    const legacy = await mkdtemp(path.join(tmpdir(), "legacy-upgrade-"));
    await rm(legacy, { recursive: true });
    await rm(before.logDirectory, { recursive: true });
    await writeFile(file, JSON.stringify({ ...before, logDirectory: legacy }));
    adapters.reconcile = async () => "complete";
    if (before.event) adapters.target = () => { throw new Error("no cluster access for ack recovery"); };
    const pending = await runUpgrade({ ...options, resume: true }, adapters);
    assert.equal(pending.notification, "pending");
    const recovered = JSON.parse(await readFile(file));
    assert.deepEqual(recovered.before, before.before);
    assert.equal(recovered.operationId, before.operationId);
    assert.equal(recovered.event.eventId, before.event?.eventId ?? `${before.operationId}:complete`);
    assert.equal(recovered.diagnosticHistoryMissing, true);
    assert.equal(path.dirname(recovered.logDirectory), options.operation_dir);
    assert.match(await readFile(path.join(recovered.logDirectory, "diagnostics.jsonl"), "utf8"), /historical diagnostics unavailable/);
    assert.equal((await stat(path.join(recovered.logDirectory, "diagnostics.jsonl"))).mode & 0o777, 0o600);
    adapters.deliver = async (_url, event) => { calls.delivery.push(event); return true; };
    await runUpgrade({ ...options, resume: true }, adapters);
    assert.equal(calls.deploy, 1);
    assert.equal(new Set(calls.delivery.map((event) => event.eventId)).size, 1);
    await assert.rejects(stat(recovered.logDirectory), { code: "ENOENT" });
  });
}

test("durable recovery preserves existing legacy diagnostics", async (t) => {
  const { options, adapters, calls } = await upgradeFixture(t);
  adapters.deliver = async () => false;
  await runUpgrade(options, adapters);
  const file = path.join(options.operation_dir, "state.json");
  const before = JSON.parse(await readFile(file));
  const legacy = await mkdtemp(path.join(tmpdir(), "legacy-upgrade-"));
  t.after(() => rm(legacy, { recursive: true, force: true }));
  await writeFile(path.join(legacy, "diagnostics.jsonl"), '{"retained":true}\n', { mode: 0o600 });
  await writeFile(file, JSON.stringify({ ...before, logDirectory: legacy }));
  await runUpgrade({ ...options, resume: true }, adapters);
  const after = JSON.parse(await readFile(file));
  assert.equal(path.dirname(after.logDirectory), options.operation_dir);
  assert.match(await readFile(path.join(after.logDirectory, "diagnostics.jsonl"), "utf8"), /"retained":true/);
  assert.equal(await readFile(path.join(legacy, "diagnostics.jsonl"), "utf8"), '{"retained":true}\n');
  assert.deepEqual(after.event, before.event);
  assert.equal(calls.deploy, 1);
});
