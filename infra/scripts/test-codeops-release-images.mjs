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
  assert.deepEqual(result.upstream.postgresql, plan.upstream.postgresql);
  assert.match(result.values.runtime.releaseDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.values(result.images).every(({ immutableRef }) => immutableRef.endsWith(`@sha256:${"b".repeat(64)}`)));
});

test("binds the release digest to the complete immutable manifest including PostgreSQL", async () => {
  const inspect = async () => ({ digest: `sha256:${"b".repeat(64)}` });
  const original = await resolveCodeOpsReleaseImages(plan, inspect);
  const changedPostgresql = await resolveCodeOpsReleaseImages({
    ...plan,
    upstream: {
      postgresql: { ...plan.upstream.postgresql, digest: `sha256:${"d".repeat(64)}` },
    },
  }, inspect);
  assert.notEqual(
    original.values.runtime.releaseDigest,
    changedPostgresql.values.runtime.releaseDigest,
  );
  assert.deepEqual(original.images, changedPostgresql.images);
});

test("changes the release identity whenever the selected runtime worker image changes", async () => {
  const original = await resolveCodeOpsReleaseImages(
    plan,
    async () => ({ digest: `sha256:${"b".repeat(64)}` }),
  );
  const changed = await resolveCodeOpsReleaseImages(
    plan,
    async (ref) => ({
      digest: ref.includes("/session-runtime-worker:")
        ? `sha256:${"d".repeat(64)}`
        : `sha256:${"b".repeat(64)}`,
    }),
  );
  assert.notEqual(original.values.runtime.releaseDigest, changed.values.runtime.releaseDigest);
  assert.equal(changed.values.runtime.workerImage.digest, `sha256:${"d".repeat(64)}`);
  assert.equal(changed.images["session-runtime-worker"].immutableRef,
    `ghcr.io/anulman/codeops/session-runtime-worker@sha256:${"d".repeat(64)}`);
});

test("fails closed on missing, duplicate, foreign, mutable, or unpinned operands", async () => {
  const inspect = async () => ({ digest: `sha256:${"b".repeat(64)}` });
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, services: plan.services.slice(1) }, inspect), /operand count/);
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, services: [...plan.services, plan.services[0]] }, inspect), /duplicate/);
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, services: [{ ...plan.services[0], repository: "ghcr.io/other/image" }, ...plan.services.slice(1)] }, inspect), /missing trusted/);
  await assert.rejects(resolveCodeOpsReleaseImages(plan, async () => ({ digest: "latest" })), /did not resolve/);
  await assert.rejects(resolveCodeOpsReleaseImages({ ...plan, upstream: { postgresql: { repository: "postgres", digest: "latest" } } }, inspect), /PostgreSQL digest/);
});
