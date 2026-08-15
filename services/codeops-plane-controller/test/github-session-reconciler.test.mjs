import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createFileResearchDedupLedger,
  reconcileGitHubSessionEvent,
} from "../dist/index.js";

const binding = {
  version: "codeops.pull-request-binding/v1",
  workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
  projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
  workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
  workflowId: "coding-initial",
  repository: "example-org/example-repository",
  number: 159,
  state: "open",
  headSha: "b".repeat(40),
  headRef: "feat/agents-ui",
  baseRef: "feat/codeops-contracts-ci",
  baseSha: "a".repeat(40),
  qualified: false,
  updatedAt: "2026-08-09T17:00:00.000Z",
};

function currentPullRequest(overrides = {}) {
  return {
    repository: binding.repository,
    number: binding.number,
    state: "open",
    headSha: binding.headSha,
    headRef: binding.headRef,
    baseRef: binding.baseRef,
    baseSha: binding.baseSha,
    ...overrides,
  };
}

function comment(overrides = {}) {
  return {
    kind: "issue_comment",
    repository: binding.repository,
    number: binding.number,
    action: "created",
    title: "Add Agent Sessions command center foundation",
    pullRequestState: "open",
    commentId: 7001,
    body: "Please make the empty state actionable.",
    url: "https://github.com/example-org/example-repository/pull/159#issuecomment-7001",
    actorId: 6723643628,
    actorLogin: "anulman",
    actorType: "User",
    createdAt: "2026-08-09T17:10:00.000Z",
    updatedAt: "2026-08-09T17:10:00.000Z",
    ...overrides,
  };
}

