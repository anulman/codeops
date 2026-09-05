import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  adversarialReviewSchema,
  createProjectContext,
} from "@codeops/codeops-contracts";
import {
  authenticateBearer,
  buildAgentPrompt,
  claimRequest,
  createRunIdentity,
  loadGitHubReviewComments,
  parseCheckpointLogs,
  qualifyGitHubHead,
  readCandidatePatch,
  readRetainedResult,
  resolveGitHubBranchHead,
  resolveGitHubPullRequestHead,
  retainCheckpoint as retainCheckpointBase,
} from "../dist/core.js";
import { assertRunResources, buildRunResources } from "../dist/resources.js";

const modelAuth = {
  mode: "proxy",
  origin: "http://codeops-model-proxy:8080",
  signingKey: "m".repeat(64),
  issuedAt: new Date("2026-08-09T17:00:00.000Z"),
};
const runtimeProfile = {
  version: "codeops.runtime-profile/v1",
  profileId: "standard-v1",
  releaseDigest: `sha256:${"7".repeat(64)}`,
  capabilities: ["acp"],
  capabilityDigest: `sha256:${createHash("sha256").update(JSON.stringify(["acp"])).digest("hex")}`,
  resources: { cpuMillis: 3_000, memoryMiB: 7_168, ephemeralStorageMiB: 5_120 },
  authority: { workspaceAccess: "bounded-writes", publicNetwork: true, brokeredProviderEffects: true },
  compatibilityPolicyRevision: "compatible-substitution-v1",
  images: {
    agent: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
    worker: `ghcr.io/a/worker@sha256:${"e".repeat(64)}`,
    sessionGateway: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
  },
};
const runtimeRequirements = {
  version: "codeops.runtime-requirements/v1",
  capabilities: ["acp"],
  minimumResources: {
    cpuMillis: 600,
    memoryMiB: 1_280,
    ephemeralStorageMiB: 1_280,
  },
  requiredAuthority: runtimeProfile.authority,
  maximumAuthority: runtimeProfile.authority,
  compatibilityPolicyRevision: runtimeProfile.compatibilityPolicyRevision,
};
const runtimeLaunchBinding = {
  version: "codeops.runtime-launch-binding/v1",
  requirementDigest: `sha256:${"6".repeat(64)}`,
  profile: runtimeProfile,
  selectedAt: "2026-08-09T17:00:00.000Z",
};
const retainCheckpoint = (input) => retainCheckpointBase({
  ...input,
  runtimeLaunchBinding,
});

