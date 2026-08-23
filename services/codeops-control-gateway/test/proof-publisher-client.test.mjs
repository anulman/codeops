import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createProofPublisherClient } from "../dist/proof-publisher-client.js";

const bytes = Buffer.from("proof");
const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const request = {
  version: "codeops.proof-publication-request/v1",
  plugin: "codeops.proof-publisher.s3/v1",
  expectedDestinationId: "ovh:bhs:codeops-proofs",
  classification: "sanitized-public",
  identity: {
    repository: "anulman/renoconcierge",
    pullRequestNumber: 157,
    headSha: "a".repeat(40),
    runId: "run-1",
  },
  artifacts: [
    { kind: "reviewer-video", mediaType: "video/mp4", extension: "mp4", byteLength: bytes.length, sha256, bytesBase64: bytes.toString("base64") },
    { kind: "poster", mediaType: "image/png", extension: "png", byteLength: bytes.length, sha256, bytesBase64: bytes.toString("base64") },
  ],
};

test("relays a publication and verifies the exact receipt binding", async () => {
  const calls = [];
  const client = createProofPublisherClient({
    origin: "http://codeops-proof-publisher:8080",
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
    token: "p".repeat(48),
    fetch: async () => Response.json({
      version: "codeops.proof-publication-receipt/v1",
      plugin: "codeops.proof-publisher.s3/v1",
      status: "failed",
      destinationId: request.expectedDestinationId,
      identity: { ...request.identity, headSha: "b".repeat(40) },
      code: "upload_failed",
      retryable: true,
    }, { status: 409 }),
  });
  await assert.rejects(client(request), /head does not match/);
});
