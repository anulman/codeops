import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  parseGitHubEvent,
  parseGitHubPullRequestEvent,
  verifyGitHubWebhookSignature,
} from "../dist/index.js";

const secret = "s".repeat(64);
const payload = Buffer.from(
  JSON.stringify({
    action: "closed",
    repository: { full_name: "anulman/renoconcierge" },
    pull_request: {
      number: 158,
      merged: true,
      head: { sha: "a".repeat(40), ref: "feat/a" },
      base: { ref: "main" },
    },
  }),
);
const signature = `sha256=${createHmac("sha256", secret)
  .update(payload)
  .digest("hex")}`;

test("authenticates the exact raw GitHub body and parses bounded PR events", () => {
  assert.equal(
    verifyGitHubWebhookSignature({ rawBody: payload, secret, signature }),
    true,
  );
  assert.equal(
    verifyGitHubWebhookSignature({
      rawBody: Buffer.from(`${payload.toString("utf8")} `),
      secret,
      signature,
    }),
    false,
  );
  assert.deepEqual(
    parseGitHubPullRequestEvent({
      rawBody: payload,
      event: "pull_request",
    }),
    {
      kind: "pull_request",
      repository: "anulman/renoconcierge",
      number: 158,
      action: "closed",
      merged: true,
      headSha: "a".repeat(40),
      headRef: "feat/a",
      baseRef: "main",
      stack: null,
    },
  );
});

test("parses one submitted human PR review without trusting inline comments", () => {
  const review = Buffer.from(
    JSON.stringify({
      action: "submitted",
      repository: { full_name: "anulman/renoconcierge" },
      pull_request: {
        number: 158,
        head: { sha: "b".repeat(40), ref: "feat/reviewed" },
        base: { ref: "main" },
      },
      review: {
        id: 9001,
        body: "Please tighten the exact-head assertion.",
        commit_id: "b".repeat(40),
        state: "changes_requested",
        submitted_at: "2026-07-30T22:45:00.000Z",
        user: { id: 6723643628, login: "anulman", type: "User" },
      },
    }),
  );
  assert.deepEqual(
    parseGitHubEvent({
      rawBody: review,
      event: "pull_request_review",
    }),
    {
      kind: "pull_request_review",
      repository: "anulman/renoconcierge",
      number: 158,
      action: "submitted",
      reviewId: 9001,
      state: "changes_requested",
      body: "Please tighten the exact-head assertion.",
      reviewerId: 6723643628,
      reviewerLogin: "anulman",
      reviewedHeadSha: "b".repeat(40),
      currentHeadSha: "b".repeat(40),
      headRef: "feat/reviewed",
      baseRef: "main",
      stack: null,
      submittedAt: "2026-07-30T22:45:00.000Z",
    },
  );
});

test("parses GitHub-native stack identity from a relevant PR mutation", () => {
  const stacked = parseGitHubPullRequestEvent({
    event: "pull_request",
    rawBody: Buffer.from(
      JSON.stringify({
        action: "edited",
        repository: { full_name: "anulman/renoconcierge" },
        pull_request: {
          number: 158,
          merged: false,
          head: { sha: "b".repeat(40), ref: "feat/child" },
          base: { ref: "feat/base" },
          stack: {
            number: 42,
            size: 2,
            position: 2,
            base: { ref: "main", sha: "a".repeat(40) },
          },
        },
      }),
    ),
  });
  assert.equal(stacked.action, "edited");
  assert.deepEqual(stacked.stack, {
    number: 42,
    size: 2,
    position: 2,
    base: { ref: "main", sha: "a".repeat(40) },
  });
});

test("ignores unrelated GitHub event kinds and rejects unsafe payloads", () => {
  assert.equal(
    parseGitHubPullRequestEvent({ rawBody: payload, event: "push" }),
    null,
  );
  assert.throws(
    () =>
      parseGitHubPullRequestEvent({
        rawBody: Buffer.from(
          JSON.stringify({
            action: "opened",
            repository: { full_name: "anulman/renoconcierge" },
            pull_request: {
              number: 158,
              merged: false,
              head: { sha: "a".repeat(40), ref: "feat/a" },
              base: { ref: "main" },
            },
          }),
        ),
        event: "pull_request",
      }),
    /Invalid enum value/,
  );
});
