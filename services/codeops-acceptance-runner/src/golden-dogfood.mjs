import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const acceptanceRunnerDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultRepositoryRoot = path.resolve(acceptanceRunnerDirectory, "../..");

function probe(file, testName) {
  return Object.freeze({ file, testName });
}

export const goldenScenarios = Object.freeze([
  Object.freeze({
    id: "launch-exact-source",
    adapters: ["plane"],
    probes: [probe(
      "services/codeops-control-gateway/test/workspace-launch.test.mjs",
      "admits one exact catalog-bound workspace launch",
    )],
  }),
  Object.freeze({
    id: "work-item-read-search",
    adapters: ["plane"],
    probes: [probe(
      "services/codeops-plane-controller/test/work-item-provider.test.mjs",
      "gets and searches bounded same-project work-item projections",
    )],
  }),
  Object.freeze({
    id: "github-bounded-reads",
    adapters: ["github"],
    probes: [
      probe(
        "services/codeops-control-gateway/test/github-reads-adapter.test.mjs",
        "returns only the byte-bounded diff for a stable exact head",
      ),
      probe(
        "services/codeops-control-gateway/test/github-reads-adapter.test.mjs",
        "maps the remaining bounded GitHub read operations without exposing raw responses",
      ),
      probe(
        "services/codeops-control-gateway/test/github-reads-adapter.test.mjs",
        "fails closed when a pull-request head changes during the diff read",
      ),
      probe(
        "services/codeops-control-gateway/test/github-reads-adapter.test.mjs",
        "does not forward the repository credential to a check-log redirect",
      ),
    ],
  }),
  Object.freeze({
    id: "checkpoint-resume",
    adapters: ["model"],
    probes: [probe(
      "services/codeops-session-runtime-worker/test/acp-workspace.test.mjs",
      "executes prompt, checkpoint, hibernate, resume, and fork through ACP identity",
    )],
  }),
  Object.freeze({
    id: "plane-steering",
    adapters: ["plane", "model"],
    probes: [
      probe(
        "services/codeops-control-gateway/test/plane-session-steering.test.mjs",
        "routes one authenticated Plane comment to the exact active bound session",
      ),
      probe(
        "services/codeops-plane-controller/test/comment-classifier.test.mjs",
        "classifies one bounded comment through the small model proxy",
      ),
    ],
  }),
  Object.freeze({
    id: "approved-mutation",
    adapters: ["plane"],
    probes: [
      probe(
        "services/codeops-session-runtime-worker/test/acp-workspace.test.mjs",
        "maps ACP options through opaque broker identities without exposing claim authority",
      ),
      probe(
        "services/codeops-control-gateway/test/session-runtime-work-items.test.mjs",
        "binds one work-item permission to its exact target and mutation",
      ),
      probe(
        "services/codeops-session-runtime-worker/test/work-items-broker.test.mjs",
        "reads without permission and gates every mutation on one durable decision",
      ),
    ],
  }),
  Object.freeze({
    id: "permission-denial",
    adapters: ["plane"],
    probes: [
      probe(
        "services/codeops-control-gateway/test/session-runtime-permissions.test.mjs",
        "polls pending, denied, and opaque selected ACP decisions",
      ),
      probe(
        "services/codeops-session-runtime-worker/test/work-items-broker.test.mjs",
        "direct creation stops when durable permission is denied",
      ),
    ],
  }),
  Object.freeze({
    id: "stale-write-recovery",
    adapters: ["plane"],
    probes: [probe(
      "services/codeops-plane-controller/test/work-item-provider.test.mjs",
      "updates only from the exact observed revision",
    )],
  }),
  Object.freeze({
    id: "validation-recovery",
    adapters: ["model"],
    probes: [
      probe(
        "services/codeops-plane-controller/test/comment-classifier.test.mjs",
        "fails closed on proxy, completion, and schema drift",
      ),
      probe(
        "services/codeops-session-runtime-worker/test/repair.test.mjs",
        "replays the exact completed repair but rejects a conflicting result",
      ),
    ],
  }),
  Object.freeze({
    id: "cleanup-isolation",
    adapters: ["plane", "github"],
    probes: [probe(
      "services/codeops-control-gateway/test/workspace-launch-controller.test.mjs",
      "terminates incompatible resources after credential cleanup",
    )],
  }),
  Object.freeze({
    id: "notification-delivery",
    adapters: ["notification"],
    probes: [
      probe(
        "services/codeops-control-gateway/test/work-item-lifecycle-relay.test.mjs",
        "publishes canonical event bytes with the immutable event ID and fences the database acknowledgment",
      ),
      probe(
        "services/codeops-control-gateway/test/work-item-lifecycle-relay.test.mjs",
        "accepts JetStream deduplication after crash recovery and records the original stream sequence",
      ),
    ],
  }),
]);