test("replays an Agent Job from its durable runtime binding across a release rollover", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "codeops-runtime-binding-"));
  const identity = createRunIdentity(request);
  try {
    assert.deepEqual(await claimRequest({
      rootDirectory,
      request,
      ...identity,
      runtimeLaunchBinding,
    }), runtimeLaunchBinding);
    const replacement = {
      ...runtimeLaunchBinding,
      profile: {
        ...runtimeLaunchBinding.profile,
        releaseDigest: `sha256:${"9".repeat(64)}`,
        images: {
          agent: `ghcr.io/a/agent@sha256:${"9".repeat(64)}`,
          worker: `ghcr.io/a/worker@sha256:${"9".repeat(64)}`,
          sessionGateway: `ghcr.io/a/gateway@sha256:${"9".repeat(64)}`,
        },
      },
    };
    assert.deepEqual(await claimRequest({
      rootDirectory,
      request,
      ...identity,
      runtimeLaunchBinding: replacement,
    }), runtimeLaunchBinding);
    await assert.rejects(claimRequest({
      rootDirectory,
      request,
      ...identity,
      runtimeLaunchBinding: {
        ...replacement,
        requirementDigest: `sha256:${"5".repeat(64)}`,
      },
    }), /runtime requirement drift/);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

const projectContext = createProjectContext({
  version: "codeops.project-context/v1",
  repository: { owner: "example-org", name: "example-repository" },
  controlPlaneSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  project: {
    workspaceId: "55555555-5555-4555-8555-555555555555",
    projectId: "11111111-1111-4111-8111-111111111111",
    name: "Onboarding Auth QA",
    descriptionHtml: "<p>Deterministic qualification.</p>",
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
  documents: [
    {
      path: "AGENTS.md",
      purpose: "Repository guidance",
      digest:
        "sha256:bce2d710d7649d7175f3dcf1ef4705b5cd16a3ba674788ab17ca03164cb8be85",
      content: "# Repository guidance\n",
    },
  ],
});

test("loads and bounds the exact submitted review's inline comments", async () => {
  const calls = [];
  const comments = await loadGitHubReviewComments({
    repositoryUrl: "https://github.com/example-org/example-repository",
    repositoryReadToken: "r".repeat(32),
    pullRequestNumber: 158,
    reviewId: 9001,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify([
          {
            id: 7001,
            body: "Cover this branch.",
            path: "services/codeops-plane-controller/src/github-events.ts",
            line: 42,
            side: "RIGHT",
            created_at: "2026-07-30T22:45:00.000Z",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.deepEqual(comments, [
    {
      id: 7001,
      body: "Cover this branch.",
      path: "services/codeops-plane-controller/src/github-events.ts",
      line: 42,
      side: "RIGHT",
      createdAt: "2026-07-30T22:45:00.000Z",
    },
  ]);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/example-org/example-repository/pulls/158/reviews/9001/comments?per_page=100&page=1",
  );
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"r".repeat(32)}`);
});

test("qualifies only an approved exact PR head with passing checks and resolved threads", async () => {
  const calls = [];
  const qualified = await qualifyGitHubHead({
    repositoryUrl: "https://github.com/example-org/example-repository",
    repositoryReadToken: "r".repeat(32),
    pullRequestNumber: 155,
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "0".repeat(40),
    requiredCheckNames: ["PR Guardrails", "Release"],
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/check-runs?per_page=100")) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            check_runs: [
              {
                name: "PR Guardrails",
                status: "completed",
                conclusion: "success",
                head_sha: "a".repeat(40),
              },
              {
                name: "Release",
                status: "completed",
                conclusion: "success",
                head_sha: "a".repeat(40),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 155,
                state: "OPEN",
                isDraft: false,
                headRefOid: "a".repeat(40),
                baseRefName: "main",
                baseRefOid: "0".repeat(40),
                reviewDecision: "APPROVED",
                reviewThreads: {
                  nodes: [{ isResolved: true }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.equal(qualified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.github.com/graphql");
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body).variables, {
    owner: "example-org",
    name: "example-repository",
    number: 155,
  });
});

test("rejects approval qualification while any review thread is unresolved", async () => {
  let calls = 0;
  assert.equal(
    await qualifyGitHubHead({
      repositoryUrl: "https://github.com/example-org/example-repository",
      repositoryReadToken: "r".repeat(32),
      pullRequestNumber: 155,
      headSha: "a".repeat(40),
      baseRef: "main",
      baseSha: "0".repeat(40),
      requiredCheckNames: ["PR Guardrails"],
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response(
              JSON.stringify({
                total_count: 1,
                check_runs: [
                  {
                    name: "PR Guardrails",
                    status: "completed",
                    conclusion: "success",
                    head_sha: "a".repeat(40),
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          : new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      number: 155,
                      state: "OPEN",
                      isDraft: false,
                      headRefOid: "a".repeat(40),
                      baseRefName: "main",
                      baseRefOid: "0".repeat(40),
                      reviewDecision: "APPROVED",
                      reviewThreads: {
                        nodes: [{ isResolved: false }],
                        pageInfo: { hasNextPage: false },
                      },
                    },
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
      },
    }),
    false,
  );
});

const request = {
  version: "codeops.agent-job-dispatch/v1",
  workItemId: "22222222-2222-4222-8222-222222222222",
  workflowId: "research-request-1",
  baseSha: "a".repeat(40),
  summary: "Research auth",
  role: "qa-contract-researcher",
  researchStage: { kind: "persona", persona: "@ai-security" },
  researchRequest: {
    version: "codeops.research-request/v3",
    requestId: "research-request-1",
    workspaceId: projectContext.project.workspaceId,
    projectId: "11111111-1111-4111-8111-111111111111",
    workItemId: "22222222-2222-4222-8222-222222222222",
    triggerCommentId: "33333333-3333-4333-8333-333333333333",
    requestedBy: "44444444-4444-4444-8444-444444444444",
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    projectContext,
    ticketSnapshot: {
      workItemId: "22222222-2222-4222-8222-222222222222",
      name: "Research auth",
      descriptionHtml: "<p>Define auth contracts.</p>",
      priority: "high",
      stateId: "66666666-6666-4666-8666-666666666666",
      labelIds: [],
      assigneeIds: [],
      moduleId: null,
      parentId: null,
      updatedAt: "2026-07-26T00:00:00.000Z",
      relevantComments: [],
      relations: [],
    },
    personas: ["@ai-security"],
    brief: "Inspect auth",
    requestedAt: "2026-07-26T00:00:00.000Z",
  },
};

const codingWorkItemId = "22222222-2222-4222-8222-222222222222";
const codingRequest = {
  version: "codeops.coding-request/v2",
  requestId: "coding-request-1",
  eventId: "ready-event:1",
  workspaceId: projectContext.project.workspaceId,
  projectId: projectContext.project.projectId,
  projectContext,
  requestedBy: "44444444-4444-4444-8444-444444444444",
  controlPlaneSha: projectContext.controlPlaneSha,
  planeRevisionDigest: `sha256:${"b".repeat(64)}`,
  ticketSnapshot: {
    workItemId: codingWorkItemId,
    name: "Build routing fixtures",
    descriptionHtml: "<p>Build every reachable routing cell.</p>",
    priority: "high",
    stateId: "66666666-6666-4666-8666-666666666666",
    labelIds: [],
    assigneeIds: [],
    moduleId: null,
    parentId: null,
    updatedAt: "2026-07-26T00:00:00.000Z",
    relevantComments: [],
    relations: [],
    projectTasks: [
      {
        workItemId: "77777777-7777-4777-8777-777777777777",
        name: "Approved routing table",
        descriptionHtml: "<p>Unauthenticated identified files stay on landing.</p>",
        descriptionDigest: `sha256:${"c".repeat(64)}`,
        priority: "high",
        stateId: "88888888-8888-4888-8888-888888888888",
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  },
  researchDisposition: {
    mode: "skipped",
    rationale: "The bounded ticket does not require standalone research.",
  },
  workItem: {
    version: "codeops.work-item/v1",
    workItemId: codingWorkItemId,
    workflowId: "coding-request-1",
    runId: "coding-request-1",
    repository: { owner: "example-org", name: "example-repository" },
    baseSha: projectContext.baseSha,
    branch: "codeops/routing-fixtures",
    summary: "Build routing fixtures",
    acceptanceCriteria: ["Every reachable cell is deterministic."],
    secretReferences: [],
    requestedAt: "2026-07-26T00:00:00.000Z",
  },
};

const codingDispatch = {
  version: "codeops.agent-job-dispatch/v1",
  workItemId: codingWorkItemId,
  workflowId: codingRequest.requestId,
  baseSha: projectContext.baseSha,
  summary: codingRequest.workItem.summary,
  role: "coding-agent",
  codingRequest,
};

test("resolves only the exact GitHub main ref through the read-only boundary", async () => {
  const calls = [];
  const sha = "c".repeat(40);
  assert.equal(
    await resolveGitHubBranchHead({
      repositoryUrl: "https://github.com/example-org/example-repository",
      repositoryReadToken: "r".repeat(32),
      branch: "main",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            ref: "refs/heads/main",
            object: { type: "commit", sha },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    }),
    sha,
  );
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/example-org/example-repository/git/ref/heads/main",
  );
  assert.equal(
    calls[0].init.headers.Authorization,
    `Bearer ${"r".repeat(32)}`,
  );
  for (const repositoryUrl of [
    "http://github.com/example-org/example-repository",
    "https://evil.example/example-org/example-repository",
    "https://user@github.com/example-org/example-repository",
    "https://github.com/example-org/example-repository?ref=main",
  ]) {
    await assert.rejects(
      resolveGitHubBranchHead({
        repositoryUrl,
        repositoryReadToken: "r".repeat(32),
        branch: "main",
      }),
      /exact GitHub HTTPS repository/,
    );
  }
  await assert.rejects(
    resolveGitHubBranchHead({
      repositoryUrl: "https://github.com/example-org/example-repository",
      repositoryReadToken: "short",
      branch: "main",
    }),
    /token is invalid/,
  );
});

test("resolves one exact current pull-request head through the read-only boundary", async () => {
  const calls = [];
  const headSha = "d".repeat(40);
  const baseSha = "b".repeat(40);
  const result = await resolveGitHubPullRequestHead({
    repositoryUrl: "https://github.com/example-org/example-repository",
    repositoryReadToken: "r".repeat(32),
    pullRequestNumber: 159,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        number: 159,
        state: "open",
        head: { sha: headSha, ref: "feat/agents-ui" },
        base: { sha: baseSha, ref: "feat/codeops-contracts-ci" },
      });
    },
  });
  assert.deepEqual(result, {
    repository: "example-org/example-repository",
    number: 159,
    state: "open",
    headSha,
    headRef: "feat/agents-ui",
    baseRef: "feat/codeops-contracts-ci",
    baseSha,
  });
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/example-org/example-repository/pulls/159",
  );
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${"r".repeat(32)}`);

  await assert.rejects(
    resolveGitHubPullRequestHead({
      repositoryUrl: "https://github.com/example-org/example-repository",
      repositoryReadToken: "r".repeat(32),
      pullRequestNumber: 159,
      fetch: async () => Response.json({
        number: 160,
        state: "open",
        head: { sha: headSha, ref: "feat/agents-ui" },
        base: { sha: baseSha, ref: "feat/codeops-contracts-ci" },
      }),
    }),
  );
});

function checkpointLogs(runId, overrides = {}) {
  const report = {
    version: "codeops.research-persona-report/v2",
    requestId: "research-request-1",
    persona: "@ai-security",
    outcome: "findings",
    summary: "Authentication boundaries need qualification.",
    findings: [],
    decisions: [],
    citations: [],
  };
  const checkpoint = {
    schemaVersion: 3,
    runId,
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
    projectContextDigest: projectContext.digest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    response: JSON.stringify(report),
    events: [],
    patch: {
      path: "changes.patch",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bytes: 0,
    },
    ...overrides,
  };
  return [
    JSON.stringify({
      type: "codeops.patch-chunk",
      runId,
      sequence: 1,
      total: 1,
      patchDigest: `sha256:${checkpoint.patch.sha256}`,
      dataBase64: "",
    }),
    JSON.stringify({
      type: "codeops.checkpoint",
      checkpointDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(checkpoint))
        .digest("hex")}`,
      checkpoint,
    }),
  ].join("\n");
}

function agentLogs({ dispatch, runId, response, patch }) {
  const sha256 = createHash("sha256").update(patch).digest("hex");
  const checkpoint = {
    schemaVersion: 3,
    runId,
    agentRole: dispatch.role,
    baseSha: dispatch.baseSha,
    projectContextDigest: dispatch.codingRequest.projectContext.digest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    response: JSON.stringify(response),
    events: [],
    patch: {
      path: "changes.patch",
      sha256,
      bytes: patch.length,
    },
  };
  return [
    JSON.stringify({
      type: "codeops.patch-chunk",
      runId,
      sequence: 1,
      total: 1,
      patchDigest: `sha256:${sha256}`,
      dataBase64: patch.toString("base64"),
    }),
    JSON.stringify({
      type: "codeops.checkpoint",
      checkpointDigest: `sha256:${createHash("sha256")
        .update(JSON.stringify(checkpoint))
        .digest("hex")}`,
      checkpoint,
    }),
  ].join("\n");
}

test("authenticates one exact bearer token", () => {
  const token = "t".repeat(64);
  assert.equal(authenticateBearer(`Bearer ${token}`, token), true);
  assert.equal(authenticateBearer(`Bearer ${"x".repeat(64)}`, token), false);
  assert.equal(authenticateBearer(undefined, token), false);
});

test("derives a stable bounded run identity", () => {
  assert.deepEqual(createRunIdentity(request), createRunIdentity(request));
  assert.match(createRunIdentity(request).runId, /^agent-[0-9a-f]{24}$/);
  assert.notDeepEqual(
    createRunIdentity(request),
    createRunIdentity({ ...request, summary: "different" }),
  );
});

test("states persona report cardinality and optional-field contracts explicitly", () => {
  const prompt = buildAgentPrompt(request);
  assert.match(prompt, /no more than 20 findings, 5 decisions, and 40 citations/);
  assert.match(prompt, /Omit citation\.testName when the citation is not a test/);
  assert.match(prompt, /never emit an empty string for an optional field/);
});

test("delivers immutable ticket and sibling decision context to coding jobs", () => {
  const prompt = buildAgentPrompt(codingDispatch);
  assert.match(prompt, /Read \/context\/coding-request\.json/);
  assert.match(prompt, /\/context\/project-documents\/SOUL\.md/);
  assert.match(prompt, /bounded same-project task index/);
  assert.match(prompt, /small, understandable commits/);
  assert.match(prompt, /Pause at normal proof boundaries/);
  assert.match(prompt, /local or cluster resources/);
  assert.match(prompt, /one coherent, reviewable increment/);
  assert.match(prompt, /Tautological tests are considered harmful/);
  assert.match(prompt, /simplest architecture and the least code/);
  const resources = buildRunResources(
    {
      namespace: "codeops-trial",
      ...createRunIdentity(codingDispatch),
      repositoryUrl: "https://github.com/example-org/example-repository",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeProfile,
      runtimeRequirements,
      repositoryReadToken: "repo-token",
      modelAuth,
    },
    codingDispatch,
  );
  assert.doesNotThrow(() => assertRunResources(resources));
  const job = resources.find((resource) => resource.kind === "Job");
  const sessionGateway = job.spec.template.spec.containers.find(
    ({ name }) => name === "session-gateway",
  );
  const codingAgent = job.spec.template.spec.containers.find(
    ({ name }) => name === "coding-agent",
  );
  assert.deepEqual(sessionGateway.resources, {
    requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "256Mi" },
    limits: { cpu: "1000m", memory: "1024Mi", "ephemeral-storage": "1024Mi" },
  });
  assert.deepEqual(codingAgent.resources, {
    requests: { cpu: "500m", memory: "1024Mi", "ephemeral-storage": "1024Mi" },
    limits: { cpu: "2000m", memory: "6144Mi", "ephemeral-storage": "4096Mi" },
  });
  assert.equal(
    job.spec.template.spec.volumes.find((volume) => volume.name === "temp")
      .emptyDir.sizeLimit,
    "2Gi",
  );
  const runSecret = resources[0];
  assert.deepEqual(
    JSON.parse(
      Buffer.from(runSecret.data["coding-request"], "base64").toString("utf8"),
    ),
    codingRequest,
  );
  const workspaceBuilder = resources[2].spec.template.spec.initContainers[0];
  assert.equal(
    workspaceBuilder.env.find(
      (entry) => entry.name === "CODEOPS_CODING_REQUEST_FILE",
    ).value,
    "/input/coding-request.json",
  );
  assert.ok(
    resources[2].spec.template.spec.volumes
      .find((volume) => volume.name === "run-input")
      .secret.items.some((item) => item.path === "coding-request.json"),
  );
});

test("rejects an Agent Job profile that cannot supply its runtime requirements", () => {
  assert.throws(() => buildRunResources(
    {
      namespace: "codeops-trial",
      ...createRunIdentity(codingDispatch),
      repositoryUrl: "https://github.com/example-org/example-repository",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      runtimeProfile: {
        ...runtimeProfile,
        resources: { ...runtimeProfile.resources, memoryMiB: 1_279 },
      },
      runtimeRequirements,
      repositoryReadToken: "repo-token",
      modelAuth,
    },
    codingDispatch,
  ), /does not supply runtime requirements/);
});

test("does not fail open for a lower-authority compatible Agent Job profile", () => {
  const input = {
    namespace: "codeops-trial",
    ...createRunIdentity(codingDispatch),
    repositoryUrl: "https://github.com/example-org/example-repository",
    agentImage: runtimeProfile.images.agent,
    runtimeRequirements,
    repositoryReadToken: "repo-token",
    modelAuth,
  };
  const readOnlyProfile = structuredClone(runtimeProfile);
  readOnlyProfile.authority.workspaceAccess = "read-only";
  const readOnlyRequirements = structuredClone(runtimeRequirements);
  readOnlyRequirements.requiredAuthority.workspaceAccess = "read-only";
  const readOnlyJob = buildRunResources({
    ...input,
    runtimeProfile: readOnlyProfile,
    runtimeRequirements: readOnlyRequirements,
  }, codingDispatch).find((resource) => resource.kind === "Job");
  for (const container of readOnlyJob.spec.template.spec.containers) {
    assert.equal(
      container.volumeMounts.find(({ mountPath }) => mountPath === "/workspace")
        ?.readOnly,
      true,
    );
  }

  for (const [authority, message] of [
    ["publicNetwork", /does not authorize Agent Job public network/],
    ["brokeredProviderEffects", /does not authorize Agent Job provider effects/],
  ]) {
    const reducedProfile = structuredClone(runtimeProfile);
    reducedProfile.authority[authority] = false;
    assert.throws(
      () => buildRunResources({ ...input, runtimeProfile: reducedProfile }, codingDispatch),
      message,
    );
  }
});

test("binds workspace-builder ephemeral storage to the selected profile", () => {
  const boundedRequirements = structuredClone(runtimeRequirements);
  boundedRequirements.minimumResources.ephemeralStorageMiB = 1_537;
  const boundedProfile = structuredClone(runtimeProfile);
  boundedProfile.resources.ephemeralStorageMiB = 5_377;
  const resources = buildRunResources({
    namespace: "codeops-trial",
    ...createRunIdentity(codingDispatch),
    repositoryUrl: "https://github.com/example-org/example-repository",
    agentImage: boundedProfile.images.agent,
    runtimeProfile: boundedProfile,
    runtimeRequirements: boundedRequirements,
    repositoryReadToken: "repo-token",
    modelAuth,
  }, codingDispatch);
  const builder = resources.find((resource) => resource.kind === "Job")
    .spec.template.spec.initContainers.find(({ name }) => name === "workspace-builder");
  assert.deepEqual(builder.resources, {
    requests: { cpu: "100m", memory: "128Mi", "ephemeral-storage": "1537Mi" },
    limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "5377Mi" },
  });
});

test("rejects sidecar subtraction that would invert Agent Job requests and limits", () => {
  const requirements = structuredClone(runtimeRequirements);
  requirements.minimumResources = {
    cpuMillis: 1200,
    memoryMiB: 1800,
    ephemeralStorageMiB: 1800,
  };
  const profile = structuredClone(runtimeProfile);
  profile.resources = { ...requirements.minimumResources };
  const input = {
    namespace: "codeops-trial",
    ...createRunIdentity(codingDispatch),
    repositoryUrl: "https://github.com/example-org/example-repository",
    agentImage: profile.images.agent,
    runtimeProfile: profile,
    runtimeRequirements: requirements,
    repositoryReadToken: "repo-token",
    modelAuth,
  };
  assert.throws(() => buildRunResources(input, codingDispatch), /resource-bound-unsatisfied/);
  profile.resources = { cpuMillis: 2100, memoryMiB: 2568, ephemeralStorageMiB: 2568 };
  const job = buildRunResources({ ...input, runtimeProfile: profile }, codingDispatch)
    .find(({ kind }) => kind === "Job");
  const agent = job.spec.template.spec.containers.find(({ name }) => name === "coding-agent");
  assert.deepEqual(agent.resources.requests, agent.resources.limits);
});

test("critic prompt keeps an empty fast-follow pass inside the strict review schema", () => {
  const runId = "agent-critic-prompt-fixture";
  const critic = {
    ...codingDispatch,
    role: "critic-agent",
    codingRound: 1,
    candidate: {
      round: 1,
      runId,
      checkpoint: {
        uri: `artifact:///agent-runs/${runId}/checkpoint.json`,
        digest: `sha256:${"c".repeat(64)}`,
        sizeBytes: 1,
      },
      patch: {
        uri: `artifact:///agent-runs/${runId}/changes.patch`,
        digest: `sha256:${"d".repeat(64)}`,
        sizeBytes: 0,
      },
      codingOutcome: {
        version: "codeops.coding-outcome/v1",
        summary: "Implemented the bounded fixture.",
        tests: [{
          command: "node --test test/routing.test.mjs",
          status: "passed",
          summary: "Focused routing behavior is green.",
        }],
      },
    },
  };
  critic.summary = "Review the latest correction round";
  critic.codingRequest = structuredClone(critic.codingRequest);
  critic.codingRequest.workItem.summary = "Restore Astra service, then resume the approved backlog";
  critic.codingRequest.workItem.acceptanceCriteria = [
    "Tests have no production authority",
    "No custom attestation platform",
  ];
  const promptLines = buildAgentPrompt(critic).split("\n");
  assert.ok(promptLines.includes(`Task: ${critic.summary}`));
  assert.ok(promptLines.includes(`Original task: ${critic.codingRequest.workItem.summary}`));
  assert.ok(promptLines.includes(
    `Acceptance criteria: ${JSON.stringify(critic.codingRequest.workItem.acceptanceCriteria)}`,
  ));
  const scopeIndex = promptLines.findIndex((line) => line.startsWith("Before correctness findings,"));
  const lensesIndex = promptLines.findIndex((line) => line.startsWith("Review every lens independently:"));
  assert.ok(scopeIndex >= 0 && scopeIndex < lensesIndex);
  assert.match(promptLines[scopeIndex], /original user outcome.*mandatory safety invariants.*explicit non-goals/);
  assert.ok(promptLines.some((line) => line.includes("Is this mechanism necessary and proportionate; is there a simpler existing alternative?")));
  assert.ok(promptLines.some((line) => line.includes("Removing unnecessary machinery is a valid remedy; never weaken mandatory isolation.")));
  assert.ok(promptLines.some((line) => line.startsWith("Prior corrections do not redefine the original need.")));
  assert.ok(promptLines.some((line) => line.includes("Reviewers are advisory: the supervisor adjudicates simplify, retire, or justify")));

  assert.ok(promptLines.includes(
    "Tautological tests are considered harmful. Tests must exercise observable behavior independently of the implementation under test.",
  ));
  assert.ok(promptLines.includes(
    "Prefer the simplest architecture and the least code that satisfy the ticket and its acceptance criteria without sacrificing correctness, security, or maintainability.",
  ));
  assert.ok(promptLines.includes(
    "Suggest concrete validation mechanisms that the coding agent should use before handoff. Prefer independent, observable checks that can falsify the implementation, and include exact commands when the repository supports them.",
  ));
  assert.ok(promptLines.includes(
    "Report only the most meaningful issues that will cause problems in production. Do not report speculative, cosmetic, or low-impact concerns that fail this primary test.",
  ));
  assert.ok(promptLines.includes(
    "When a simpler architecture can mitigate a production bug, recommend that simpler architecture instead of additional complexity.",
  ));
  assert.deepEqual(
    promptLines.filter((line) => line.includes("planeMutationAuthorized")),
    [
      "For each fastFollowRecommendations item, set planeMutationAuthorized to false. The field belongs inside each recommendation item only.",
      "Never emit planeMutationAuthorized at the review root, including when fastFollowRecommendations is empty.",
    ],
  );

  const shapeInstruction = promptLines.indexOf(
    "Return only one JSON object, without Markdown fences, matching this shape:",
  );
  assert.notEqual(shapeInstruction, -1);
  const terminalReview = JSON.parse(promptLines[shapeInstruction + 1]);
  assert.deepEqual(terminalReview.fastFollowRecommendations, []);
  assert.equal(Object.hasOwn(terminalReview, "planeMutationAuthorized"), false);
  assert.deepEqual(adversarialReviewSchema.parse(terminalReview), terminalReview);
});

test("binds adopted pull-request Agent tokens to their durable session budget", () => {
  const adopted = structuredClone(codingDispatch);
  adopted.codingRound = 1;
  adopted.codingRequest.adoptedPullRequest = {
    version: "codeops.adopted-pull-request/v1",
    repository: "example-org/example-repository",
    pullRequestNumber: 158,
    headSha: projectContext.baseSha,
    headRef: "feat/existing-pr",
    baseSha: "0".repeat(40),
    baseRef: "main",
    title: "Review the exact existing PR",
    url: "https://github.com/example-org/example-repository/pull/158",
    adoptedAt: "2026-08-18T07:00:00.000Z",
    sessionOwnerPrincipalId: "access:aidan@example.com",
    rationale: "Run the exact PR head through the critic loop.",
  };
  const identity = createRunIdentity(adopted);
  const resources = buildRunResources({
    namespace: "codeops-trial",
    ...identity,
    repositoryUrl: "https://github.com/example-org/example-repository",
    agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
    sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
    runtimeProfile,
    runtimeRequirements,
    repositoryReadToken: "repo-token",
    modelAuth,
  }, adopted);
  const token = Buffer.from(
    resources[0].data["model-proxy-token"],
    "base64",
  ).toString("utf8");
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.match(payload.budgetId, /^ses_[0-9a-f]{24}$/);
  assert.equal(payload.generation, 1);
  assert.equal(payload.sub, payload.budgetId);
  assert.notEqual(payload.sub, identity.runId);
});

test("retains passing coding evidence and mounts the exact cumulative patch for an isolated critic", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "codeops-critic-"));
  const initial = { ...codingDispatch, codingRound: 1 };
  const initialIdentity = createRunIdentity(initial);
  const patch = Buffer.from(
    "diff --git a/example.txt b/example.txt\nnew file mode 100644\n--- /dev/null\n+++ b/example.txt\n@@ -0,0 +1 @@\n+bounded\n",
  );
  const codingOutcome = {
    version: "codeops.coding-outcome/v1",
    summary: "Implemented the bounded fixture.",
    tests: [{
      command: "node --test test/routing.test.mjs",
      status: "passed",
      summary: "Focused routing behavior is green.",
    }],
  };
  try {
    const retainedCoding = parseCheckpointLogs({
      logs: agentLogs({
        dispatch: initial,
        runId: initialIdentity.runId,
        response: codingOutcome,
        patch,
      }),
      request: initial,
      runId: initialIdentity.runId,
    });
    const codingResult = await retainCheckpoint({
      rootDirectory,
      request: initial,
      ...initialIdentity,
      retained: retainedCoding,
    });
    assert.deepEqual(codingResult.codingOutcome, codingOutcome);
    const candidate = {
      round: 1,
      runId: codingResult.runId,
      checkpoint: {
        uri: codingResult.checkpointUri,
        digest: codingResult.checkpointDigest,
        sizeBytes: codingResult.checkpointSizeBytes,
      },
      patch: {
        uri: codingResult.patchUri,
        digest: codingResult.patchDigest,
        sizeBytes: codingResult.patchSizeBytes,
      },
      codingOutcome,
    };
    const critic = {
      version: "codeops.agent-job-dispatch/v1",
      workItemId: codingWorkItemId,
      workflowId: codingRequest.requestId,
      baseSha: projectContext.baseSha,
      summary: codingRequest.workItem.summary,
      role: "critic-agent",
      codingRequest,
      codingRound: 1,
      candidate,
    };
    const source = await readCandidatePatch({
      rootDirectory,
      request: critic,
    });
    assert.equal(source.patch.equals(patch), true);
    assert.match(buildAgentPrompt(critic), /seven|every lens independently/);

    const criticIdentity = createRunIdentity(critic);
    const resources = buildRunResources(
      {
        namespace: "codeops-trial",
        ...criticIdentity,
        repositoryUrl: "https://github.com/example-org/example-repository",
        agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
        sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
        runtimeProfile,
        runtimeRequirements,
        repositoryReadToken: "repo-token",
        modelAuth,
        candidate,
      },
      critic,
    );
    assert.doesNotThrow(() => assertRunResources(resources));
    const pod = resources[2].spec.template.spec;
    const candidateVolume = pod.volumes.find(
      (volume) => volume.name === "candidate",
    );
    assert.deepEqual(candidateVolume.persistentVolumeClaim, {
      claimName: "codeops-control-gateway-evidence",
      readOnly: true,
    });
    assert.deepEqual(pod.affinity, {
      podAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: {
              matchLabels: {
                "app.kubernetes.io/name": "codeops-control-gateway",
              },
            },
            topologyKey: "kubernetes.io/hostname",
          },
        ],
      },
    });
    const candidateMount = pod.initContainers[0].volumeMounts.find(
      (mount) => mount.name === "candidate",
    );
    assert.equal(
      candidateMount.subPath,
      `agent-runs/${candidate.runId}/changes.patch`,
    );
    const workspaceBuilder = pod.initContainers[0].command.at(-1);
    assert.match(
      workspaceBuilder,
      /apply --allow-empty --check \/candidate\/changes\.patch/,
    );
    assert.match(
      workspaceBuilder,
      /apply --allow-empty \/candidate\/changes\.patch/,
    );
    assert.equal(
      pod.containers.some((container) =>
        container.volumeMounts.some((mount) => mount.name === "candidate"),
      ),
      false,
    );
    const withoutAffinity = structuredClone(resources);
    delete withoutAffinity[2].spec.template.spec.affinity;
    assert.throws(
      () => assertRunResources(withoutAffinity),
      /candidate evidence claim boundary drifted/,
    );

    const review = {
      version: "codeops.adversarial-review/v1",
      workflowId: critic.workflowId,
      workItemId: critic.workItemId,
      baseSha: critic.baseSha,
      reviewerId: "critic-agent",
      reviewedAt: "2026-07-29T20:00:00.000Z",
      candidate,
      lenses: {
        ticketCompletion: { status: "clear", summary: "Ticket complete." },
        unusedCode: { status: "clear", summary: "No unused code." },
        simplicityMaintainability: {
          status: "clear",
          summary: "Implementation is simple.",
        },
        existingSystems: {
          status: "clear",
          summary: "Existing systems are reused.",
        },
        testEffectiveness: {
          status: "clear",
          summary: "Tests are effective.",
        },
        userFacingBehavior: {
          status: "clear",
          summary: "No user-facing regression.",
        },
        securityPrivacy: {
          status: "clear",
          summary: "No security or privacy regression.",
        },
      },
      findings: [],
      verificationTests: [{
        command: "node --test test/routing.test.mjs",
        status: "passed",
        summary: "The critic independently reproduced the focused pass.",
      }],
      fastFollowRecommendations: [{
        id: "follow-up-1",
        area: "testing",
        priority: "low",
        reason: "follow-on-improvement",
        title: "Add nightly fuzz coverage",
        rationale: "Useful adjacent hardening, but not required by this ticket.",
        planeMutationAuthorized: false,
      }],
      verdict: "pass",
      summary: "Ready for human review.",
    };
    const retainedCritic = parseCheckpointLogs({
      logs: agentLogs({
        dispatch: critic,
        runId: criticIdentity.runId,
        response: review,
        patch,
      }),
      request: critic,
      runId: criticIdentity.runId,
    });
    const criticResult = await retainCheckpoint({
      rootDirectory,
      request: critic,
      ...criticIdentity,
      retained: retainedCritic,
    });
    assert.deepEqual(criticResult.criticReview, review);
    assert.throws(
      () =>
        parseCheckpointLogs({
          logs: agentLogs({
            dispatch: critic,
            runId: criticIdentity.runId,
            response: review,
            patch: Buffer.from(`${patch.toString()}+unauthorized\n`),
          }),
          request: critic,
          runId: criticIdentity.runId,
        }),
      /changed the cumulative candidate patch/,
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("runs a distinct ticket-specific synthesis checkpoint after persona research", async () => {
  const personaReport = {
    version: "codeops.research-persona-report/v2",
    requestId: request.researchRequest.requestId,
    persona: "@ai-security",
    outcome: "findings",
    summary: "One auth gap.",
    findings: [],
    decisions: [],
    citations: [],
  };
  const synthesisRequest = {
    ...request,
    researchStage: { kind: "synthesis", reports: [personaReport] },
  };
  for (const planningPrompt of [
    buildAgentPrompt(request),
    buildAgentPrompt(synthesisRequest),
  ]) {
    assert.match(planningPrompt, /Tautological tests are considered harmful/);
    assert.match(planningPrompt, /simplest architecture and the least code/);
    assert.match(planningPrompt, /Suggest concrete validation mechanisms/);
  }
  assert.match(buildAgentPrompt(synthesisRequest), /no more than five ranked findings/);
  assert.match(
    buildAgentPrompt(synthesisRequest),
    /Use at most 8 citationIds on any finding, decision, follow-up task, or matrix row/,
  );
  assert.match(
    buildAgentPrompt(synthesisRequest),
    /no more than 20 downstream findings, 5 follow-up tasks, 50 matrix rows, and 80 citations/,
  );
  assert.match(
    buildAgentPrompt(synthesisRequest),
    /category must be exactly one of: matrix-fact, product-decision, downstream-defect/,
  );
  assert.match(
    buildAgentPrompt(synthesisRequest),
    /followUpTasks\.area = security, database, web, infrastructure, product, or other/,
  );
  assert.match(
    buildAgentPrompt(synthesisRequest),
    /matrix row status = verified, gap, or decision-required/,
  );
  assert.match(buildAgentPrompt(synthesisRequest), /route\/state\/credential matrix/);
  const synthesis = {
    version: "codeops.research-synthesis/v1",
    requestId: request.researchRequest.requestId,
    verdict: "ready-to-refine",
    summary: "The ticket can be refined.",
    topFindings: [],
    decisions: [],
    downstreamFindings: [],
    followUpTasks: [],
    matrix: {
      version: "codeops.route-state-credential-matrix/v1",
      rows: [
        {
          id: "matrix-1",
          lifecycleState: "qualified",
          credentialState: "valid",
          routeOrRpc: "/claim",
          currentOracle: "Observed",
          expectedOracle: "Expected",
          allowedSideEffects: "None",
          status: "verified",
          citationIds: ["citation-1"],
        },
      ],
    },
    citations: [
      {
        id: "citation-1",
        path: "services/auth.ts",
        lineStart: 1,
        claim: "Fixture citation.",
      },
    ],
  };
  const identity = createRunIdentity(synthesisRequest);
  const retained = parseCheckpointLogs({
    logs: checkpointLogs(identity.runId, {
      response: JSON.stringify(synthesis),
    }),
    request: synthesisRequest,
    runId: identity.runId,
  });
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "codeops-synthesis-"));
  try {
    const result = await retainCheckpoint({
      rootDirectory,
      request: synthesisRequest,
      ...identity,
      retained,
    });
    assert.equal(result.researchResult.kind, "synthesis");
    assert.equal(result.researchResult.synthesis.verdict, "ready-to-refine");
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("accepts progress prose only before one terminal research JSON object", async () => {
  const report = {
    version: "codeops.research-persona-report/v2",
    requestId: request.researchRequest.requestId,
    persona: "@ai-security",
    outcome: "findings",
    summary: "Authentication boundaries need qualification.",
    findings: [],
    decisions: [],
    citations: [],
  };
  const identity = createRunIdentity(request);
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "codeops-terminal-json-"));
  try {
    const retained = parseCheckpointLogs({
      logs: checkpointLogs(identity.runId, {
        response: `Inspecting the exact source now.\n${JSON.stringify(report)}`,
      }),
      request,
      runId: identity.runId,
    });
    const result = await retainCheckpoint({
      rootDirectory,
      request,
      ...identity,
      retained,
    });
    assert.equal(result.researchResult.report.persona, "@ai-security");

    await rm(rootDirectory, { recursive: true, force: true });
    const invalid = parseCheckpointLogs({
      logs: checkpointLogs(identity.runId, {
        response: `${JSON.stringify(report)}\ntrailing prose`,
      }),
      request,
      runId: identity.runId,
    });
    await assert.rejects(
      retainCheckpoint({
        rootDirectory,
        request,
        ...identity,
        retained: invalid,
      }),
      /must end with exactly one complete JSON object/,
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("accepts complete research responses beyond the legacy 20k checkpoint cap", async () => {
  const citation = {
    id: "citation-1",
    path: "sites/app/lib/auth/fileIdentity.server.ts",
    lineStart: 1,
    lineEnd: 2,
    claim: "The cited boundary requires executable negative evidence.",
  };
  const report = {
    version: "codeops.research-persona-report/v2",
    requestId: request.researchRequest.requestId,
    persona: "@ai-security",
    outcome: "findings",
    summary: "Authentication boundaries need qualification.",
    findings: Array.from({ length: 6 }, (_, index) => ({
      id: `finding-${index + 1}`,
      category: "downstream-defect",
      severity: "high",
      confidence: "high",
      currentBehavior: `${index}: ${"observed ".repeat(375)}`,
      expectedBehavior: "The boundary must fail closed under executable tests.",
      citationIds: [citation.id],
    })),
    decisions: [],
    citations: [citation],
  };
  const response = `Inspecting the exact source now.\n${JSON.stringify(report)}`;
  assert.ok(response.length > 20_100);
  const identity = createRunIdentity(request);
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "codeops-long-report-"));
  try {
    const retained = parseCheckpointLogs({
      logs: checkpointLogs(identity.runId, { response }),
      request,
      runId: identity.runId,
    });
    const result = await retainCheckpoint({
      rootDirectory,
      request,
      ...identity,
      retained,
    });
    assert.equal(result.researchResult.report.findings.length, 6);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("validates checkpoint identity, digest, patch, and research immutability", () => {
  const runId = createRunIdentity(request).runId;
  const parsed = parseCheckpointLogs({
    logs: checkpointLogs(runId),
    request,
    runId,
  });
  assert.equal(parsed.patch.length, 0);
  assert.throws(() =>
    parseCheckpointLogs({
      logs: checkpointLogs(runId, { baseSha: "b".repeat(40) }),
      request,
      runId,
    }),
  );
  assert.throws(() =>
    parseCheckpointLogs({
      logs: checkpointLogs(runId).replace(
        '"dataBase64":""',
        '"dataBase64":"YQ=="',
      ),
      request,
      runId,
    }),
  );
  const failureCheckpoint = {
    schemaVersion: 3,
    runId,
    agentRole: "qa-contract-researcher",
    baseSha: "a".repeat(40),
    projectContextDigest: projectContext.digest,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    response: "",
    events: [],
    error: "Codex failed before producing a response",
    patch: {
      path: "changes.patch",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      bytes: 0,
    },
  };
  const failureLogs = JSON.stringify({
    type: "codeops.checkpoint",
    checkpointDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(failureCheckpoint))
      .digest("hex")}`,
    checkpoint: failureCheckpoint,
  });
  assert.throws(
    () => parseCheckpointLogs({ logs: failureLogs, request, runId }),
    /checkpoint reported failure/,
  );
});

test("retains one idempotent digest-bound result", async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "codeops-gateway-"));
  const identity = createRunIdentity(request);
  const retained = parseCheckpointLogs({
    logs: checkpointLogs(identity.runId),
    request,
    runId: identity.runId,
  });
  try {
    const result = await retainCheckpoint({
      rootDirectory,
      request,
      ...identity,
      retained,
    });
    assert.deepEqual(
      await readRetainedResult({ rootDirectory, request, ...identity }),
      result,
    );
    const directory = path.join(rootDirectory, "agent-runs", identity.runId);
    const resultPath = path.join(directory, "result.json");
    const driftedResult = structuredClone(result);
    driftedResult.researchResult.report.requestId = "another-research-request";
    await writeFile(resultPath, `${JSON.stringify(driftedResult, null, 2)}\n`);
    await assert.rejects(
      readRetainedResult({ rootDirectory, request, ...identity }),
      /research persona identity|terminal evidence drifted/,
    );
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(path.join(directory, "changes.patch"), "drift");
    await assert.rejects(
      readRetainedResult({ rootDirectory, request, ...identity }),
      /checkpoint evidence drifted/,
    );
    assert.equal(
      await readFile(path.join(directory, "changes.patch")).then((value) =>
        value.toString("utf8")),
      "drift",
    );
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test("builds only the fixed tokenless run resources", () => {
  const identity = createRunIdentity(request);
  const resources = buildRunResources(
    {
      namespace: "codeops-trial",
      ...identity,
      repositoryUrl: "https://github.com/example-org/example-repository",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeProfile,
      runtimeRequirements,
      repositoryReadToken: "repo-token",
      modelAuth,
    },
    request,
  );
  assert.doesNotThrow(() => assertRunResources(resources));
  assert.deepEqual(
    resources.map((resource) => resource.kind),
    ["Secret", "ServiceAccount", "Job", "NetworkPolicy"],
  );
  const workspaceBuilder =
    resources[2].spec.template.spec.initContainers[0].command.at(-1);
  assert.match(
    workspaceBuilder,
    /git -c safe\.directory=\/workspace -C \/workspace/,
  );
  assert.equal(workspaceBuilder.includes("safe.directory=*"), false);
  const runSecret = resources[0];
  assert.ok(runSecret.data["agent-prompt"]);
  assert.ok(runSecret.data["project-context"]);
  assert.ok(runSecret.data["research-dispatch"]);
  const sessionGateway = resources[2].spec.template.spec.containers.find(
    (container) => container.name === "session-gateway",
  );
  assert.equal(
    sessionGateway.env.find((entry) => entry.name === "CODEOPS_PROMPT_FILE")
      .value,
    "/input/agent-prompt.txt",
  );
  assert.equal(
    sessionGateway.env.some((entry) => entry.name === "CODEOPS_PROMPT_B64"),
    false,
  );
  assert.ok(
    resources[2].spec.template.spec.volumes.find(
      (volume) => volume.name === "run-input",
    ).secret.items.some((item) => item.path === "research-dispatch.json"),
  );
  const runInputItems = resources[2].spec.template.spec.volumes.find(
    (volume) => volume.name === "run-input",
  ).secret.items;
  assert.equal(
    runInputItems.some((item) =>
      ["repository-read-token", "model-api-key", "model-proxy-token"].includes(
        item.key,
      ),
    ),
    false,
  );
  assert.deepEqual(
    resources[2].spec.template.spec.volumes.find(
      (volume) => volume.name === "model-proxy-token",
    ),
    {
      name: "model-proxy-token",
      secret: {
        secretName: `codeops-run-${identity.runId}`,
        items: [{ key: "model-proxy-token", path: "model-proxy-token" }],
      },
    },
  );
  assert.deepEqual(
    [
      ...resources[2].spec.template.spec.initContainers,
      ...resources[2].spec.template.spec.containers,
    ].flatMap((container) =>
      container.volumeMounts
        .filter((mount) => mount.name === "model-proxy-token")
        .map((mount) => ({ container: container.name, mount })),
    ),
    [
      {
        container: "session-gateway",
        mount: {
          name: "model-proxy-token",
          mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token",
          subPath: "model-proxy-token",
          readOnly: true,
        },
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(
      Buffer.from(runSecret.data["research-dispatch"], "base64").toString(
        "utf8",
      ),
    ),
    request,
  );
  assert.equal(
    resources[2].spec.template.spec.initContainers[0].env.some((entry) =>
      entry.name.endsWith("_B64"),
    ),
    false,
  );
  const codingAgent = resources[2].spec.template.spec.containers.find(
    (container) => container.name === "coding-agent",
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "CODEX_HOME").value,
    "/var/lib/codeops-agent/codex-home",
  );
  assert.deepEqual(
    codingAgent.volumeMounts.find((entry) => entry.mountPath === "/var/lib/codeops-agent/codex-home"),
    {
      name: "workspace",
      mountPath: "/var/lib/codeops-agent/codex-home",
      subPath: ".codeops/codex-home",
      readOnly: false,
    },
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "INITIAL_AGENT_MODE").value,
    "agent-full-access",
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "DEFAULT_AUTH_REQUEST").value,
    '{"methodId":"api-key"}',
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "CODEOPS_MODEL_PROXY_TOKEN_FILE").value,
    "/run/codeops/model-proxy-token",
  );
  assert.equal(
    resources[2].spec.template.spec.volumes.some(
      (volume) => volume.name === "codex-auth",
    ),
    false,
  );
  const codexConfig = JSON.parse(
    codingAgent.env.find((entry) => entry.name === "CODEX_CONFIG").value,
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "MODEL_PROVIDER").value,
    codexConfig.model_provider,
  );
  assert.equal(codexConfig.model_provider, "codeops_proxy");
  assert.equal(codexConfig.approvals_reviewer, "auto_review");
  assert.equal(codexConfig.web_search, "cached");
  assert.equal(
    codexConfig.model_providers.codeops_proxy.base_url,
    "http://codeops-model-proxy:8080/v1",
  );
  assert.equal(codexConfig.model_providers.codeops_proxy.env_key, "CODEX_API_KEY");
  assert.equal(JSON.stringify(resources).includes("model-api-key"), false);
  assert.equal(JSON.stringify(resources).includes("codeops-codex-auth"), false);
  assert.equal(JSON.stringify(resources).includes("automountServiceAccountToken\":true"), false);

  const mutations = [
    (agent) => agent.env.splice(agent.env.findIndex(({ name }) => name === "MODEL_PROVIDER"), 1),
    (agent) => { agent.env.find(({ name }) => name === "MODEL_PROVIDER").value = "openai"; },
    (agent) => { agent.env.find(({ name }) => name === "CODEOPS_MODEL_PROXY_ORIGIN").value = "http://other-proxy:8080"; },
    (agent) => { agent.env.find(({ name }) => name === "CODEOPS_MODEL_PROXY_TOKEN_FILE").name = "OPENAI_API_KEY"; },
    (agent) => {
      const entry = agent.env.find(({ name }) => name === "CODEX_CONFIG");
      const value = JSON.parse(entry.value);
      value.model_provider = "openai";
      entry.value = JSON.stringify(value);
    },
    (agent) => {
      const entry = agent.env.find(({ name }) => name === "CODEX_CONFIG");
      const value = JSON.parse(entry.value);
      value.model_providers.codeops_proxy.base_url = "http://other-proxy:8080/v1";
      entry.value = JSON.stringify(value);
    },
    (agent) => {
      const entry = agent.env.find(({ name }) => name === "CODEX_CONFIG");
      const value = JSON.parse(entry.value);
      value.model_providers.codeops_proxy.env_key = "OPENAI_API_KEY";
      entry.value = JSON.stringify(value);
    },
    (agent) => {
      const entry = agent.env.find(({ name }) => name === "CODEX_CONFIG");
      const value = JSON.parse(entry.value);
      value.model_providers.codeops_proxy.wire_api = "chat";
      entry.value = JSON.stringify(value);
    },
  ];
  for (const mutate of mutations) {
    const drifted = structuredClone(resources);
    mutate(drifted[2].spec.template.spec.containers.find(({ name }) => name === "coding-agent"));
    assert.throws(() => assertRunResources(drifted), /model proxy/);
  }
  for (const mutate of [
    (pod) => {
      pod.containers.find(({ name }) => name === "coding-agent").env.push({
        name: "CODEX_API_KEY",
        value: "literal-reusable-key",
      });
    },
    (pod) => {
      pod.containers.find(({ name }) => name === "coding-agent").env.push({
        name: "CODEX_API_KEY",
        value: "",
      });
    },
    (pod) => {
      pod.containers.find(({ name }) => name === "coding-agent").env.push({
        name: "OPENAI_API_KEY",
        valueFrom: { secretKeyRef: { name: "alternate", key: "token" } },
      });
    },
    (pod) => {
      pod.containers.find(({ name }) => name === "coding-agent").env.find(
        ({ name }) => name === "CODEOPS_MODEL_PROXY_TOKEN_FILE",
      ).value = "/run/codeops/other-token";
    },
    (pod) => {
      pod.volumes.find(({ name }) => name === "model-proxy-token")
        .secret.secretName = "alternate-run-secret";
    },
    (pod) => {
      pod.volumes.find(({ name }) => name === "model-proxy-token")
        .secret.items[0].key = "alternate-token";
    },
    (pod) => {
      pod.volumes.find(({ name }) => name === "model-proxy-token")
        .secret.items[0].path = "alternate-token";
    },
    (pod) => {
      pod.volumes.find(({ name }) => name === "session").secret = {
        secretName: "alternate-run-secret",
      };
      delete pod.volumes.find(({ name }) => name === "session").emptyDir;
    },
    (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .volumeMounts.find(({ mountPath }) => mountPath === "/run/codeops").name = "temp";
    },
    (pod) => {
      pod.containers.push({
        name: "extra-sidecar",
        volumeMounts: [{ name: "session", mountPath: "/alternate-session" }],
      });
    },
    (pod) => {
      pod.volumes.push({ name: "session-alias", emptyDir: {} });
      pod.containers.push({
        name: "extra-sidecar",
        volumeMounts: [
          { name: "session-alias", mountPath: "/alternate/../run/codeops" },
        ],
      });
    },
    (pod) => {
      pod.containers.find(({ name }) => name === "coding-agent").volumeMounts.push({
        name: "session",
        mountPath: "/alternate-session",
      });
    },
    (pod) => {
      pod.volumes.push({ name: "session-alias", emptyDir: {} });
      pod.containers.find(({ name }) => name === "coding-agent").volumeMounts.push({
        name: "session-alias",
        mountPath: "/run/codeops/consumer",
      });
    },
    ...["/alternate/../run/codeops/secret", "/run"].map(
      (mountPath) => (pod) => {
        pod.volumes.push({
          name: "overlapping-secret",
          secret: { secretName: "alternate-run-secret" },
        });
        pod.initContainers.find(({ name }) => name === "workspace-builder")
          .volumeMounts.push({
            name: "overlapping-secret",
            mountPath,
            readOnly: true,
          });
      },
    ),
  ]) {
    const drifted = structuredClone(resources);
    mutate(drifted[2].spec.template.spec);
    assert.throws(() => assertRunResources(drifted), /model proxy/);
  }
  const networkDrift = structuredClone(resources);
  networkDrift[3].spec.egress[0].to[0].podSelector.matchLabels["app.kubernetes.io/name"] =
    "other-proxy";
  assert.throws(() => assertRunResources(networkDrift), /model proxy/);
});

test("rejects model proxy token projection and lifecycle mutations", () => {
  const identity = createRunIdentity(request);
  const resources = buildRunResources(
    {
      namespace: "codeops-trial",
      ...identity,
      repositoryUrl: "https://github.com/example-org/example-repository",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeProfile,
      runtimeRequirements,
      repositoryReadToken: "repo-token",
      modelAuth,
    },
    request,
  );
  const lifecycleCommand =
    "const f=require('node:fs'),s='/var/run/secrets/codeops-model-proxy/model-proxy-token',d='/run/codeops/model-proxy-token',t=d+'.tmp',v=f.readFileSync(s);if(!v.length)throw new Error('model proxy token is empty');const h=f.openSync(t,f.constants.O_WRONLY|f.constants.O_CREAT|f.constants.O_EXCL,0o600);try{f.fchmodSync(h,0o600);f.writeFileSync(h,v);f.fsyncSync(h)}finally{f.closeSync(h)}const w=f.readFileSync(t);if(!w.length||!w.equals(v))throw new Error('model proxy token copy is incomplete');f.renameSync(t,d);const q=f.openSync(d,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const a=f.fstatSync(q),x=f.readFileSync(q);if(!a.isFile()||(a.mode&0o777)!==0o600||!x.length||!x.equals(v))throw new Error('published model proxy token is invalid')}finally{f.closeSync(q)}";
  for (const [name, mutate] of [
    ["removal", (pod) => {
      pod.volumes.splice(
        pod.volumes.findIndex((volume) => volume.name === "model-proxy-token"),
        1,
      );
    }],
    ["replacement", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command = ["node", "-e", "process.exit(0)"];
    }],
    ["decoy", (pod) => {
      const gateway = pod.containers.find(({ name }) => name === "session-gateway");
      gateway.lifecycle.postStart.exec.command = ["node", "-e", "process.exit(0)"];
      gateway.lifecycle.preStop = { exec: { command: ["node", "-e", lifecycleCommand] } };
    }],
    ["alternate file", (pod) => {
      const gateway = pod.containers.find(({ name }) => name === "session-gateway");
      gateway.lifecycle.postStart.exec.command[2] = gateway.lifecycle.postStart.exec.command[2]
        .replace("/var/run/secrets/codeops-model-proxy/model-proxy-token", "/var/run/secrets/codeops-model-proxy/alternate-token");
    }],
    ["direct final write", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace("t=d+'.tmp'", "t=d");
    }],
    ["nonexclusive temporary", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace(
          "f.constants.O_EXCL",
          "f.constants.O_TRUNC",
        );
    }],
    ["broad temporary mode", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replaceAll("0o600", "0o644");
    }],
    ["empty token accepted", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace(
          "if(!v.length)throw new Error('model proxy token is empty');",
          "",
        );
    }],
    ["incomplete copy accepted", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace(
          "const w=f.readFileSync(t);if(!w.length||!w.equals(v))throw new Error('model proxy token copy is incomplete');",
          "",
        );
    }],
    ["non-atomic final copy", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace(
          "f.renameSync(t,d)",
          "f.copyFileSync(t,d)",
        );
    }],
    ["symlink-following final validation", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace(
          "|f.constants.O_NOFOLLOW",
          "",
        );
    }],
    ["final mode unchecked", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace(
          "!a.isFile()||(a.mode&0o777)!==0o600||",
          "",
        );
    }],
    ["final content unchecked", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway")
        .lifecycle.postStart.exec.command[2] = lifecycleCommand.replace(
          "||!x.length||!x.equals(v)",
          "",
        );
    }],
    ["extra competing Secret volume", (pod) => {
      pod.volumes.push({
        name: "alternate-model-proxy-token",
        secret: { secretName: "alternate-run-secret" },
      });
      pod.containers.find(({ name }) => name === "session-gateway")
        .volumeMounts.push({
          name: "alternate-model-proxy-token",
          mountPath: "/var/run/secrets/codeops-model-proxy",
          readOnly: true,
        });
    }],
    ["duplicate mount", (pod) => {
      const gateway = pod.containers.find(({ name }) => name === "session-gateway");
      gateway.volumeMounts.push(structuredClone(
        gateway.volumeMounts.find(({ name }) => name === "model-proxy-token"),
      ));
    }],
    ["workspace-builder mount", (pod) => {
      pod.initContainers.find(({ name }) => name === "workspace-builder")
        .volumeMounts.push({
          name: "model-proxy-token",
          mountPath: "/var/run/secrets/codeops-model-proxy/model-proxy-token",
          subPath: "model-proxy-token",
          readOnly: true,
        });
    }],
    ["run-input projection", (pod) => {
      pod.volumes.find(({ name }) => name === "run-input").secret.items.push({
        key: "model-proxy-token",
        path: "model-proxy-token",
      });
    }],
    ["run-input items omission", (pod) => {
      delete pod.volumes.find(({ name }) => name === "run-input").secret.items;
    }],
    ["alternate same-Secret volume", (pod) => {
      pod.volumes.push({
        name: "alternate-run-secret",
        secret: { secretName: `codeops-run-${identity.runId}` },
      });
      pod.containers.find(({ name }) => name === "session-gateway")
        .volumeMounts.push({
          name: "alternate-run-secret",
          mountPath: "/alternate",
          readOnly: true,
        });
    }],
    ["secretKeyRef", (pod) => {
      pod.initContainers.find(({ name }) => name === "workspace-builder").env.push({
        name: "ALTERNATE_MODEL_TOKEN",
        valueFrom: {
          secretKeyRef: {
            name: `codeops-run-${identity.runId}`,
            key: "model-proxy-token",
          },
        },
      });
    }],
    ["broad Secret environment", (pod) => {
      pod.containers.find(({ name }) => name === "session-gateway").envFrom = [
        { secretRef: { name: `codeops-run-${identity.runId}` } },
      ];
    }],
    ["projected Secret parent mount", (pod) => {
      pod.volumes.push({
        name: "projected-run-secret",
        projected: {
          sources: [{ secret: { name: `codeops-run-${identity.runId}` } }],
        },
      });
      pod.containers.find(({ name }) => name === "session-gateway")
        .volumeMounts.push({
          name: "projected-run-secret",
          mountPath: "/var/run/secrets/codeops-model-proxy",
          readOnly: true,
        });
    }],
    ...["/var/run/secrets/codeops-model-proxy/", "/var/run/secrets/alternate/../codeops-model-proxy"].map(
      (mountPath) => [mountPath, (pod) => {
        pod.volumes.push({
          name: "parent-secret",
          secret: {
            secretName: "alternate-run-secret",
            items: [{ key: "repository-read-token", path: "repository-read-token" }],
          },
        });
        pod.containers.find(({ name }) => name === "session-gateway")
          .volumeMounts.push({ name: "parent-secret", mountPath, readOnly: true });
      }],
    ),
    ...[
      ["direct Secret child mount", "secret", "/var/run/secrets/codeops-model-proxy/model-proxy-token/child"],
      ["projected Secret child mount", "projected", "/var/run/secrets/codeops-model-proxy/model-proxy-token/child"],
      ["Secret child mount with trailing slash", "secret", "/var/run/secrets/codeops-model-proxy/model-proxy-token/child/"],
      ["normalized Secret child mount", "secret", "/var/run/secrets/codeops-model-proxy/model-proxy-token/alternate/../child"],
    ].map(([name, kind, mountPath]) => [name, (pod) => {
      pod.volumes.push({
        name: "child-secret",
        ...(kind === "secret"
          ? { secret: { secretName: "alternate-run-secret" } }
          : {
              projected: {
                sources: [{ secret: { name: "alternate-run-secret" } }],
              },
            }),
      });
      pod.containers.find(({ name: containerName }) => containerName === "session-gateway")
        .volumeMounts.push({ name: "child-secret", mountPath, readOnly: true });
    }]),
  ]) {
    const drifted = structuredClone(resources);
    mutate(drifted[2].spec.template.spec);
    assert.throws(
      () => assertRunResources(drifted),
      /model proxy/,
      name,
    );
  }
});

test("builds Agent Jobs from portable chart runtime identity", () => {
  const identity = createRunIdentity(request);
  const resources = buildRunResources(
    {
      namespace: "engineering",
      ...identity,
      repositoryUrl: "https://github.com/example-org/example-repository",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      runtimeProfile,
      runtimeRequirements,
      repositoryReadToken: "repo-token",
      imagePullSecrets: [{ name: "team-a-registry" }],
      nodeSelector: { "codeops.dev/operator": "true" },
      evidenceClaimName: "team-a-codeops-control-gateway-evidence",
      modelProxyServiceName: "team-a-codeops-model-proxy",
      modelProxyPodName: "team-a-model-proxy-pods",
      modelAuth: {
        ...modelAuth,
        origin: "http://team-a-codeops-model-proxy:8080",
      },
    },
    request,
  );
  assert.doesNotThrow(() => assertRunResources(resources, {
    serviceName: "team-a-codeops-model-proxy",
    podName: "team-a-model-proxy-pods",
  }));
  const pod = resources[2].spec.template.spec;
  assert.deepEqual(pod.imagePullSecrets, [{ name: "team-a-registry" }]);
  assert.deepEqual(pod.nodeSelector, { "codeops.dev/operator": "true" });
  assert.equal(
    pod.volumes.find(({ name }) => name === "candidate"),
    undefined,
  );
  assert.equal(pod.affinity, undefined);
  assert.equal(
    resources[3].spec.egress[0].to[0].podSelector.matchLabels["app.kubernetes.io/name"],
    "team-a-model-proxy-pods",
  );
  assert.equal(
    resources[2].spec.template.metadata.labels["app.kubernetes.io/part-of"],
    "codeops",
  );
});