async function withLedger(run) {
  const root = await mkdtemp(path.join(tmpdir(), "codeops-github-session-"));
  try {
    await run(createFileResearchDedupLedger({ rootDirectory: root, leaseDurationMs: 60_000 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("steers one allowlisted bound PR comment with deterministic identity", async () => {
  await withLedger(async (ledger) => {
    const calls = [];
    const input = {
      event: comment(),
      receivedAt: "2026-08-09T17:10:01.000Z",
      allowedActorIds: new Set([6723643628]),
      bindings: {
        async getByPullRequest() { return binding; },
      },
      async resolveCurrentPullRequest() {
        return currentPullRequest();
      },
      ledger,
      async steer(request) {
        calls.push(request);
        return { sessionId: "session-159" };
      },
    };
    const result = await reconcileGitHubSessionEvent(input);
    assert.deepEqual(result, {
      status: "steered",
      sessionId: "session-159",
      workItemId: binding.workItemId,
      duplicate: false,
    });
    assert.equal(calls[0].prompt, comment().body);
    assert.equal(calls[0].principalId, "github:6723643628");
    assert.match(calls[0].idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.equal(calls[0].event.currentHeadSha, binding.headSha);
    assert.equal(calls[0].event.headRef, binding.headRef);
    assert.equal(calls[0].event.baseRef, binding.baseRef);
    assert.equal(calls[0].event.baseSha, binding.baseSha);

    const duplicate = await reconcileGitHubSessionEvent(input);
    assert.equal(duplicate.duplicate, true);
    assert.equal(calls.length, 1);
  });
});

test("rejects stale inline comments and unauthorized actors before steering", async () => {
  await withLedger(async (ledger) => {
    const bindings = { async getByPullRequest() { return binding; } };
    const stale = await reconcileGitHubSessionEvent({
      event: {
        kind: "pull_request_review_comment",
        repository: binding.repository,
        number: binding.number,
        action: "created",
        title: "Agent Sessions",
        pullRequestState: "open",
        reviewId: 9001,
        commentId: 7002,
        body: "This refers to an old head.",
        url: "https://github.com/example",
        path: "sites/agents-ui/src/routes/index.tsx",
        line: 42,
        side: "RIGHT",
        commentHeadSha: "a".repeat(40),
        currentHeadSha: binding.headSha,
        headRef: binding.headRef,
        baseRef: binding.baseRef,
        baseSha: binding.baseSha,
        actorId: 6723643628,
        actorLogin: "anulman",
        actorType: "User",
        createdAt: "2026-08-09T17:11:00.000Z",
        updatedAt: "2026-08-09T17:11:00.000Z",
      },
      receivedAt: "2026-08-09T17:11:01.000Z",
      allowedActorIds: new Set([6723643628]),
      bindings,
      ledger,
      resolveCurrentPullRequest: async () => { throw new Error("must not resolve"); },
      steer: async () => { throw new Error("must not steer"); },
    });
    assert.equal(stale.status, "ignored");

    const unauthorized = await reconcileGitHubSessionEvent({
      event: comment({ commentId: 7003, actorId: 1 }),
      receivedAt: "2026-08-09T17:12:00.000Z",
      allowedActorIds: new Set([6723643628]),
      bindings: { async getByPullRequest() { throw new Error("must not load"); } },
      ledger,
      resolveCurrentPullRequest: async () => { throw new Error("must not resolve"); },
      steer: async () => { throw new Error("must not steer"); },
    });
    assert.deepEqual(unauthorized, { status: "ignored", reason: "actor-is-not-allowlisted" });
  });
});

test("never turns bot activity into a live session prompt", async () => {
  await withLedger(async (ledger) => {
    let calls = 0;
    const result = await reconcileGitHubSessionEvent({
      event: comment({ actorType: "Bot", actorLogin: "renovate[bot]" }),
      receivedAt: "2026-08-09T17:12:00.000Z",
      allowedActorIds: new Set([6723643628]),
      bindings: { async getByPullRequest() { return binding; } },
      ledger,
      resolveCurrentPullRequest: async () => { throw new Error("must not resolve"); },
      steer: async () => {
        calls += 1;
        return { sessionId: "must-not-run" };
      },
    });
    assert.deepEqual(result, {
      status: "ignored",
      reason: "actor-is-not-allowlisted",
    });
    assert.equal(calls, 0);
  });
});

test("rejects a SHA-less comment when the live pull-request head moved", async () => {
  await withLedger(async (ledger) => {
    let steers = 0;
    const result = await reconcileGitHubSessionEvent({
      event: comment({ commentId: 7004 }),
      receivedAt: "2026-08-09T17:13:00.000Z",
      allowedActorIds: new Set([6723643628]),
      bindings: { async getByPullRequest() { return binding; } },
      ledger,
      async resolveCurrentPullRequest() {
        return currentPullRequest({ headSha: "c".repeat(40) });
      },
      async steer() {
        steers += 1;
        return { sessionId: "must-not-run" };
      },
    });
    assert.deepEqual(result, {
      status: "ignored",
      reason: "event-does-not-match-bound-current-head",
    });
    assert.equal(steers, 0);
  });
});

test("rejects a SHA-less comment when the live pull-request base moved", async () => {
  await withLedger(async (ledger) => {
    let steers = 0;
    const result = await reconcileGitHubSessionEvent({
      event: comment({ commentId: 7006 }),
      receivedAt: "2026-08-09T17:13:30.000Z",
      allowedActorIds: new Set([6723643628]),
      bindings: { async getByPullRequest() { return binding; } },
      ledger,
      async resolveCurrentPullRequest() {
        return currentPullRequest({ baseSha: "c".repeat(40) });
      },
      async steer() {
        steers += 1;
        return { sessionId: "must-not-run" };
      },
    });
    assert.deepEqual(result, {
      status: "ignored",
      reason: "event-does-not-match-bound-current-head",
    });
    assert.equal(steers, 0);
  });
});

test("rejects a current-head response for a different pull request", async () => {
  await withLedger(async (ledger) => {
    await assert.rejects(
      reconcileGitHubSessionEvent({
        event: comment({ commentId: 7005 }),
        receivedAt: "2026-08-09T17:14:00.000Z",
        allowedActorIds: new Set([6723643628]),
        bindings: { async getByPullRequest() { return binding; } },
        ledger,
        async resolveCurrentPullRequest() {
          return currentPullRequest({ number: binding.number + 1 });
        },
        steer: async () => { throw new Error("must not steer"); },
      }),
      /different identity/,
    );
  });
});
