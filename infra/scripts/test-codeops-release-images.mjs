import assert from "node:assert/strict";
import test from "node:test";
import { resolveCodeOpsReleaseImages } from "./codeops-release-images.mjs";

const names = [
  "acceptance-runner", "agent", "agents-ui", "control-gateway", "model-proxy", "orchestrator",
  "plane-controller", "session-control-gateway", "session-gateway",
  "session-runtime-worker",
];
const sourceSha = "a".repeat(40);
const plan = {
  version: "codeops.image-publication-plan/v1",
  sourceSha,
  upstream: { postgresql: { repository: "postgres", digest: `sha256:${"c".repeat(64)}` } },
  services: names.map((name) => ({
    name,
    repository: `ghcr.io/anulman/codeops/${name}`,
    sourceRef: `ghcr.io/anulman/codeops/${name}:sha-${sourceSha}`,
  })),
};

test("resolves all ten CodeOps operands and release values to immutable digests", async () => {
  const seen = [];
  const result = await resolveCodeOpsReleaseImages(plan, async (ref) => {
    seen.push(ref);
    return { digest: `sha256:${"b".repeat(64)}` };
  });
  assert.equal(result.version, "codeops.release-images/v1");
  assert.equal(result.sourceSha, sourceSha);
  assert.equal(seen.length, 10);
  assert.deepEqual(Object.keys(result.images), names);
  assert.equal(result.values.githubController.controlPlaneSha, sourceSha);
  assert.equal(result.values.acceptanceRunner, undefined);
  assert.deepEqual(result.values.lifecycleRelay.image, result.values.controlGateway.image);
  assert.equal(result.values.postgresql.image.digest, `sha256:${"c".repeat(64)}`);
  assert.ok(Object.values(result.images).every(({ immutableRef }) => immutableRef.endsWith(`@sha256:${"b".repeat(64)}`)));
});

test("fails closed on missing, duplicate, foreign, mutable, or unpinned operands", async () => {
  const inspect = async () => ({ digest: `sha256:${"b".repeat(64)}` });
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, services: plan.services.slice(1) }, inspect), /operand count/);
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, services: [...plan.services, plan.services[0]] }, inspect), /duplicate/);
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, services: [{ ...plan.services[0], repository: "ghcr.io/other/image" }, ...plan.services.slice(1)] }, inspect), /missing trusted/);
  await assert.rejects(resolveCodeOpsReleaseImages(plan, async () => ({ digest: "latest" })), /did not resolve/);
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, upstream: { postgresql: { repository: "postgres", digest: "latest" } } }, inspect), /PostgreSQL digest/);
});
