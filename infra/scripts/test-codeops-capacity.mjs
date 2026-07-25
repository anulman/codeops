import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateCodeOpsCapacity,
  parseCpuMillis,
  parseMemoryBytes,
} from "./codeops-capacity.mjs";

function snapshot(overrides = {}) {
  return {
    node: {
      metadata: {
        name: "codeops-node",
        labels: {
          "node.kubernetes.io/instance-type": "b3-8",
          "renoconcierge.ca/codeops": "true",
        },
      },
      status: {
        allocatable: { cpu: "3840m", memory: "14101824Ki" },
        conditions: [
          { type: "Ready", status: "True" },
          { type: "MemoryPressure", status: "False" },
          { type: "DiskPressure", status: "False" },
          { type: "PIDPressure", status: "False" },
        ],
      },
    },
    metrics: { usage: { cpu: "137m", memory: "2646Mi" } },
    ...overrides,
  };
}

test("parses Kubernetes CPU and memory quantities", () => {
  assert.equal(parseCpuMillis("4"), 4_000);
  assert.equal(parseCpuMillis("3840m"), 3_840);
  assert.equal(parseCpuMillis("1000000n"), 1);
  assert.equal(parseMemoryBytes("1Gi"), 2 ** 30);
  assert.equal(parseMemoryBytes("14101824Ki"), 14_440_267_776);
  assert.throws(() => parseMemoryBytes("8GB"));
});

test("accepts the resized Trial 0 node despite a stale cloud flavor label", () => {
  const result = evaluateCodeOpsCapacity(snapshot());
  assert.equal(result.ok, true);
  assert.equal(result.availableCpuMillis, 3_703);
  assert.equal(result.availableMemoryBytes, 11_665_735_680);
});

test("fails closed without the explicit CodeOps placement label", () => {
  const value = snapshot();
  delete value.node.metadata.labels["renoconcierge.ca/codeops"];
  const result = evaluateCodeOpsCapacity(value);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /missing renoconcierge.ca\/codeops=true/);
});

test("fails closed on readiness or pressure", () => {
  const value = snapshot();
  value.node.status.conditions.find((entry) => entry.type === "Ready").status = "Unknown";
  value.node.status.conditions.find((entry) => entry.type === "MemoryPressure").status = "Unknown";
  const result = evaluateCodeOpsCapacity(value);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /node is not Ready/);
  assert.match(result.reasons.join("\n"), /MemoryPressure is not False/);
});

test("fails closed when either resource margin is insufficient", () => {
  const result = evaluateCodeOpsCapacity(
    snapshot({ metrics: { usage: { cpu: "1500m", memory: "7Gi" } } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /available CPU/);
  assert.match(result.reasons.join("\n"), /available memory/);
});

test("fails closed on missing or malformed metrics", () => {
  const result = evaluateCodeOpsCapacity(snapshot({ metrics: { usage: { cpu: "unknown" } } }));
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /invalid Kubernetes CPU quantity/);
});

test("fails closed on invalid resource thresholds", () => {
  const result = evaluateCodeOpsCapacity(snapshot(), {
    requiredCpuMillis: Number.NaN,
    requiredMemoryBytes: 0,
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /required CPU must be a positive finite number/);
  assert.match(result.reasons.join("\n"), /required memory must be a positive finite number/);
});
