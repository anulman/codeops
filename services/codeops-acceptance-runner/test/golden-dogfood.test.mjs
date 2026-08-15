import assert from "node:assert/strict";
import test from "node:test";
import {
  goldenScenarios,
  runGoldenDogfood,
  runNodeProbe,
} from "../src/golden-dogfood.mjs";

const repositoryRoot = new URL("../../..", import.meta.url).pathname;

const requiredScenarioIds = [
  "launch-exact-source",
  "work-item-read-search",
  "github-bounded-reads",
  "checkpoint-resume",
  "plane-steering",
  "approved-mutation",
  "permission-denial",
  "stale-write-recovery",
  "validation-recovery",
  "cleanup-isolation",
  "lifecycle-relay",
];

test("defines every limited-release golden scenario with all fake adapter classes", () => {
  assert.deepEqual(goldenScenarios.map(({ id }) => id), requiredScenarioIds);
  assert.deepEqual(
    [...new Set(goldenScenarios.flatMap(({ adapters }) => adapters))].sort(),
    ["github", "jetstream", "model", "plane"],
  );
  assert.equal(goldenScenarios.every(({ probes }) => probes.length > 0), true);
});

test("reports only bounded operational measurements", async () => {
  let clock = 0;
  const calls = [];
  const report = await runGoldenDogfood({
    scenarios: goldenScenarios,
    repositoryRoot: "/exact/repository",
    monotonicNow: () => {
      clock += 2;
      return clock;
    },
    runProbe: async (input) => {
      calls.push(input);
      return true;
    },
  });
  assert.deepEqual(report, {
    version: "codeops.golden-dogfood-report/v2",
    evidence: {
      kind: "simulated-provider",
      providerMode: "fake",
    },
    telemetry: "operational-only",
    passed: true,
    scenarioCount: requiredScenarioIds.length,
    scenarios: requiredScenarioIds.map((id) => ({
      id,
      status: "passed",
      durationMs: 2,
    })),
  });
  assert.equal(calls.every(({ repositoryRoot }) => repositoryRoot === "/exact/repository"), true);
  const serialized = JSON.stringify(report);
  for (const forbidden of ["prompt", "body", "diff", "log", "attachment", "token"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes("notification-delivery"), false);
  assert.equal(serialized.includes("providerDelivery"), false);
});

test("fails the report without retaining probe output", async () => {
  let first = true;
  const report = await runGoldenDogfood({
    scenarios: goldenScenarios,
    runProbe: async () => {
      if (first) {
        first = false;
        return false;
      }
      return true;
    },
    monotonicNow: () => 1,
  });
  assert.deepEqual(report.scenarios[0],
    { id: "launch-exact-source", status: "failed", durationMs: 0 },
  );
  assert.equal(report.passed, false);
  assert.equal("output" in report.scenarios[0], false);
});

test("requires one exact selected probe instead of trusting a zero-match exit", async () => {
  assert.equal(await runNodeProbe({
    repositoryRoot,
    file: "services/codeops-acceptance-runner/test/fixtures/golden-probe.mjs",
    testName: "one exact deterministic probe",
  }), true);
  assert.equal(await runNodeProbe({
    repositoryRoot,
    file: "services/codeops-acceptance-runner/test/fixtures/golden-probe.mjs",
    testName: "missing probe",
  }), false);
  assert.equal(await runNodeProbe({
    repositoryRoot,
    file: "../outside.test.mjs",
    testName: "unsafe path",
  }), false);
});
