import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryRegistry,
  dispatchRepositoryIdentity,
  loadRepositoryRegistryFile,
  resolveRepositoryRoute,
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

test("resolves only exact repository-qualified API routes", () => {
  const registry = createRepositoryRegistry(entries);
  const resolved = resolveRepositoryRoute(
    registry,
    "/v1/repositories/anulman/codeops/pull-requests/42/current-head",
  );
  assert.equal(resolved.authority.repository, "anulman/codeops");
  assert.equal(resolved.authority.readToken, "c".repeat(32));
  assert.equal(resolved.path, "/pull-requests/42/current-head");
  assert.equal(
    resolveRepositoryRoute(registry, "/v1/pull-requests/42/current-head"),
    null,
  );
  assert.equal(
    resolveRepositoryRoute(
      registry,
      "/v1/repositories/anulman/codeops/pull-requests/42/current-head?repository=anulman/renoconcierge",
    ),
    null,
  );
  assert.throws(
    () =>
      resolveRepositoryRoute(
        registry,
        "/v1/repositories/anulman/not-admitted/heads/main",
      ),
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

test("loads a strict two-repository manifest through only Secret file references", async () => {
  const files = new Map([
    [
      "/var/run/codeops/repositories.json",
      JSON.stringify({
        version: "codeops.repository-registry/v1",
        repositories: [
          {
            repository: "anulman/renoconcierge",
            repositoryUrl: "https://github.com/anulman/renoconcierge.git",
            readTokenFile: "/var/run/codeops/renoconcierge-read",
            writeTokenFile: "/var/run/codeops/renoconcierge-write",
          },
          {
            repository: "anulman/codeops",
            repositoryUrl: "https://github.com/anulman/codeops.git",
            readTokenFile: "/var/run/codeops/codeops-read",
            writeTokenFile: "/var/run/codeops/codeops-write",
          },
        ],
      }),
    ],
    ["/var/run/codeops/renoconcierge-read", `${"a".repeat(32)}\n`],
    ["/var/run/codeops/renoconcierge-write", `${"b".repeat(32)}\n`],
    ["/var/run/codeops/codeops-read", `${"c".repeat(32)}\n`],
    ["/var/run/codeops/codeops-write", `${"d".repeat(32)}\n`],
  ]);
  const registry = await loadRepositoryRegistryFile(
    "/var/run/codeops/repositories.json",
    async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("missing fixture file");
      return value;
    },
  );
  assert.deepEqual(registry.repositories, [
    "anulman/renoconcierge",
    "anulman/codeops",
  ]);
  assert.equal(registry.resolve("anulman/codeops").readToken, "c".repeat(32));
});

test("rejects inline credentials, ambiguous paths, and shared Secret files", async () => {
  const load = (manifest) =>
    loadRepositoryRegistryFile(
      "/var/run/codeops/repositories.json",
      async (filePath) =>
        filePath === "/var/run/codeops/repositories.json"
          ? JSON.stringify(manifest)
          : "a".repeat(32),
    );
  await assert.rejects(
    load({
      version: "codeops.repository-registry/v1",
      repositories: [
        {
          repository: "anulman/codeops",
          repositoryUrl: "https://github.com/anulman/codeops",
          readToken: "a".repeat(32),
          writeToken: "b".repeat(32),
        },
      ],
    }),
  );
  await assert.rejects(
    load({
      version: "codeops.repository-registry/v1",
      repositories: [
        {
          repository: "anulman/codeops",
          repositoryUrl: "https://github.com/anulman/codeops",
          readTokenFile: "/var/run/codeops/../shared",
          writeTokenFile: "/var/run/codeops/write",
        },
      ],
    }),
    /exact absolute path/,
  );
  await assert.rejects(
    load({
      version: "codeops.repository-registry/v1",
      repositories: [
        {
          repository: "anulman/codeops",
          repositoryUrl: "https://github.com/anulman/codeops",
          readTokenFile: "/var/run/codeops/shared",
          writeTokenFile: "/var/run/codeops/shared",
        },
      ],
    }),
    /repository-scoped/,
  );
});
