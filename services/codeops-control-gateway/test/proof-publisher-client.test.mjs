import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProofPublisherClient } from "../dist/proof-publisher-client.js";

const bytes = Buffer.from("proof");
const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const request = {
  version: "codeops.proof-publication-request/v1",
  plugin: "codeops.proof-publisher.s3/v1",
  expectedDestinationId: "s3:test-region:codeops-proofs",
  classification: "sanitized-public",
  identity: {
    repository: "example-org/example-app",
    pullRequestNumber: 157,
    headSha: "a".repeat(40),
    runId: "run-1",
  },
  artifacts: [
    { kind: "reviewer-video", mediaType: "video/mp4", extension: "mp4", byteLength: bytes.length, sha256, bytesBase64: bytes.toString("base64") },
    { kind: "poster", mediaType: "image/png", extension: "png", byteLength: bytes.length, sha256, bytesBase64: bytes.toString("base64") },
  ],
};
const publicBaseUrl = "https://codeops-proofs.s3.region-1.example.test/";

function objectKey(artifact) {
  return [
    "example-org/example-app",
    "pull-157",
    "a".repeat(40),
    "run-1",
    `${artifact.kind}-${artifact.sha256.slice("sha256:".length)}.${artifact.extension}`,
  ].join("/");
}

function publicUrl(key) {
  return new URL(key, publicBaseUrl).toString();
}

test("relays a publication and verifies the exact receipt binding", async () => {
  const calls = [];
  const client = createProofPublisherClient({
    origin: "http://codeops-proof-publisher:8080",
    publicBaseUrl,
    token: "p".repeat(48),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        version: "codeops.proof-publication-receipt/v1",
        plugin: "codeops.proof-publisher.s3/v1",
        status: "failed",
        destinationId: request.expectedDestinationId,
        identity: request.identity,
        code: "upload_failed",
        retryable: true,
        publicationState: "not-published",
        stagedObjectKeys: [],
      }, { status: 409 });
    },
  });
  const receipt = await client(request);
  assert.equal(receipt.code, "upload_failed");
  assert.equal(calls[0].url.toString(), "http://codeops-proof-publisher:8080/v1/proof-publications");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${"p".repeat(48)}`);
});

test("rejects a receipt that is not bound to the requested head", async () => {
  const client = createProofPublisherClient({
    origin: "http://codeops-proof-publisher:8080",
    publicBaseUrl,
    token: "p".repeat(48),
    fetch: async () => Response.json({
      version: "codeops.proof-publication-receipt/v1",
      plugin: "codeops.proof-publisher.s3/v1",
      status: "failed",
      destinationId: request.expectedDestinationId,
      identity: { ...request.identity, headSha: "b".repeat(40) },
      code: "upload_failed",
      retryable: true,
      publicationState: "not-published",
      stagedObjectKeys: [],
    }, { status: 409 }),
  });
  await assert.rejects(client(request), /head does not match/);
});

test("binds successful artifact receipts to request bytes, keys, and public origin", async () => {
  const [video, poster] = request.artifacts;
  const videoKey = objectKey(video);
  const posterKey = objectKey(poster);
  const indexSha256 = `sha256:${"c".repeat(64)}`;
  const indexKey = [
    "example-org/example-app",
    "pull-157",
    "a".repeat(40),
    "run-1",
    `packet-index-${indexSha256.slice("sha256:".length)}.json`,
  ].join("/");
  const success = {
    version: "codeops.proof-publication-receipt/v1",
    plugin: "codeops.proof-publisher.s3/v1",
    status: "published",
    destinationId: request.expectedDestinationId,
    identity: request.identity,
    artifacts: [
      { kind: video.kind, objectKey: videoKey, publicUrl: publicUrl(videoKey), mediaType: video.mediaType, byteLength: video.byteLength, sha256: video.sha256, etag: "video" },
      { kind: poster.kind, objectKey: posterKey, publicUrl: publicUrl(posterKey), mediaType: poster.mediaType, byteLength: poster.byteLength, sha256: poster.sha256, etag: "poster" },
      { kind: "packet-index", objectKey: indexKey, publicUrl: publicUrl(indexKey), mediaType: "application/json", byteLength: 100, sha256: indexSha256, etag: "index" },
    ],
    expiresAt: "2026-11-21T19:52:00.000Z",
  };
  const createClient = (receipt) => createProofPublisherClient({
    origin: "http://codeops-proof-publisher:8080",
    publicBaseUrl,
    token: "p".repeat(48),
    fetch: async () => Response.json(receipt, { status: 200 }),
  });
  assert.equal((await createClient(success)(request)).status, "published");

  for (const mutate of [
    (value) => { value.artifacts[0].sha256 = `sha256:${"d".repeat(64)}`; },
    (value) => { value.artifacts[0].byteLength += 1; },
    (value) => { value.artifacts[0].objectKey = value.artifacts[0].objectKey.replace("run-1", "run-2"); },
    (value) => { value.artifacts[0].publicUrl = "https://attacker.example/proof.mp4"; },
  ]) {
    const invalid = structuredClone(success);
    mutate(invalid);
    await assert.rejects(createClient(invalid)(request), /receipt does not match request/);
  }
});

test("rejects staged object keys outside the exact publication identity", async () => {
  const client = createProofPublisherClient({
    origin: "http://codeops-proof-publisher:8080",
    publicBaseUrl,
    token: "p".repeat(48),
    fetch: async () => Response.json({
      version: "codeops.proof-publication-receipt/v1",
      plugin: "codeops.proof-publisher.s3/v1",
      status: "failed",
      destinationId: request.expectedDestinationId,
      identity: request.identity,
      code: "upload_failed",
      retryable: true,
      publicationState: "staged",
      stagedObjectKeys: [`anulman/other/pull-157/${"a".repeat(40)}/run-1/object.mp4`],
    }, { status: 409 }),
  });
  await assert.rejects(client(request), /staged object key does not match request/);
});
