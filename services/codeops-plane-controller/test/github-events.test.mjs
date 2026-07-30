import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
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
      repository: "anulman/renoconcierge",
      number: 158,
      action: "closed",
      merged: true,
      headSha: "a".repeat(40),
      headRef: "feat/a",
      baseRef: "main",
    },
  );
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
