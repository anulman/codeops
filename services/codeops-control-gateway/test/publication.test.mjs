import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publishCandidateRevision } from "../dist/publication.js";

test("publishes only the exact retained critic-approved patch as a fast-forward branch update", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codeops-publication-test-"));
  const runId = "agent-review-123";
  const patch = Buffer.from(
    "diff --git a/a.txt b/a.txt\nindex 7898192..6178079 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
  );
  const patchDigest = `sha256:${createHash("sha256")
    .update(patch)
    .digest("hex")}`;
  await mkdir(path.join(root, "agent-runs", runId), { recursive: true });
  await writeFile(path.join(root, "agent-runs", runId, "changes.patch"), patch);
  const expectedHeadSha = "a".repeat(40);
  const publishedHeadSha = "b".repeat(40);
  const calls = [];
  let revParseCount = 0;
  try {
    const result = await publishCandidateRevision({
      evidenceRoot: root,
      repositoryWriteToken: "w".repeat(64),
      publication: {
        version: "codeops.candidate-publication/v1",
        workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
        projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
        workItemId: "088a83b9-a53f-4dda-b2bc-c860cf455997",
        workflowId: "review-123",
        repository: { owner: "anulman", name: "renoconcierge" },
        pullRequestNumber: 158,
        expectedHeadSha,
        headRef: "codeops/reviewed",
        humanReview: {
          version: "codeops.human-review-request/v1",
          repository: "anulman/renoconcierge",
          pullRequestNumber: 158,
          reviewId: 9001,
          reviewedHeadSha: expectedHeadSha,
          headRef: "codeops/reviewed",
          baseRef: "main",
          reviewer: { id: 6723643628, login: "anulman" },
          state: "changes_requested",
          submittedAt: "2026-07-30T22:45:00.000Z",
          summary: "Fix it.",
          comments: [],
        },
        candidate: {
          round: 1,
          runId,
          checkpoint: {
            uri: `artifact:///agent-runs/${runId}/checkpoint.json`,
            digest: `sha256:${"c".repeat(64)}`,
            sizeBytes: 100,
          },
          patch: {
            uri: `artifact:///agent-runs/${runId}/changes.patch`,
            digest: patchDigest,
            sizeBytes: patch.length,
          },
          codingOutcome: {
            version: "codeops.coding-outcome/v1",
            summary: "Resolved the review.",
            tests: [
              {
                command: "node --test",
                status: "passed",
                summary: "Focused tests pass.",
              },
            ],
          },
        },
        commitMessage: "fix(codeops): address PR review",
      },
      exec: async (file, args, options) => {
        calls.push({ file, args, options });
        if (args.at(-1) === "HEAD" && args.includes("rev-parse")) {
          revParseCount += 1;
          return {
            stdout:
              revParseCount === 1 ? `${expectedHeadSha}\n` : `${publishedHeadSha}\n`,
            stderr: "",
          };
        }
        if (args.includes("--name-only")) {
          return { stdout: "a.txt\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(result.previousHeadSha, expectedHeadSha);
    assert.equal(result.publishedHeadSha, publishedHeadSha);
    assert.equal(result.patchDigest, patchDigest);
    assert.ok(
      calls.some(({ args }) =>
        args.includes(`HEAD:refs/heads/codeops/reviewed`),
      ),
    );
    assert.ok(
      calls.every(({ args }) => !args.join(" ").includes("w".repeat(64))),
    );
    assert.ok(
      calls.every(
        ({ options }) =>
          options.env.GIT_TERMINAL_PROMPT === "0" &&
          options.env.GIT_CONFIG_KEY_0 ===
            "http.https://github.com/.extraheader",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
