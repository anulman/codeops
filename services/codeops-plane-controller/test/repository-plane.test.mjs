import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepositoryPlaneRegistry,
  loadRepositoryPlaneRegistryFile,
} from "../dist/repository-plane.js";

const ids = {
  renoWorkspace: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  codeopsWorkspace: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  renoProject: "11111111-1111-4111-8111-111111111111",
  codeopsProject: "22222222-2222-4222-8222-222222222222",
  ready: "33333333-3333-4333-8333-333333333333",
  progress: "44444444-4444-4444-8444-444444444444",
  attention: "55555555-5555-4555-8555-555555555555",
  complete: "66666666-6666-4666-8666-666666666666",
};

function plane(projectId, prefix) {
  return {
    apiOrigin: "https://plane.example.com",
    workspaceSlug: "engineering",
    workspaceId:
      prefix === "reno" ? ids.renoWorkspace : ids.codeopsWorkspace,
    projectId,
    apiKeyFile: `/var/run/codeops/${prefix}-plane-api-key`,
    webhookSecretFile: `/var/run/codeops/${prefix}-plane-webhook`,
    stateIds: {
      ready: ids.ready,
      inProgress: ids.progress,
      needsAttention: ids.attention,
      complete: ids.complete,
    },
  };
}

const handles = [
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
];

function policy(prefix, offset) {
  return {
    githubReviewerIds: [6723643628 + offset],
    planeHumanActorIds: [`${offset + 7}7777777-7777-4777-8777-777777777777`],
    planePersonas: handles.map((handle, index) => ({
      userId: `${offset + 8}${index}888888-8888-4888-8888-888888888888`,
      handle,
    })),
    projectContextRoot: `/var/run/codeops/context/${prefix}`,
  };
}

test("selects distinct Plane projects and credentials for two repositories", async () => {
  const manifest = {
    version: "codeops.repository-registry/v1",
    repositories: [
      {
        repository: "example-org/example-repository",
        repositoryUrl: "https://github.com/example-org/example-repository.git",
        readTokenFile: "/var/run/codeops/reno-read",
        writeTokenFile: "/var/run/codeops/reno-write",
        githubWebhookSecretFile: "/var/run/codeops/reno-github-webhook",
        githubSteeringTokenFile: "/var/run/codeops/reno-steering",
        plane: plane(ids.renoProject, "reno"),
        policy: policy("reno", 0),
      },
      {
        repository: "anulman/codeops",
        repositoryUrl: "https://github.com/anulman/codeops.git",
        readTokenFile: "/var/run/codeops/codeops-read",
        writeTokenFile: "/var/run/codeops/codeops-write",
        githubWebhookSecretFile: "/var/run/codeops/codeops-github-webhook",
        githubSteeringTokenFile: "/var/run/codeops/codeops-steering",
        plane: plane(ids.codeopsProject, "codeops"),
        policy: policy("codeops", 1),
      },
    ],
  };
  const files = new Map([
    ["/var/run/codeops/repositories.json", JSON.stringify(manifest)],
    ["/var/run/codeops/reno-plane-api-key", "r".repeat(32)],
    ["/var/run/codeops/reno-plane-webhook", "h".repeat(32)],
    ["/var/run/codeops/codeops-plane-api-key", "c".repeat(32)],
    ["/var/run/codeops/codeops-plane-webhook", "w".repeat(32)],
  ]);
  const registry = await loadRepositoryPlaneRegistryFile(
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
  assert.equal(
    registry.resolve("example-org/example-repository").apiKey,
    "r".repeat(32),
  );
  assert.equal(
    registry.resolve("anulman/codeops").webhookSecret,
    "w".repeat(32),
  );
  assert.equal(
    registry.resolveProject(ids.codeopsProject).repository,
    "anulman/codeops",
  );
  assert.equal(
    registry.resolve("example-org/example-repository").workspaceId,
    ids.renoWorkspace,
  );
  assert.equal(
    registry.resolve("anulman/codeops").workspaceId,
    ids.codeopsWorkspace,
  );
  assert.deepEqual(
    registry.resolve("anulman/codeops").policy.githubReviewerIds,
    [6723643629],
  );
  assert.equal(
    registry.resolve("example-org/example-repository").policy.projectContextRoot,
    "/var/run/codeops/context/reno",
  );
  assert.throws(() => registry.resolve("anulman/unknown"), /not admitted/);
  assert.throws(
    () => registry.resolveProject("77777777-7777-4777-8777-777777777777"),
    /not admitted/,
  );
});

test("rejects reused Plane credentials, projects, and incomplete authorities", async () => {
  assert.throws(
    () =>
      createRepositoryPlaneRegistry([
        {
          repository: "example-org/example-repository",
          apiOrigin: "https://plane.example.com",
          workspaceSlug: "engineering",
          workspaceId: ids.renoWorkspace,
          projectId: ids.renoProject,
          apiKey: "a".repeat(32),
          webhookSecret: "h".repeat(32),
          stateIds: plane(ids.renoProject, "reno").stateIds,
          policy: policy("reno", 0),
        },
        {
          repository: "anulman/codeops",
          apiOrigin: "https://plane.example.com",
          workspaceSlug: "engineering",
          workspaceId: ids.codeopsWorkspace,
          projectId: ids.renoProject,
          apiKey: "b".repeat(32),
          webhookSecret: "h".repeat(32),
          stateIds: plane(ids.codeopsProject, "codeops").stateIds,
          policy: policy("codeops", 1),
        },
      ]),
    /repository-scoped/,
  );
  await assert.rejects(
    loadRepositoryPlaneRegistryFile(
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