function exactNamePattern(testName) {
  return `^${testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export function runNodeProbe(input) {
  return new Promise((resolve) => {
    if (
      !/^(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.mjs$/.test(input.file) ||
      input.file.split("/").includes("..") ||
      typeof input.testName !== "string" ||
      input.testName.length < 1 ||
      input.testName.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(input.testName)
    ) {
      resolve(false);
      return;
    }
    let report = "";
    let reportBytes = 0;
    let settled = false;
    const childEnvironment = {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        `--test-name-pattern=${exactNamePattern(input.testName)}`,
        input.file,
      ],
      {
        cwd: input.repositoryRoot,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      reportBytes += Buffer.byteLength(chunk);
      if (reportBytes > 64 * 1_024) {
        child.kill("SIGKILL");
        return;
      }
      report += chunk;
    });
    child.once("error", () => finish(false));
    child.once("close", (code, signal) => {
      const lines = report.split(/\r?\n/);
      finish(
        code === 0 &&
        signal === null &&
        reportBytes <= 64 * 1_024 &&
        lines.includes(`# Subtest: ${input.testName}`) &&
        /^# tests 1$/m.test(report) &&
        /^# pass 1$/m.test(report) &&
        /^# fail 0$/m.test(report) &&
        /^# cancelled 0$/m.test(report) &&
        /^# skipped 0$/m.test(report),
      );
    });
  });
}

function assertManifest(scenarios) {
  const ids = new Set();
  const adapters = new Set();
  for (const scenario of scenarios) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(scenario.id) || ids.has(scenario.id)) {
      throw new Error("golden scenario identity is invalid or duplicated");
    }
    ids.add(scenario.id);
    if (!Array.isArray(scenario.probes) || scenario.probes.length < 1) {
      throw new Error(`golden scenario ${scenario.id} has no executable probe`);
    }
    for (const adapter of scenario.adapters) adapters.add(adapter);
  }
  for (const required of ["plane", "github", "model", "notification"]) {
    if (!adapters.has(required)) {
      throw new Error(`golden suite omits the fake ${required} adapter`);
    }
  }
}

export async function runGoldenDogfood(input = {}) {
  const scenarios = input.scenarios ?? goldenScenarios;
  const repositoryRoot = input.repositoryRoot ?? defaultRepositoryRoot;
  const runProbe = input.runProbe ?? runNodeProbe;
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  assertManifest(scenarios);

  const results = [];
  for (const scenario of scenarios) {
    const started = monotonicNow();
    let passed = true;
    for (const currentProbe of scenario.probes) {
      passed = await runProbe({ ...currentProbe, repositoryRoot });
      if (!passed) break;
    }
    results.push({
      id: scenario.id,
      status: passed ? "passed" : "failed",
      durationMs: Math.max(0, Math.round(monotonicNow() - started)),
    });
  }

  return Object.freeze({
    version: "codeops.golden-dogfood-report/v1",
    adapterMode: "fake",
    telemetry: "operational-only",
    passed: results.every(({ status }) => status === "passed"),
    scenarioCount: results.length,
    scenarios: results,
  });
}

async function main() {
  const report = await runGoldenDogfood();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
