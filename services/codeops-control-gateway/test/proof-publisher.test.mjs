import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createAwsS3Transport,
  createS3ProofPublisher,
} from "../dist/proof-publisher.js";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const videoBytes = Buffer.from("video-bytes");
const posterBytes = Buffer.from("poster-bytes");

const config = {
  destinationId: "ovh:bhs:codeops-proofs",
  endpoint: "https://s3.bhs.example.test/",
  publicBaseUrl: "https://codeops-proofs.s3.bhs.example.test/",
  bucket: "codeops-proofs",
  region: "bhs",
  retentionDays: 90,
  accessKeyId: "access-key-id",
  secretAccessKey: "secret-access-key",
};

const request = {
  version: "codeops.proof-publication-request/v1",
  plugin: "codeops.proof-publisher.s3/v1",
  expectedDestinationId: config.destinationId,
  classification: "sanitized-public",
  identity: {
    repository: "anulman/renoconcierge",
    pullRequestNumber: 157,
    headSha: "a".repeat(40),
    runId: "pr157-alpha40-01",
  },
  artifacts: [
    {
      kind: "reviewer-video",
      mediaType: "video/mp4",
      extension: "mp4",
      byteLength: videoBytes.byteLength,
      sha256: digest(videoBytes),
      bytesBase64: videoBytes.toString("base64"),
    },
    {
      kind: "poster",
      mediaType: "image/png",
      extension: "png",
      byteLength: posterBytes.byteLength,
      sha256: digest(posterBytes),
      bytesBase64: posterBytes.toString("base64"),
    },
  ],
};

function fakeTransport() {
  const objects = new Map();
  const puts = [];
  return {
    objects,
    puts,
    transport: {
      async head(key) {
        const object = objects.get(key);
        if (!object) return { status: 404, headers: new Headers() };
        return {
          status: 200,
          headers: new Headers({
            "content-length": String(object.body.byteLength),
            "content-type": object.headers.get("content-type"),
            "x-amz-meta-codeops-sha256": object.headers.get("x-amz-meta-codeops-sha256"),
            etag: object.etag,
          }),
        };
      },
      async put(key, body, headers) {
        puts.push({ key, body: Buffer.from(body), headers: new Headers(headers) });
        if (objects.has(key)) return { status: 412, headers: new Headers() };
        objects.set(key, { body: Buffer.from(body), headers: new Headers(headers), etag: `"${puts.length}"` });
        return { status: 200, headers: new Headers({ etag: `"${puts.length}"` }) };
      },
    },
  };
}

test("publishes exact immutable proof objects and returns a bound receipt", async () => {
  const fake = fakeTransport();
  const publish = createS3ProofPublisher(config, {
    transport: fake.transport,
    now: () => new Date("2026-08-23T19:52:00.000Z"),
  });
  const receipt = await publish(request);
  assert.equal(receipt.status, "published");
  assert.equal(receipt.expiresAt, "2026-11-21T19:52:00.000Z");
  assert.deepEqual(receipt.artifacts.map(({ kind }) => kind), ["reviewer-video", "poster", "packet-index"]);
  assert.equal(fake.puts.length, 3);
  for (const put of fake.puts) {
    assert.equal(put.headers.get("if-none-match"), "*");
    assert.equal(put.headers.get("x-amz-acl"), "public-read");
    assert.equal(put.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(put.key, /^anulman\/renoconcierge\/pull-157\/a{40}\/pr157-alpha40-01\//);
  }
  assert.equal(fake.puts[0].headers.get("content-disposition"), 'inline; filename="reviewer-video.mp4"');
  assert.equal(fake.puts[1].headers.get("content-disposition"), 'inline; filename="poster.png"');
  assert.equal(fake.puts[2].headers.get("content-type"), "application/json");
  const index = JSON.parse(fake.puts[2].body.toString("utf8"));
  assert.equal(index.destinationId, config.destinationId);
  assert.deepEqual(index.identity, request.identity);
  assert.deepEqual(index.artifacts.map(({ kind }) => kind), ["reviewer-video", "poster"]);
});

test("replays exact objects without overwriting them", async () => {
  const fake = fakeTransport();
  const publish = createS3ProofPublisher(config, { transport: fake.transport });
  assert.equal((await publish(request)).status, "published");
  assert.equal(fake.puts.length, 3);
  assert.equal((await publish(request)).status, "published");
  assert.equal(fake.puts.length, 3);
});

test("fails closed for destination, artifact, and existing-object drift", async () => {
  const fake = fakeTransport();
  const publish = createS3ProofPublisher(config, { transport: fake.transport });
  assert.deepEqual(await publish({ ...request, expectedDestinationId: "ovh:bhs:other" }), {
    version: "codeops.proof-publication-receipt/v1",
    plugin: "codeops.proof-publisher.s3/v1",
    status: "failed",
    destinationId: config.destinationId,
    identity: request.identity,
    code: "destination_mismatch",
    retryable: false,
  });
  const invalid = structuredClone(request);
  invalid.artifacts[0].sha256 = `sha256:${"f".repeat(64)}`;
  assert.equal((await publish(invalid)).code, "artifact_invalid");
  const sensitive = await publish({ ...request, classification: "sensitive" });
  assert.equal(sensitive.status, "failed");
  assert.equal(sensitive.code, "sensitive_proof");
  assert.equal(sensitive.retryable, false);
  assert.equal(fake.puts.length, 0);

  const first = await publish(request);
  const videoKey = first.artifacts[0].objectKey;
  fake.objects.get(videoKey).headers.set("x-amz-meta-codeops-sha256", `sha256:${"0".repeat(64)}`);
  const drift = await publish(request);
  assert.equal(drift.status, "failed");
  assert.equal(drift.code, "object_conflict");
  assert.equal(drift.retryable, false);
});

test("signs path-style S3 calls without putting credentials in the URL", async () => {
  const calls = [];
  const transport = createAwsS3Transport(config, async (signed) => {
    calls.push(signed);
    return new Response(null, { status: 404 });
  });
  await transport.head("owner/repo/object.mp4");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://s3.bhs.example.test/codeops-proofs/owner/repo/object.mp4");
  assert.equal(calls[0].url.includes(config.accessKeyId), false);
  assert.equal(calls[0].url.includes(config.secretAccessKey), false);
  assert.match(calls[0].headers.get("authorization"), /^AWS4-HMAC-SHA256 /);
});
