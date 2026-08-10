import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubWebhookRegistry,
  loadGitHubWebhookRegistryFile,
} from "../dist/repository-webhooks.js";

test("selects a distinct GitHub webhook secret for each admitted repository", async () => {
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
          },
          {
            repository: "anulman/codeops",
            repositoryUrl: "https://github.com/anulman/codeops.git",
            readTokenFile: "/var/run/codeops/codeops-read",
            writeTokenFile: "/var/run/codeops/codeops-write",
            githubWebhookSecretFile: "/var/run/codeops/codeops-webhook",
          },
        ],
      }),
    ],
    ["/var/run/codeops/renoconcierge-webhook", `${"r".repeat(32)}\n`],
    ["/var/run/codeops/codeops-webhook", `${"c".repeat(32)}\n`],
  ]);
  const registry = await loadGitHubWebhookRegistryFile(
    "/var/run/codeops/repositories.json",
    async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error("unexpected fixture read");
      return value;
    },
  );
  assert.deepEqual(registry.repositories, [
    "anulman/renoconcierge",
    "anulman/codeops",
  ]);
  assert.equal(registry.resolve("anulman/renoconcierge"), "r".repeat(32));
  assert.equal(registry.resolve("anulman/codeops"), "c".repeat(32));
  assert.throws(() => registry.resolve("anulman/unknown"), /not admitted/);
});

test("rejects reused webhook authority and incomplete registry entries", async () => {
  assert.throws(
    () =>
      createGitHubWebhookRegistry([
        { repository: "anulman/renoconcierge", secret: "s".repeat(32) },
        { repository: "anulman/codeops", secret: "s".repeat(32) },
      ]),
    /repository-scoped/,
  );
  await assert.rejects(
    loadGitHubWebhookRegistryFile(
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
