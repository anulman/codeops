import assert from "node:assert/strict";
import test from "node:test";
import {
  interactiveSessionModeSchema,
  sessionPolicyForMode,
  sessionPolicySchema,
} from "../dist/session-policy.js";

test("derives the immutable execution policy for each session mode", () => {
  assert.deepEqual(
    ["explore", "plan", "implement", "review", "validate"].map((mode) =>
      sessionPolicyForMode(mode),
    ),
    [
      ["explore", "read-only", "allowed", "openai", "medium"],
      ["plan", "read-only", "allowed", "openai", "high"],
      ["implement", "bounded-writes", "allowed", "openai", "medium"],
      ["review", "read-only", "allowed", "openai", "high"],
      ["validate", "deterministic", "forbidden", "none", null],
    ].map(([mode, workspaceAccess, modelCalls, provider, reasoningEffort]) => ({
      version: "codeops.session-policy/v1",
      mode,
      workspaceAccess,
      modelCalls,
      modelPolicy: {
        provider,
        model: provider === "openai" ? "gpt-5.6-sol" : null,
        reasoningEffort,
      },
    })),
  );
});

test("rejects client-selected policy overrides", () => {
  const policy = sessionPolicyForMode("explore");
  assert.throws(() =>
    sessionPolicySchema.parse({
      ...policy,
      workspaceAccess: "bounded-writes",
    }),
  );
  assert.throws(() =>
    sessionPolicySchema.parse({
      ...policy,
      modelPolicy: { ...policy.modelPolicy, reasoningEffort: "high" },
    }),
  );
});

test("keeps Validate out of interactive workspace launch", () => {
  assert.equal(interactiveSessionModeSchema.parse("review"), "review");
  assert.throws(() => interactiveSessionModeSchema.parse("validate"));
});
