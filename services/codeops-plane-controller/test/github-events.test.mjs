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
      title: "Bounded PR",
      html_url: "https://github.com/anulman/renoconcierge/pull/158",
      updated_at: "2026-07-30T22:45:00.000Z",
      merged: true,
      head: { sha: "a".repeat(40), ref: "feat/a" },
      base: { ref: "main" },
    },
    sender: { id: 6723643628, login: "anulman", type: "User" },
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
      title: "Bounded PR",
      url: "https://github.com/anulman/renoconcierge/pull/158",
      actorId: 6723643628,
      actorLogin: "anulman",
      actorType: "User",
      updatedAt: "2026-07-30T22:45:00.000Z",
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
      reviewerType: "User",
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
          title: "Stacked PR",
          html_url: "https://github.com/anulman/renoconcierge/pull/158",
          updated_at: "2026-07-30T22:46:00.000Z",
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
        sender: { id: 6723643628, login: "anulman", type: "User" },
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

test("parses top-level and inline PR comments as bounded human events", () => {
  const issueComment = parseGitHubEvent({
    event: "issue_comment",
    rawBody: Buffer.from(JSON.stringify({
      action: "created",
      repository: { full_name: "anulman/renoconcierge" },
      issue: {
        number: 158,
        title: "Bounded PR",
        state: "open",
        pull_request: { url: "https://api.github.com/repos/anulman/renoconcierge/pulls/158" },
      },
      comment: {
        id: 7001,
        body: "Please cover this path.",
        html_url: "https://github.com/anulman/renoconcierge/pull/158#issuecomment-7001",
        created_at: "2026-07-30T22:47:00.000Z",
        updated_at: "2026-07-30T22:47:00.000Z",
        user: { id: 6723643628, login: "anulman", type: "User" },
      },
    })),
  });
  assert.equal(issueComment.kind, "issue_comment");
  assert.equal(issueComment.body, "Please cover this path.");

  const inline = parseGitHubEvent({
    event: "pull_request_review_comment",
    rawBody: Buffer.from(JSON.stringify({
      action: "edited",
      repository: { full_name: "anulman/renoconcierge" },
      pull_request: {
        number: 158,
        title: "Bounded PR",
        state: "open",
        head: { sha: "b".repeat(40), ref: "feat/reviewed" },
        base: { ref: "main" },
      },
      comment: {
        id: 7002,
        pull_request_review_id: 9001,
        body: "Keep this exact.",
        html_url: "https://github.com/anulman/renoconcierge/pull/158#discussion_r7002",
        path: "services/codeops-plane-controller/src/github-events.ts",
        line: 42,
        side: "RIGHT",
        commit_id: "b".repeat(40),
        created_at: "2026-07-30T22:48:00.000Z",
        updated_at: "2026-07-30T22:49:00.000Z",
        user: { id: 6723643628, login: "anulman", type: "User" },
      },
    })),
  });
  assert.equal(inline.kind, "pull_request_review_comment");
  assert.equal(inline.path, "services/codeops-plane-controller/src/github-events.ts");
  assert.equal(inline.line, 42);
});

test("retains bot PR mutations without classifying the actor as human", () => {
  const botEvent = parseGitHubPullRequestEvent({
    event: "pull_request",
    rawBody: Buffer.from(JSON.stringify({
      action: "synchronize",
      repository: { full_name: "anulman/renoconcierge" },
      pull_request: {
        number: 158,
        title: "Automated update",
        html_url: "https://github.com/anulman/renoconcierge/pull/158",
        updated_at: "2026-07-30T22:46:00.000Z",
        merged: false,
        head: { sha: "b".repeat(40), ref: "dependabot/npm" },
        base: { ref: "main" },
      },
      sender: { id: 49699333, login: "dependabot[bot]", type: "Bot" },
    })),
  });
  assert.equal(botEvent.actorType, "Bot");
  assert.equal(botEvent.actorLogin, "dependabot[bot]");
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
