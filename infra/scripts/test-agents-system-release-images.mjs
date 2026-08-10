import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentsSystemReleaseImages } from "./agents-system-release-images.mjs";

const names = [
  "codeops-agents-ui",
  "codeops-session-control-gateway",
  "codeops-plane-controller",
  "postgres",
  "codeops-session-runtime-worker",
  "codeops-agent",
  "codeops-model-proxy",
];
const plan = {
  services: names.map((name) => ({
    name,
    image: `ghcr.io/anulman/renoconcierge/renoconcierge-${name}`,
    inputRef: `ghcr.io/anulman/renoconcierge/renoconcierge-${name}:input-${"a".repeat(24)}`,
  })),
};

test("resolves every Agents control plane operand to one immutable registry digest", async () => {
  const seen = [];
  const result = await resolveAgentsSystemReleaseImages(plan, async (ref) => {
    seen.push(ref);
    return { digest: `sha256:${"b".repeat(64)}` };
  });
  assert.equal(result.version, "agents-system-release-images/v1");
  assert.equal(seen.length, 7);
  assert.equal(Object.keys(result.images).length, 7);
  assert.ok(Object.values(result.images).every(({ immutableRef }) => immutableRef.endsWith(`@sha256:${"b".repeat(64)}`)));
});

test("fails closed on a missing, foreign, or mutable operand", async () => {
  await assert.rejects(
    resolveAgentsSystemReleaseImages({ services: plan.services.slice(1) }, async () => ({ digest: `sha256:${"b".repeat(64)}` })),
    /missing trusted/,
  );
  await assert.rejects(
    resolveAgentsSystemReleaseImages({ services: [{ ...plan.services[0], inputRef: "ghcr.io/other/image:latest" }, ...plan.services.slice(1)] }, async () => ({ digest: `sha256:${"b".repeat(64)}` })),
    /missing trusted/,
  );
  await assert.rejects(
    resolveAgentsSystemReleaseImages(plan, async () => ({ digest: "latest" })),
    /did not resolve/,
  );
});
