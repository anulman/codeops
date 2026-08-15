import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  projectSessionBudget,
  sessionPolicyForMode,
} from "@codeops/codeops-contracts";
import {
  ExhaustedSessionModelBudgetError,
  MissingSessionModelBudgetError,
  issueSessionModelAuthority,
} from "../dist/session-model-authority.js";

const signingKey = "m".repeat(64);
const issuedAt = new Date("2026-08-15T12:34:56.789Z");
const startedAt = "2026-08-15T12:00:00.000Z";

function snapshot(options = {}) {
  const mode = options.mode ?? "implement";
  const defaultBudget = projectSessionBudget({
    startedAt,
    observedAt: startedAt,
    limits: {
      elapsedSeconds: 21_600,
      totalTokens: 12_345,
      modelRequests: 17,
      activeChildren: 4,
    },
  });
  const budget = Object.hasOwn(options, "budget")
    ? options.budget
    : defaultBudget;
  return {
    sessionId: "ses_model_authority_1",
    generation: 3,
    identity: {
      version: "codeops.session-workspace-identity/v1",
      policy: sessionPolicyForMode(mode),
    },
    ...(budget === undefined ? {} : { budget }),
  };
}

function issue(inputSnapshot) {
  return issueSessionModelAuthority({
    snapshot: inputSnapshot,
    signingKey,
    issuedAt,
  });
}

function payload(token) {
  return JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
  );
}

test("both initialization paths issue byte-identical model authority", () => {
  const initialized = snapshot();
  const runtimeAuthority = issue(initialized);
  const sessionControlAuthority = issue(initialized);

  assert.equal(runtimeAuthority.disposition, "issued");
  assert.equal(sessionControlAuthority.disposition, "issued");
  assert.equal(
    runtimeAuthority.modelProxyToken,
    sessionControlAuthority.modelProxyToken,
  );
  assert.deepEqual(payload(runtimeAuthority.modelProxyToken), {
    aud: "codeops-model-proxy",
    sub: "ses_model_authority_1",
    budgetId: "ses_model_authority_1",
    generation: 3,
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    maximumRequests: 17,
    maximumOutputTokens: 12_345,
    iat: 1_786_797_296,
    exp: 1_786_801_796,
  });
});

test("both initialization entrypoints delegate to the shared issuer", async () => {
  for (const name of ["runtime-main.ts", "session-control-main.ts"]) {
    const source = await readFile(
      new URL(`../src/${name}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /issueSessionModelAuthority\(\{/u);
    assert.doesNotMatch(source, /createModelProxyToken/u);
  }
});

test("disabled model authority omits a token without requiring a budget", () => {
  assert.deepEqual(issue(snapshot({ mode: "validate", budget: undefined })), {
    disposition: "disabled",
  });
});

test("enabled model authority rejects a missing budget", () => {
  assert.throws(
    () => issue(snapshot({ budget: undefined })),
    MissingSessionModelBudgetError,
  );
});

test("enabled model authority rejects exhausted request or token budgets", () => {
  for (const usage of [
    { modelRequests: 17, totalTokens: 0 },
    { modelRequests: 0, totalTokens: 40_000 },
  ]) {
    const budget = projectSessionBudget({
      startedAt,
      observedAt: startedAt,
      limits: {
        elapsedSeconds: 21_600,
        totalTokens: 40_000,
        modelRequests: 17,
        activeChildren: 4,
      },
      ...usage,
    });
    assert.throws(
      () => issue(snapshot({ budget })),
      ExhaustedSessionModelBudgetError,
    );
  }
});
