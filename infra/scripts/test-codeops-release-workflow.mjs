import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const expectedImages = [
  "agent", "agents-ui", "control-gateway", "model-proxy", "orchestrator",
  "plane-controller", "session-control-gateway", "session-gateway",
  "session-runtime-worker",
];

test("release stays manual and publishes one exact immutable bundle", async () => {
  const source = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.ok(workflow.on.push.paths.includes("infra/charts/codeops/**"));
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.deepEqual(workflow.jobs.images.strategy.matrix.image, expectedImages);
  const build = workflow.jobs.images.steps.find(({ name }) => name === "Build exact image");
  assert.equal(build.with.push, "${{ github.event_name == 'workflow_dispatch' && inputs.publish }}");
  assert.equal(build.with.tags, "ghcr.io/anulman/codeops/${{ matrix.image }}:sha-${{ github.sha }}");
  assert.equal(workflow.jobs.chart.if, "github.event_name == 'workflow_dispatch' && inputs.publish");
  const serialized = JSON.stringify(workflow);
  assert.match(serialized, /Reject artifact identity reuse/);
  assert.match(serialized, /refusing to overwrite existing image identity/);
  assert.match(serialized, /refusing to overwrite existing chart version/);
  assert.match(serialized, /oci:\/\/ghcr\.io\/anulman\/codeops\/charts/);
  assert.match(serialized, /codeops-release-images\.mjs/);
  assert.match(serialized, /codeops-release-chart\.mjs/);
  assert.match(serialized, /nub run prepare:chart/);
  assert.match(serialized, /helm package \.release\/chart/);
  assert.match(serialized, /release-manifest\.json/);
  assert.match(serialized, /values\.release\.yaml/);
  assert.doesNotMatch(serialized, /renoconcierge\/renoconcierge-codeops/);
});
