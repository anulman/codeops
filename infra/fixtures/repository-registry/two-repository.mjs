import path from "node:path";

const handles = [
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
];

const stateIds = {
  ready: "33333333-3333-4333-8333-333333333333",
  inProgress: "44444444-4444-4444-8444-444444444444",
  needsAttention: "55555555-5555-4555-8555-555555555555",
  complete: "66666666-6666-4666-8666-666666666666",
};

function repositoryEntry(root, input) {
  return {
    repository: input.repository,
    repositoryUrl: `https://github.com/${input.repository}.git`,
    readTokenFile: path.join(root, `${input.prefix}-read`),
    writeTokenFile: path.join(root, `${input.prefix}-write`),
    githubWebhookSecretFile: path.join(root, `${input.prefix}-github-webhook`),
    githubSteeringTokenFile: path.join(root, `${input.prefix}-github-steering`),
    plane: {
      apiOrigin: "https://plane.example.com",
      workspaceSlug: "engineering",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      apiKeyFile: path.join(root, `${input.prefix}-plane-api-key`),
      webhookSecretFile: path.join(root, `${input.prefix}-plane-webhook`),
      stateIds,
    },
    policy: {
      githubReviewerIds: [input.githubReviewerId],
      planeHumanActorIds: [input.humanActorId],
      planePersonas: handles.map((handle, index) => ({
        handle,
        userId: `${input.personaPrefix}0000000-${String(index + 1).padStart(4, "0")}-4000-8000-000000000001`,
      })),
      projectContextRoot: path.join(root, "contexts", input.prefix),
    },
  };
}

export function createTwoRepositoryRegistryFixture(root) {
  return {
    version: "codeops.repository-registry/v1",
    repositories: [
      repositoryEntry(root, {
        repository: "example-org/example-repository",
        prefix: "example-repository",
        workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        projectId: "11111111-1111-4111-8111-111111111111",
        githubReviewerId: 6723643628,
        humanActorId: "77777777-7777-4777-8777-777777777770",
        personaPrefix: "8",
      }),
      repositoryEntry(root, {
        repository: "anulman/codeops",
        prefix: "codeops",
        workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        projectId: "22222222-2222-4222-8222-222222222222",
        githubReviewerId: 6723643629,
        humanActorId: "77777777-7777-4777-8777-777777777771",
        personaPrefix: "9",
      }),
    ],
  };
}
