import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectContext } from "@codeops/codeops-contracts";
import {
  authenticateBearer,
  buildAgentPrompt,
  createRunIdentity,
  loadGitHubReviewComments,
  parseCheckpointLogs,
  qualifyGitHubHead,
  readCandidatePatch,
  readRetainedResult,
  resolveGitHubBranchHead,
  resolveGitHubPullRequestHead,
  retainCheckpoint,
} from "../dist/core.js";
import { assertRunResources, buildRunResources } from "../dist/resources.js";

const modelAuth = {
  mode: "proxy",
  origin: "http://codeops-model-proxy:8080",
  signingKey: "m".repeat(64),
  issuedAt: new Date("2026-08-09T17:00:00.000Z"),
};

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
        base: { ref: "feat/codeops-contracts-ci" },
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
        base: { ref: "feat/codeops-contracts-ci" },
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
  const resources = buildRunResources(
    {
      namespace: "codeops-trial",
      ...createRunIdentity(codingDispatch),
      repositoryUrl: "https://github.com/example-org/example-repository",
      agentImage: `ghcr.io/a/agent@sha256:${"c".repeat(64)}`,
      sessionGatewayImage: `ghcr.io/a/gateway@sha256:${"d".repeat(64)}`,
      repositoryReadToken: "repo-token",
      modelAuth,
    },
    codingDispatch,
  );
  assert.doesNotThrow(() => assertRunResources(resources));
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
    const candidateMount = pod.initContainers[0].volumeMounts.find(
      (mount) => mount.name === "candidate",
    );
    assert.equal(
      candidateMount.subPath,
      `agent-runs/${candidate.runId}/changes.patch`,
    );
    assert.equal(
      pod.containers.some((container) =>
        container.volumeMounts.some((mount) => mount.name === "candidate"),
      ),
      false,
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
      await readRetainedResult({ rootDirectory, ...identity }),
      result,
    );
    assert.equal(
      await readFile(
        path.join(
          rootDirectory,
          "agent-runs",
          identity.runId,
          "changes.patch",
        ),
      ).then((value) => value.length),
      0,
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
      ["repository-read-token", "model-api-key"].includes(item.key),
    ),
    false,
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
    "/tmp/codex-home",
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "DEFAULT_AUTH_REQUEST").value,
    '{"methodId":"api-key"}',
  );
  assert.equal(
    codingAgent.env.find((entry) => entry.name === "CODEX_API_KEY").valueFrom
      .secretKeyRef.key,
    "model-proxy-token",
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
});
