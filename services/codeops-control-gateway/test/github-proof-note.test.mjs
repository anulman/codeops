import assert from "node:assert/strict";
import test from "node:test";
import { renderGitHubProofNote } from "../dist/github-proof-note.js";

const headSha = "a".repeat(40);
const videoUrl = "https://proofs.example.test/example/app/pull-7/head/run/reviewer-video.mp4";
const posterUrl = "https://proofs.example.test/example/app/pull-7/head/run/poster.png";
const indexUrl = "https://proofs.example.test/example/app/pull-7/head/run/packet-index.json";
const receipt = {
  version: "codeops.proof-publication-receipt/v1",
  plugin: "codeops.proof-publisher.s3/v1",
  status: "published",
  destinationId: "s3:test:proofs",
  identity: {
    repository: "example/app",
    pullRequestNumber: 7,
    headSha,
    runId: "proof-7",
  },
  artifacts: [
    {
      kind: "reviewer-video",
      objectKey: "example/app/pull-7/head/run/reviewer-video.mp4",
      publicUrl: videoUrl,
      mediaType: "video/mp4",
      byteLength: 123,
      sha256: `sha256:${"b".repeat(64)}`,
      etag: "video",
    },
    {
      kind: "poster",
      objectKey: "example/app/pull-7/head/run/poster.png",
      publicUrl: posterUrl,
      mediaType: "image/png",
      byteLength: 45,
      sha256: `sha256:${"c".repeat(64)}`,
      etag: "poster",
    },
    {
      kind: "packet-index",
      objectKey: "example/app/pull-7/head/run/packet-index.json",
      publicUrl: indexUrl,
      mediaType: "application/json",
      byteLength: 67,
      sha256: `sha256:${"d".repeat(64)}`,
      etag: "index",
    },
  ],
  expiresAt: "2026-11-22T00:09:16.321Z",
};

test("renders one inline poster linked to the reviewer video", () => {
  const note = renderGitHubProofNote({
    receipt,
    release: "v0.5.0-alpha.43",
    reviewerTrimStartSeconds: 16.095,
    reviewerDurationSeconds: 32.24,
  });

  const linkedPoster = `[![CodeOps UI proof — click to watch the reviewer video](${posterUrl})](${videoUrl})`;
  assert.equal(note.split("\n").filter((line) => line === linkedPoster).length, 1);
  assert.equal(note.split(posterUrl).length - 1, 1);
  assert.equal(note.split(videoUrl).length - 1, 1);
  assert.equal(note.includes(indexUrl), false);
  assert.equal(note.includes("Watch the reviewer video"), false);
  assert.equal(note.includes("View the poster"), false);
  assert.equal(note.includes("Open the packet index"), false);
  assert.match(note, new RegExp(`codeops-proof-publication:proof-7:${headSha}`));
  assert.match(note, /first meaningful action at `16\.095s`/);
  assert.match(note, /encoded reviewer duration `32\.240s`/);
  assert.match(note, /Retention: expires `2026-11-22`/);
});

test("rejects a failed proof publication", () => {
  const failed = {
    version: receipt.version,
    plugin: receipt.plugin,
    status: "failed",
    destinationId: receipt.destinationId,
    identity: receipt.identity,
    code: "upload_failed",
    retryable: true,
    publicationState: "not-published",
    stagedObjectKeys: [],
  };
  assert.throws(() => renderGitHubProofNote({
    receipt: failed,
    release: "v0.5.0-alpha.43",
    reviewerTrimStartSeconds: 1,
    reviewerDurationSeconds: 2,
  }), /require a published proof receipt/);
});

test("rejects invalid release and reviewer timing metadata", () => {
  const render = (overrides = {}) => renderGitHubProofNote({
    receipt,
    release: "v0.5.0-alpha.43",
    reviewerTrimStartSeconds: 1,
    reviewerDurationSeconds: 2,
    ...overrides,
  });

  assert.throws(() => render({ release: "release with spaces" }), /release identity/);
  assert.throws(() => render({ reviewerTrimStartSeconds: Number.NaN }), /finite non-negative/);
  assert.throws(() => render({ reviewerDurationSeconds: -1 }), /finite non-negative/);
  assert.doesNotThrow(() => render({ reviewerTrimStartSeconds: 60, reviewerDurationSeconds: 40 }));
  assert.throws(() => render({ reviewerDurationSeconds: 0 }), /greater than zero/);
});
