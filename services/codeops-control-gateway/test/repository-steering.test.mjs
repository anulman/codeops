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
            repository: "anulman/renoconcierge",
            repositoryUrl: "https://github.com/anulman/renoconcierge.git",
            readTokenFile: "/var/run/codeops/renoconcierge-read",
            writeTokenFile: "/var/run/codeops/renoconcierge-write",
            githubWebhookSecretFile: "/var/run/codeops/renoconcierge-webhook",
            githubSteeringTokenFile: "/var/run/codeops/renoconcierge-steering",
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
    ["/var/run/codeops/renoconcierge-steering", `${"r".repeat(32)}\n`],
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
  assert.equal(registry.resolve("anulman/renoconcierge"), "r".repeat(32));
  assert.equal(registry.resolve("anulman/codeops"), "c".repeat(32));
  assert.throws(() => registry.resolve("anulman/unknown"), /not admitted/);
});

test("rejects reused steering authority and incomplete registry entries", async () => {
  assert.throws(
    () =>
      createGitHubSteeringRegistry([
        { repository: "anulman/renoconcierge", token: "s".repeat(32) },
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
