import assert from "node:assert/strict";
import { test } from "node:test";
import {
  proofPublicationReceiptSchema,
  proofPublicationRequestSchema,
} from "../dist/index.js";

const request = {
  version: "codeops.proof-publication-request/v1",
  plugin: "codeops.proof-publisher.s3/v1",
  expectedDestinationId: "ovh:bhs:codeops-proofs",
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
      byteLength: 3,
      sha256: `sha256:${"b".repeat(64)}`,
      bytesBase64: "YWJj",
    },
    {
      kind: "poster",
      mediaType: "image/png",
      extension: "png",
      byteLength: 3,
      sha256: `sha256:${"b".repeat(64)}`,
      bytesBase64: "YWJj",
    },
  ],
};

test("accepts one exact sanitized public proof publication", () => {
  assert.deepEqual(proofPublicationRequestSchema.parse(request), request);
});

test("rejects credentials, mutable identity, and unknown versions", () => {
  const invalid = [
    { ...request, accessKeyId: "secret" },
    { ...request, plugin: "codeops.proof-publisher.s3/v2" },
    { ...request, identity: { ...request.identity, headSha: "main" } },
    { ...request, identity: { ...request.identity, runId: "../mutable" } },
    { ...request, artifacts: [{ ...request.artifacts[0], byteLength: 50 * 1024 * 1024 + 1 }, request.artifacts[1]] },
    { ...request, artifacts: [...request.artifacts].reverse() },
    {
      ...request,
      artifacts: [request.artifacts[0], { ...request.artifacts[1], extension: "jpg" }],
    },
  ];
  for (const value of invalid) {
    assert.equal(proofPublicationRequestSchema.safeParse(value).success, false);
  }
  assert.equal(
    proofPublicationRequestSchema.parse({ ...request, classification: "sensitive" }).classification,
    "sensitive",
  );
});

test("accepts exact success and failure receipts without provider credentials", () => {
  const baseArtifact = {
    objectKey: `anulman/renoconcierge/pull-157/${"a".repeat(40)}/pr157-alpha40-01/reviewer-video-${"b".repeat(64)}.mp4`,
    publicUrl: "https://codeops-proofs.s3.bhs.example.test/proof.mp4",
    byteLength: 3,
    sha256: `sha256:${"b".repeat(64)}`,
    etag: "etag",
  };
  const success = {
    version: "codeops.proof-publication-receipt/v1",
    plugin: "codeops.proof-publisher.s3/v1",
    status: "published",
    destinationId: request.expectedDestinationId,
    identity: request.identity,
    artifacts: [
      { ...baseArtifact, kind: "reviewer-video", mediaType: "video/mp4" },
      { ...baseArtifact, kind: "poster", mediaType: "image/png", objectKey: baseArtifact.objectKey.replace("reviewer-video", "poster"), publicUrl: "https://codeops-proofs.s3.bhs.example.test/poster.png" },
      { ...baseArtifact, kind: "packet-index", mediaType: "application/json", objectKey: baseArtifact.objectKey.replace("reviewer-video", "packet-index"), publicUrl: "https://codeops-proofs.s3.bhs.example.test/index.json" },
    ],
    expiresAt: "2026-11-21T19:52:00.000Z",
  };
  assert.deepEqual(proofPublicationReceiptSchema.parse(success), success);
  assert.equal(proofPublicationReceiptSchema.safeParse({ ...success, secretAccessKey: "secret" }).success, false);
  for (const publicUrl of [
    "http://codeops-proofs.example.test/proof.mp4",
    "https://user:password@codeops-proofs.example.test/proof.mp4",
    "https://codeops-proofs.example.test/proof.mp4?token=secret",
    "https://codeops-proofs.example.test/proof.mp4#secret",
  ]) {
    const invalid = structuredClone(success);
    invalid.artifacts[0].publicUrl = publicUrl;
    assert.equal(proofPublicationReceiptSchema.safeParse(invalid).success, false);
  }

  const failure = {
    version: "codeops.proof-publication-receipt/v1",
    plugin: "codeops.proof-publisher.s3/v1",
    status: "failed",
    destinationId: request.expectedDestinationId,
    identity: request.identity,
    code: "destination_mismatch",
    retryable: false,
    publicationState: "not-published",
    stagedObjectKeys: [],
  };
  assert.deepEqual(proofPublicationReceiptSchema.parse(failure), failure);
  assert.equal(proofPublicationReceiptSchema.safeParse({
    ...failure,
    publicationState: "staged",
  }).success, false);
});
