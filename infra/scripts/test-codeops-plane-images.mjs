import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { rewritePlaneImages } from "./codeops-plane-images.mjs";

const lock = JSON.parse(
  await readFile("infra/k8s/codeops/trial0/plane-images.lock.json", "utf8"),
);

function manifestsFor(images = Object.keys(lock)) {
  const publicOrigin = `apiVersion: v1
kind: ConfigMap
metadata:
  name: plane-app-vars
  labels:
    app.kubernetes.io/name: plane-ce
data:
  WEB_URL: http://plane.example.com
  CORS_ALLOWED_ORIGINS: http://plane.example.com,https://plane.example.com
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: plane-ingress
  labels:
    app.kubernetes.io/name: plane-ce
spec:
  rules:
    - host: plane.example.com
  tls:
    - hosts:
        - plane.example.com
      secretName: plane-tls
---
`;
  return (
    publicOrigin +
    images
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
    .join("---\n")
  );
}

test("rewrites every pinned Plane image to an immutable digest", () => {
  const result = rewritePlaneImages(manifestsFor(), lock);
  assert.equal(result.replacements, Object.keys(lock).length);
  assert.deepEqual(result.images, Object.keys(lock).sort());
  assert.equal(result.manifests.includes(":latest"), false);
  assert.equal(result.manifests.includes(":v1.3.1"), false);
  assert.match(result.manifests, /@sha256:[0-9a-f]{64}/);
  assert.match(result.manifests, /WEB_URL: https:\/\/plane\.example\.com/);
  assert.match(
    result.manifests,
    /CORS_ALLOWED_ORIGINS: https:\/\/plane\.example\.com/,
  );
  assert.match(
    result.manifests,
    /nginx\.ingress\.kubernetes\.io\/proxy-redirect-from: http:\/\/plane\.example\.com:3000\//,
  );
  assert.match(
    result.manifests,
    /nginx\.ingress\.kubernetes\.io\/proxy-redirect-to: https:\/\/plane\.example\.com\//,
  );
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

test("fails closed without an exact TLS public origin", () => {
  const manifests = manifestsFor().replace(
    `    - hosts:
        - plane.example.com
      secretName: plane-tls`,
    `    - hosts:
        - other.example.com
      secretName: plane-tls`,
  );
  assert.throws(
    () => rewritePlaneImages(manifests, lock),
    /must terminate TLS for its primary host/,
  );
});

test("fails closed when WEB_URL drifts from the ingress host", () => {
  const manifests = manifestsFor().replace(
    "WEB_URL: http://plane.example.com",
    "WEB_URL: http://other.example.com",
  );
  assert.throws(
    () => rewritePlaneImages(manifests, lock),
    /WEB_URL does not match/,
  );
});
