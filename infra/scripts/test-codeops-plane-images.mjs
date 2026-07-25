import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { rewritePlaneImages } from "./codeops-plane-images.mjs";

const lock = JSON.parse(
  await readFile("infra/k8s/codeops/trial0/plane-images.lock.json", "utf8"),
);

function manifestsFor(images = Object.keys(lock)) {
  return images
    .map(
      (image, index) => `apiVersion: v1
kind: Pod
metadata:
  name: image-${index}
spec:
  containers:
    - name: main
      image: ${image}
`,
    )
    .join("---\n");
}

test("rewrites every pinned Plane image to an immutable digest", () => {
  const result = rewritePlaneImages(manifestsFor(), lock);
  assert.equal(result.replacements, Object.keys(lock).length);
  assert.deepEqual(result.images, Object.keys(lock).sort());
  assert.equal(result.manifests.includes(":latest"), false);
  assert.equal(result.manifests.includes(":v1.3.1"), false);
  assert.match(result.manifests, /@sha256:[0-9a-f]{64}/);
});

test("fails closed when the rendered chart adds an image", () => {
  assert.throws(
    () => rewritePlaneImages(manifestsFor(["example.invalid/new:latest"]), lock),
    /unlocked Plane image/,
  );
});

test("fails closed when the lock contains an unused image", () => {
  assert.throws(
    () => rewritePlaneImages(manifestsFor(Object.keys(lock).slice(1)), lock),
    /unused Plane image lock entries/,
  );
});

test("rejects a tag or malformed digest in the lock", () => {
  const source = Object.keys(lock)[0];
  assert.throws(
    () => rewritePlaneImages(manifestsFor([source]), { [source]: source }),
    /invalid digest reference/,
  );
});

test("rejects a valid digest for a different repository", () => {
  const source = Object.keys(lock)[0];
  assert.throws(
    () =>
      rewritePlaneImages(manifestsFor([source]), {
        [source]: `docker.io/library/busybox@sha256:${"a".repeat(64)}`,
      }),
    /repository mismatch/,
  );
});

test("rejects empty rendered input", () => {
  assert.throws(() => rewritePlaneImages("", lock), /contain no images/);
});
