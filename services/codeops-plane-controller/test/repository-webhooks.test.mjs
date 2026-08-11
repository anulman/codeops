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
    ["/var/run/codeops/example-repository-webhook", `${"r".repeat(32)}\n`],
    ["/var/run/codeops/codeops-webhook", `${"c".repeat(32)}\n`],
    ["/var/run/codeops/example-repository-steering", `${"a".repeat(64)}\n`],
    ["/var/run/codeops/codeops-steering", `${"b".repeat(64)}\n`],
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
    "example-org/example-repository",
    "anulman/codeops",
  ]);
  assert.deepEqual(registry.resolve("example-org/example-repository"), {
    webhookSecret: "r".repeat(32),
    steeringToken: "a".repeat(64),
  });
  assert.deepEqual(registry.resolve("anulman/codeops"), {
    webhookSecret: "c".repeat(32),
    steeringToken: "b".repeat(64),
  });
  assert.throws(() => registry.resolve("anulman/unknown"), /not admitted/);
});

test("rejects reused webhook authority and incomplete registry entries", async () => {
  assert.throws(
    () =>
      createGitHubWebhookRegistry([
        {
          repository: "example-org/example-repository",
          webhookSecret: "s".repeat(32),
          steeringToken: "a".repeat(64),
        },
        {
          repository: "anulman/codeops",
          webhookSecret: "s".repeat(32),
          steeringToken: "b".repeat(64),
        },
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
