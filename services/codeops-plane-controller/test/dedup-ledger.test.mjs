import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFileResearchDedupLedger } from "../dist/index.js";

const eventId = "0afa042d-92a9-4326-bdca-5ff5490dbf09";
const requestId =
  "research-request:6d16d65e4dc262ca153e3c3375e9c710414009a8a86c447849b7e5109a68620c";
const firstDigest = `sha256:${"1".repeat(64)}`;
const otherDigest = `sha256:${"2".repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codeops-dedup-"));
  return {
    root,
    ledger: createFileResearchDedupLedger({
      rootDirectory: root,
      leaseDurationMs: 60_000,
    }),
  };
}

test("persists a completed event outcome across controller restarts", async () => {
  const { root, ledger } = await fixture();
  try {
    const claim = await ledger.claim({
      kind: "event",
      stableId: eventId,
      payloadDigest: firstDigest,
      now: "2026-07-26T12:00:00.000Z",
    });
    assert.equal(claim.status, "acquired");
    await ledger.complete({
      claim,
      outcome: "request-created",
      now: "2026-07-26T12:00:01.000Z",
    });

    const restarted = createFileResearchDedupLedger({
      rootDirectory: root,
      leaseDurationMs: 60_000,
    });
    assert.deepEqual(
      await restarted.claim({
        kind: "event",
        stableId: eventId,
        payloadDigest: firstDigest,
        now: "2026-07-26T12:10:00.000Z",
      }),
      { status: "complete", outcome: "request-created" },
    );
    const stored = JSON.parse(
      await readFile(path.join(root, `event-${eventId}.json`), "utf8"),
    );
    assert.equal(stored.state, "complete");
    assert.equal(stored.attempt, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an active claim as busy and reclaims an expired lease", async () => {
  const { root, ledger } = await fixture();
  try {
    const first = await ledger.claim({
      kind: "request",
      stableId: requestId,
      payloadDigest: firstDigest,
      now: "2026-07-26T12:00:00.000Z",
    });
    assert.equal(first.status, "acquired");
    assert.deepEqual(
      await ledger.claim({
        kind: "request",
        stableId: requestId,
        payloadDigest: firstDigest,
        now: "2026-07-26T12:00:30.000Z",
      }),
      {
        status: "busy",
        leaseExpiresAt: "2026-07-26T12:01:00.000Z",
      },
    );

    const reclaimed = await ledger.claim({
      kind: "request",
      stableId: requestId,
      payloadDigest: firstDigest,
      now: "2026-07-26T12:01:00.000Z",
    });
    assert.equal(reclaimed.status, "acquired");
    assert.equal(reclaimed.attempt, 2);
    await assert.rejects(
      ledger.complete({
        claim: first,
        outcome: "request-enqueued",
        now: "2026-07-26T12:01:01.000Z",
      }),
      /lease no longer owns/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retries failed work but fails closed on stable-identity content drift", async () => {
  const { root, ledger } = await fixture();
  try {
    const first = await ledger.claim({
      kind: "event",
      stableId: eventId,
      payloadDigest: firstDigest,
      now: "2026-07-26T12:00:00.000Z",
    });
    assert.equal(first.status, "acquired");
    await ledger.fail({
      claim: first,
      failure: "temporary Temporal admission failure with\nbounded details",
      now: "2026-07-26T12:00:01.000Z",
    });

    const retry = await ledger.claim({
      kind: "event",
      stableId: eventId,
      payloadDigest: firstDigest,
      now: "2026-07-26T12:00:02.000Z",
    });
    assert.equal(retry.status, "acquired");
    assert.equal(retry.attempt, 2);
    await assert.rejects(
      ledger.claim({
        kind: "event",
        stableId: eventId,
        payloadDigest: otherDigest,
        now: "2026-07-26T12:00:03.000Z",
      }),
      /reused with different content/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe configuration and identifiers before filesystem writes", () => {
  assert.throws(
    () =>
      createFileResearchDedupLedger({
        rootDirectory: "relative/path",
        leaseDurationMs: 60_000,
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      createFileResearchDedupLedger({
        rootDirectory: "/tmp/codeops-test",
        leaseDurationMs: 999,
      }),
    /between 1s and 1h/,
  );
});
