import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubSteeringRegistry,
  loadGitHubSteeringRegistryFile,
} from "../dist/repository-steering.js";

test("selects a distinct GitHub steering token for each admitted repository", async () => {
  const files = new Map([
    [
      "/var/run/codeops/repositories.json",
      JSON.stringify({
        version: "codeops.repository-registry/v1",
        repositories: [
          {
            repository: "example-org/example-repository",
            repositoryUrl: "https://github.com/example-org/example-repository.git",
            readTokenFile: "/var/run/codeops/example-repository-read",
            writeTokenFile: "/var/run/codeops/example-repository-write",
            githubWebhookSecretFile: "/var/run/codeops/example-repository-webhook",
            githubSteeringTokenFile: "/var/run/codeops/example-repository-steering",
          },
          {
            repository: "anulman/codeops",
            repositoryUrl: "https://github.com/anulman/codeops.git",
            readTokenFile: "/var/run/codeops/codeops-read",
            writeTokenFile: "/var/run/codeops/codeops-write",
            githubWebhookSecretFile: "/var/run/codeops/codeops-webhook",
            githubSteeringTokenFile: "/var/run/codeops/codeops-steering",
          },
        ],
      }),
    ],
    ["/var/run/codeops/example-repository-steering", `${"r".repeat(32)}\n`],
    ["/var/run/codeops/codeops-steering", `${"c".repeat(32)}\n`],
  ]);
  const registry = await loadGitHubSteeringRegistryFile(
    "/var/run/codeops/repositories.json",
    async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("unexpected fixture read");
      return value;
    },
  );
  assert.equal(registry.resolve("example-org/example-repository"), "r".repeat(32));
  assert.equal(registry.resolve("anulman/codeops"), "c".repeat(32));
  assert.throws(() => registry.resolve("anulman/unknown"), /not admitted/);
});

test("rejects reused steering authority and incomplete registry entries", async () => {
  assert.throws(
    () =>
      createGitHubSteeringRegistry([
        { repository: "example-org/example-repository", token: "s".repeat(32) },
        { repository: "anulman/codeops", token: "s".repeat(32) },
      ]),
    /repository-scoped/,
  );
  await assert.rejects(
    loadGitHubSteeringRegistryFile(
      "/var/run/codeops/repositories.json",
      async () =>
        JSON.stringify({
          version: "codeops.repository-registry/v1",
          repositories: [
            {
              repository: "anulman/codeops",
              repositoryUrl: "https://github.com/anulman/codeops.git",
              readTokenFile: "/var/run/codeops/codeops-read",
              writeTokenFile: "/var/run/codeops/codeops-write",
            },
          ],
        }),
    ),
  );
});
