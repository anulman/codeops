import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryRegistry,
  dispatchRepositoryIdentity,
} from "../dist/repository-registry.js";

const entries = [
  {
    repository: "anulman/renoconcierge",
    repositoryUrl: "https://github.com/anulman/renoconcierge.git",
    readToken: "a".repeat(32),
    writeToken: "b".repeat(32),
  },
  {
    repository: "anulman/codeops",
    repositoryUrl: "https://github.com/anulman/codeops.git",
    readToken: "c".repeat(32),
    writeToken: "d".repeat(32),
  },
];

test("resolves two repositories to distinct credentials and rejects unknown identities", () => {
  const registry = createRepositoryRegistry(entries);
  assert.deepEqual(registry.repositories, [
    "anulman/renoconcierge",
    "anulman/codeops",
  ]);
  assert.equal(registry.resolve("anulman/renoconcierge").readToken, "a".repeat(32));
  assert.equal(registry.resolve("anulman/codeops").readToken, "c".repeat(32));
  assert.throws(
    () => registry.resolve("anulman/not-admitted"),
    /not admitted/,
  );
});

test("fails closed on duplicate identity, URL drift, or shared repository authority", () => {
  assert.throws(
    () => createRepositoryRegistry([entries[0], entries[0]]),
    /identities must be unique/,
  );
  assert.throws(
    () =>
      createRepositoryRegistry([
        { ...entries[0], repositoryUrl: entries[1].repositoryUrl },
      ]),
    /URL does not match/,
  );
  assert.throws(
    () =>
      createRepositoryRegistry([
        entries[0],
        { ...entries[1], readToken: entries[0].readToken },
      ]),
    /repository-scoped/,
  );
});

test("derives the exact repository identity from research and coding dispatches", () => {
  assert.equal(
    dispatchRepositoryIdentity({
      role: "qa-contract-researcher",
      researchRequest: { repository: { owner: "anulman", name: "codeops" } },
    }),
    "anulman/codeops",
  );
  assert.equal(
    dispatchRepositoryIdentity({
      role: "coding-agent",
      codingRequest: {
        workItem: { repository: { owner: "anulman", name: "renoconcierge" } },
      },
    }),
    "anulman/renoconcierge",
  );
});
