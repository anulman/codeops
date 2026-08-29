import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  adversarialReviewSchema,
  agentJobDispatchRequestSchema,
  agentJobDispatchResultSchema,
  canonicalJsonBytes,
  canonicalJsonText,
  canonicalSerialize,
  candidatePublicationSchema,
  codingRequestSchema,
  contractVersions,
  controlCommandSchema,
  controlResultSchema,
  createEventId,
  createProjectContext,
  createPlaneSessionRequestFromPlaneComment,
  createResearchRequestFromPlaneComment,
  createTransitionId,
  evidenceReferenceSchema,
  existingPullRequestAdoptionRequestSchema,
  githubPullRequestStackLinkSchema,
  githubPullRequestStackPositionSchema,
  githubPullRequestStackSnapshotSchema,
  lifecycleProfileSchema,
  lifecycleStateSchema,
  planeCommentEventSchema,
  planeCommentRequestClassificationSchema,
  providerLifecycleBindingSchema,
  qaContractResearcherPolicy,
  readinessGateSchema,
  researchMutationBatchSchema,
  researchPacketSchema,
  sha256CanonicalJsonDigest,
  researchPlaneMutationSchema,
  secretReferenceSchema,
  sessionSupervisionReconciliationRequestSchema,
  sessionSupervisionReconciliationResultSchema,
  trustedPlaneWorkItemReferenceSchema,
  verifyPlaneWebhookSignature,
  workflowEventSchema,
  workflowStateSchema,
  workItemLifecycleEventSchema,
  workItemRequestSchema,
} from "../dist/index.js";

function trustedPlaneBinding(apiOrigin = "https://plane.example.com/") {
  return {
    version: "codeops.trusted-plane-work-item-reference/v1",
    apiOrigin,
    workspaceSlug: "engineering",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    projectIdentifier: "COAUTO",
    workItemId: "33333333-3333-4333-8333-333333333333",
    sequenceId: 19,
    reference: "COAUTO-19",
  };
}

test("admits only byte-exact canonical trusted Plane HTTPS origins", () => {
  for (const apiOrigin of [
    "https://plane.example.com/",
    "https://plane.example.com:8443/",
    "https://xn--bcher-kva.example/",
  ]) {
    assert.equal(
      trustedPlaneWorkItemReferenceSchema.parse(trustedPlaneBinding(apiOrigin))
        .apiOrigin,
      apiOrigin,
    );
  }
  for (const apiOrigin of [
    "https://PLANE.example.com/",
    "https://plane.example.com:443/",
    "https:////evil.example/",
    "https://plane.example.com/%2e%2e/",
    "https://plane.example.com\n.evil.example/",
    "https://bücher.example/",
    "https://plane.example.com/?query=1",
    "https://plane.example.com/#fragment",
    "https://user@plane.example.com/",
    "https://plane.example.com/path",
    "http://plane.example.com/",
    "https://plane.example.com",
  ]) {
    assert.throws(
      () => trustedPlaneWorkItemReferenceSchema.parse(trustedPlaneBinding(apiOrigin)),
      undefined,
      apiOrigin,
    );
  }
});

test("binds session supervision reconciliation to exact parent, children, and PR identity", () => {
  const request = {
    version: "codeops.session-supervision-reconciliation/v1",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    supervisorSessionId: "ses_pm",
    childSessionIds: ["ses_worker", "ses_reviewer"],
    repository: "example-org/example-repository",
    workItemId: "22222222-2222-4222-8222-222222222222",
    workflowId: "adopt-pr-158",
    pullRequestNumber: 158,
    pullRequestHeadSha: "b".repeat(40),
  };
  assert.deepEqual(sessionSupervisionReconciliationRequestSchema.parse(request), request);
  assert.throws(() =>
    sessionSupervisionReconciliationRequestSchema.parse({
      ...request,
      childSessionIds: ["ses_worker", "ses_worker"],
    }),
  );
  assert.throws(() =>
    sessionSupervisionReconciliationRequestSchema.parse({
      ...request,
      childSessionIds: ["ses_pm"],
    }),
  );
  assert.equal(
    sessionSupervisionReconciliationResultSchema.parse({
      version: "codeops.session-supervision-reconciliation-result/v1",
      idempotencyKey: request.idempotencyKey,
      supervisorSessionId: request.supervisorSessionId,
      projected: request.childSessionIds.map((childSessionId, index) => ({
        childSessionId,
        disposition: index === 0 ? "created" : "existing",
        eventCursor: 6 + index,
      })),
    }).projected.length,
    2,
  );
});

const now = "2026-07-25T16:00:00.000Z";
const sha = "8f3d2c033f70be04b4b2dc8a005683806e84e209";

function makeProjectContext(workspaceId, projectId) {
  return createProjectContext({
    version: contractVersions.projectContext,
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: sha,
    baseSha: sha,
    project: {
      workspaceId,
      projectId,
      name: "Onboarding Auth QA",
      descriptionHtml: "<p>Qualify the canonical customer-file auth matrix.</p>",
      updatedAt: now,
    },
    documents: [
      {
        path: "AGENTS.md",
        purpose: "Repository agent guidance",
        digest:
          "sha256:bce2d710d7649d7175f3dcf1ef4705b5cd16a3ba674788ab17ca03164cb8be85",
        content: "# Repository guidance\n",
      },
    ],
  });
}

test("sorts mixed-case project context paths with the canonical comparator", () => {
  const context = createProjectContext({
    version: contractVersions.projectContext,
    repository: { owner: "example-org", name: "example-repository" },
    controlPlaneSha: sha,
    baseSha: sha,
    project: {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      name: "Onboarding Auth QA",
      descriptionHtml: "<p>Canonical context.</p>",
      updatedAt: now,
    },
    documents: [
      {
        path: "SOUL.md",
        purpose: "Writing rules",
        digest: `sha256:${createHash("sha256").update("# Soul\n").digest("hex")}`,
        content: "# Soul\n",
      },
      {
        path: "docs/agent-context/PRODUCT.md",
        purpose: "Product context",
        digest: `sha256:${createHash("sha256").update("# Product\n").digest("hex")}`,
        content: "# Product\n",
      },
      {
        path: "AGENTS.md",
        purpose: "Agent guidance",
        digest: `sha256:${createHash("sha256").update("# Agents\n").digest("hex")}`,
        content: "# Agents\n",
      },
    ],
  });

  assert.deepEqual(
    context.documents.map((document) => document.path),
    ["AGENTS.md", "docs/agent-context/PRODUCT.md", "SOUL.md"],
  );
});

function makeTicketSnapshot(workItemId) {
  return {
    workItemId,
    name: "Inventory canonical auth states",
    descriptionHtml: "<p>Define the route/state/credential matrix.</p>",
    priority: "high",
    stateId: "77777777-7777-4777-8777-777777777777",
    labelIds: [],
    assigneeIds: [],
    moduleId: null,
    parentId: null,
    updatedAt: now,
    relevantComments: [],
    relations: [],
    projectTasks: [],
  };
}

function makeSynthesis(requestId) {
  return {
    version: contractVersions.researchSynthesis,
    requestId,
    verdict: "ready-to-refine",
    summary: "The product and implementation boundaries are explicit.",
    topFindings: [],
    decisions: [],
    downstreamFindings: [],
    followUpTasks: [],
    matrix: {
      version: contractVersions.researchMatrix,
      rows: [
        {
          id: "matrix-1",
          lifecycleState: "qualified",
          credentialState: "valid",
          routeOrRpc: "/claim",
          currentOracle: "Repository-backed current behavior.",
          expectedOracle: "Customer-file-scoped behavior.",
          allowedSideEffects: "None during research.",
          status: "verified",
          citationIds: ["citation-1"],
        },
      ],
    },
    citations: [
      {
        id: "citation-1",
        path: "sites/app/routes/f.$fileCode/index.tsx",
        lineStart: 1,
        claim: "Fixture citation.",
      },
    ],
  };
}

function makeResearchPacket({ projectContext, workItemId }) {
  const requestId = "research-request:fixture";
  return {
    version: contractVersions.researchPacket,
    personas: ["@ai-product"],
    perspectives: [
      {
        persona: "@ai-product",
        outcome: "findings",
        summary: "The task needs one bounded product-aware implementation.",
      },
    ],
    requestId,
    projectId: projectContext.project.projectId,
    workItemId,
    baseSha: sha,
    projectContextDigest: projectContext.digest,
    planeRevisionDigest: `sha256:${"9".repeat(64)}`,
    summary: "The product and implementation boundaries are explicit.",
    synthesis: makeSynthesis(requestId),
    currentBehavior: ["The current behavior is repository-backed."],
    expectedBehavior: ["The accepted behavior remains customer-file scoped."],
    evidence: [],
    videoNotApplicableReason: "This is a bounded contract fixture.",
    decisions: [],
    proposedMutations: {
      version: contractVersions.researchMutationBatch,
      requestId,
      projectId: projectContext.project.projectId,
      sourceWorkItemId: workItemId,
      mutations: [
        {
          type: "ticket.update",
          targetWorkItemId: workItemId,
          changes: { descriptionHtml: "<p>Refined description.</p>" },
        },
        {
          type: "comment.create",
          targetWorkItemId: workItemId,
          bodyHtml: "<p>Research complete.</p>",
          attachments: [],
        },
      ],
    },
    createdAt: now,
  };
}

const secretReference = {
  version: contractVersions.secretReference,
  provider: "kubernetes",
  reference: "codeops-run-123",
  scope: "run-123",
};

const evidence = {
  version: contractVersions.evidence,
  kind: "test-report",
  uri: "artifact:///runs/run-123/report.json",
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 1_024,
  mediaType: "application/json",
};

const workItem = {
  version: contractVersions.workItem,
  workItemId: "plane:2fdebb4c",
  workflowId: "workflow-123",
  runId: "run-123",
  repository: { owner: "example-org", name: "example-repository" },
  baseSha: sha,
  branch: "feat/customer-routing-matrix",
  summary: "Validate customer routing across file and browser states.",
  acceptanceCriteria: ["Every matrix cell has a deterministic assertion."],
  secretReferences: [secretReference],
  requestedAt: now,
};

function makeAdversarialReview(overrides = {}) {
  const candidate = {
    round: 1,
    runId: "agent-review-123",
    checkpoint: {
      uri: "artifact:///agent-runs/agent-review-123/checkpoint.json",
      digest: `sha256:${"d".repeat(64)}`,
      sizeBytes: 4_096,
    },
    patch: {
      uri: "artifact:///agent-runs/agent-review-123/changes.patch",
      digest: `sha256:${"e".repeat(64)}`,
      sizeBytes: 2_048,
    },
    codingOutcome: {
      version: "codeops.coding-outcome/v1",
      summary: "Implemented the exact ticket.",
      tests: [
        {
          command: "node --test test/routing.test.mjs",
          status: "passed",
          summary: "The focused routing contract passes.",
        },
      ],
    },
  };
  return {
    version: contractVersions.adversarialReview,
    workflowId: "workflow-123",
    workItemId: workItem.workItemId,
    baseSha: sha,
    reviewerId: "critic-agent",
    reviewedAt: now,
    candidate,
    lenses: {
      ticketCompletion: {
        status: "clear",
        summary: "The bounded ticket is complete.",
      },
      unusedCode: {
        status: "clear",
        summary: "Every introduced export has a concrete consumer.",
      },
      simplicityMaintainability: {
        status: "clear",
        summary: "The smallest ownership boundary remains legible.",
      },
      existingSystems: {
        status: "clear",
        summary: "The existing ownership boundary is extended cleanly.",
      },
      testEffectiveness: {
        status: "clear",
        summary: "Focused executable tests prove the changed behavior.",
      },
      userFacingBehavior: {
        status: "clear",
        summary: "No user-facing regression was found.",
      },
      securityPrivacy: {
        status: "clear",
        summary: "No concrete security regression was found.",
      },
    },
    findings: [],
    verificationTests: [{
      command: "node --test test/routing.test.mjs",
      status: "passed",
      summary: "The critic independently reproduced the focused pass.",
    }],
    fastFollowRecommendations: [],
    verdict: "pass",
    summary: "All seven adversarial review lenses pass.",
    ...overrides,
  };
}

function command(type, payload) {
  return {
    version: contractVersions.controlCommand,
    commandId: `command-${type}`,
    workflowId: "workflow-123",
    runId: "run-123",
    requestedAt: now,
    type,
    payload,
  };
}

test("accepts the complete work-item and opaque secret-reference contracts", () => {
  assert.deepEqual(workItemRequestSchema.parse(workItem), workItem);
  assert.deepEqual(secretReferenceSchema.parse(secretReference), secretReference);
});

test("adversarial review binds all seven lenses and test evidence to one exact coding candidate", () => {
  const passing = makeAdversarialReview();
  assert.deepEqual(adversarialReviewSchema.parse(passing), passing);

  const finding = {
    id: "expired-cookie-not-sent",
    category: "security-privacy",
    severity: "high",
    path: "services/acceptance-runner/scenarios/customer-file-routing/cookie.mjs",
    lineStart: 72,
    problem: "The browser discards the expired credential before the request.",
    impact: "The security test exercises a missing cookie instead of server-side expiry rejection.",
    recommendation: "Keep the browser cookie live while expiring only the signed JWT payload.",
    resolution: "must-fix",
  };
  const revision = makeAdversarialReview({
    lenses: {
      ...passing.lenses,
      securityPrivacy: {
        status: "finding",
        summary: "One high-severity security-test validity defect remains.",
      },
    },
    findings: [finding],
    verdict: "revision-required",
    summary: "The candidate requires a bounded security-fixture revision.",
  });
  assert.deepEqual(adversarialReviewSchema.parse(revision), revision);
  assert.throws(() =>
    adversarialReviewSchema.parse({
      ...revision,
      verdict: "pass",
    }),
  );
  assert.throws(() =>
    adversarialReviewSchema.parse({
      ...revision,
      findings: [{
        ...finding,
        severity: "medium",
        resolution: "accepted-tradeoff",
        justification: "Defer the security regression.",
      }],
      verdict: "pass",
    }),
  );
  assert.throws(() =>
    adversarialReviewSchema.parse({
      ...revision,
      lenses: {
        ...revision.lenses,
        securityPrivacy: passing.lenses.securityPrivacy,
        ticketCompletion: {
          status: "finding",
          summary: "One bounded acceptance requirement remains.",
        },
      },
      findings: [{
        ...finding,
        category: "ticket-completion",
        severity: "low",
        resolution: "not-actionable",
        justification: "Ignore the acceptance gap.",
      }],
      verdict: "pass",
    }),
  );
  assert.throws(() =>
    adversarialReviewSchema.parse({
      ...passing,
      candidate: {
        ...passing.candidate,
        codingOutcome: {
          ...passing.candidate.codingOutcome,
          tests: [],
        },
      },
    }),
  );
  assert.throws(() =>
    adversarialReviewSchema.parse({
      ...revision,
      findings: [{
        ...finding,
        resolution: "accepted-tradeoff",
        justification: "Convenient.",
      }],
      verdict: "pass",
    }),
  );
  assert.throws(() =>
    adversarialReviewSchema.parse({
      ...passing,
      lenses: {
        ...passing.lenses,
        unusedCode: {
          status: "finding",
          summary: "Unused code exists.",
        },
      },
    }),
  );
});

test("binds a coding request to one admitted Plane revision and workflow", () => {
  const codingWorkItem = {
    ...workItem,
    workItemId: "e1c25c66-5bb8-465e-a818-92a483423443",
    workflowId: "coding-123",
    runId: "coding-123",
  };
  const request = {
    version: contractVersions.codingRequest,
    planeWorkItem: {
      version: "codeops.trusted-plane-work-item-reference/v1",
      apiOrigin: "https://plane.example.com/",
      workspaceSlug: "engineering",
      workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
      projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
      projectIdentifier: "COAUTO",
      workItemId: codingWorkItem.workItemId,
      sequenceId: 19,
      reference: "COAUTO-19",
    },
    requestId: "coding-123",
    eventId: "ready-event:123",
    workspaceId: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
    projectId: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
    requestedBy: "88fc36c8-73b0-4547-81c7-96b70f61835e",
    controlPlaneSha: sha,
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    ticketSnapshot: makeTicketSnapshot(codingWorkItem.workItemId),
    researchDisposition: {
      mode: "optional",
      rationale: "The exact packet is useful but not required.",
    },
    projectContext: makeProjectContext(
      "d250cd44-fa71-42c2-b2b5-3c73227288fc",
      "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
    ),
    workItem: codingWorkItem,
  };
  request.researchPacket = makeResearchPacket({
    projectContext: request.projectContext,
    workItemId: codingWorkItem.workItemId,
  });
  assert.deepEqual(codingRequestSchema.parse(request), request);
  const humanReviewRequest = {
    ...request,
    requestedBy: "github:6723643628",
    humanReview: {
      version: "codeops.human-review-request/v1",
      repository: "example-org/example-repository",
      pullRequestNumber: 158,
      reviewId: 9001,
      reviewedHeadSha: codingWorkItem.baseSha,
      headRef: codingWorkItem.branch,
      baseRef: "main",
      reviewer: { id: 6723643628, login: "anulman" },
      state: "changes_requested",
      submittedAt: now,
      summary: "Tighten the exact-head assertion.",
      comments: [
        {
          id: 7001,
          body: "Add a regression test.",
          path: "services/codeops-plane-controller/src/github-events.ts",
          line: 42,
          side: "RIGHT",
          createdAt: now,
        },
      ],
    },
  };
  assert.deepEqual(
    codingRequestSchema.parse(humanReviewRequest),
    humanReviewRequest,
  );
  assert.throws(() =>
    codingRequestSchema.parse({
      ...humanReviewRequest,
      humanReview: {
        ...humanReviewRequest.humanReview,
        reviewedHeadSha: "f".repeat(40),
      },
    }),
  );
  const adoptedPullRequest = {
    version: "codeops.adopted-pull-request/v1",
    repository: "example-org/example-repository",
    pullRequestNumber: 158,
    headSha: codingWorkItem.baseSha,
    headRef: codingWorkItem.branch,
    baseSha: "a".repeat(40),
    baseRef: "main",
    title: "Qualify the canonical customer-file auth matrix",
    url: "https://github.com/example-org/example-repository/pull/158",
    adoptedAt: now,
    sessionOwnerPrincipalId: "access:aidan@example.com",
    rationale: "Run the existing PR head through the independent critic loop.",
  };
  const adoptedRequest = {
    ...request,
    adoptedPullRequest,
  };
  assert.deepEqual(codingRequestSchema.parse(adoptedRequest), adoptedRequest);
  assert.deepEqual(
    existingPullRequestAdoptionRequestSchema.parse({
      version: "codeops.existing-pull-request-adoption-request/v1",
      operatorRequestId: "22222222-2222-4222-8222-222222222222",
      codingRequest: adoptedRequest,
      pullRequest: adoptedPullRequest,
    }).pullRequest,
    adoptedPullRequest,
  );
  assert.throws(() =>
    codingRequestSchema.parse({
      ...adoptedRequest,
      humanReview: humanReviewRequest.humanReview,
    }),
  );
  assert.throws(() =>
    existingPullRequestAdoptionRequestSchema.parse({
      version: "codeops.existing-pull-request-adoption-request/v1",
      operatorRequestId: "22222222-2222-4222-8222-222222222222",
      codingRequest: adoptedRequest,
      pullRequest: { ...adoptedPullRequest, headSha: "f".repeat(40) },
    }),
  );
  const initialDispatch = {
    version: contractVersions.agentJobDispatch,
    role: "coding-agent",
    workItemId: codingWorkItem.workItemId,
    workflowId: codingWorkItem.workflowId,
    baseSha: codingWorkItem.baseSha,
    summary: codingWorkItem.summary,
    codingRequest: request,
    codingRound: 1,
  };
  assert.deepEqual(
    agentJobDispatchRequestSchema.parse(initialDispatch),
    initialDispatch,
  );
  const legacyRequest = {
    ...request,
    version: "codeops.coding-request/v2",
  };
  delete legacyRequest.planeWorkItem;
  assert.deepEqual(codingRequestSchema.parse(legacyRequest), legacyRequest);
  assert.deepEqual(
    agentJobDispatchRequestSchema.parse({
      ...initialDispatch,
      version: "codeops.agent-job-dispatch/v1",
      codingRequest: legacyRequest,
    }).version,
    "codeops.agent-job-dispatch/v1",
  );
  assert.throws(() =>
    agentJobDispatchRequestSchema.parse({
      ...initialDispatch,
      version: "codeops.agent-job-dispatch/v1",
    }),
  );
  const candidate = {
    ...makeAdversarialReview().candidate,
    round: 1,
  };
  const adoptedPublication = {
    version: contractVersions.candidatePublication,
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    workItemId: codingWorkItem.workItemId,
    workflowId: codingWorkItem.workflowId,
    repository: codingWorkItem.repository,
    pullRequestNumber: adoptedPullRequest.pullRequestNumber,
    expectedHeadSha: adoptedPullRequest.headSha,
    headRef: adoptedPullRequest.headRef,
    adoptedPullRequest,
    candidate,
    commitMessage: "Address CodeOps review of PR #158",
  };
  assert.deepEqual(
    candidatePublicationSchema.parse(adoptedPublication),
    adoptedPublication,
  );
  assert.throws(() =>
    candidatePublicationSchema.parse({
      ...adoptedPublication,
      humanReview: humanReviewRequest.humanReview,
    }),
  );
  const review = makeAdversarialReview({
    workflowId: codingWorkItem.workflowId,
    workItemId: codingWorkItem.workItemId,
    baseSha: codingWorkItem.baseSha,
    candidate,
    verdict: "revision-required",
    lenses: {
      ...makeAdversarialReview().lenses,
      ticketCompletion: {
        status: "finding",
        summary: "One bounded acceptance requirement remains.",
      },
    },
    findings: [{
      id: "ticket-gap",
      category: "ticket-completion",
      severity: "medium",
      path: "sites/app/lib/auth.ts",
      problem: "One accepted route is not implemented.",
      impact: "The ticket is incomplete.",
      recommendation: "Implement and test the missing route.",
      resolution: "must-fix",
    }],
    summary: "One bounded revision is required.",
  });
  const criticDispatch = {
    version: contractVersions.agentJobDispatch,
    role: "critic-agent",
    workItemId: codingWorkItem.workItemId,
    workflowId: codingWorkItem.workflowId,
    baseSha: codingWorkItem.baseSha,
    summary: codingWorkItem.summary,
    codingRequest: request,
    codingRound: 1,
    candidate,
  };
  assert.deepEqual(
    agentJobDispatchRequestSchema.parse(criticDispatch),
    criticDispatch,
  );
  const revisionDispatch = {
    ...initialDispatch,
    codingRound: 2,
    revision: { candidate, review },
  };
  assert.deepEqual(
    agentJobDispatchRequestSchema.parse(revisionDispatch),
    revisionDispatch,
  );
  assert.throws(() =>
    agentJobDispatchRequestSchema.parse({
      ...revisionDispatch,
      codingRound: 3,
    }),
  );
  assert.throws(() =>
    agentJobDispatchRequestSchema.parse({
      ...revisionDispatch,
      revision: {
        candidate,
        review: {
          ...review,
          candidate: {
            ...candidate,
            patch: {
              ...candidate.patch,
              digest: `sha256:${"f".repeat(64)}`,
            },
          },
        },
      },
    }),
  );
  assert.throws(() =>
    codingRequestSchema.parse({
      ...request,
      workItem: { ...codingWorkItem, workflowId: "coding-drift" },
    }),
  );
  assert.throws(() =>
    codingRequestSchema.parse({
      ...request,
      ticketSnapshot: {
        ...request.ticketSnapshot,
        workItemId: "65d934ab-0c15-46aa-a3b7-f55125542fa3",
      },
    }),
  );
  assert.throws(() =>
    codingRequestSchema.parse({ ...request, transcript: "raw agent state" }),
  );
  assert.throws(() =>
    codingRequestSchema.parse({
      ...request,
      projectContext: {
        ...request.projectContext,
        documents: [
          {
            ...request.projectContext.documents[0],
            digest: `sha256:${"f".repeat(64)}`,
          },
        ],
      },
    }),
  );
  assert.throws(() =>
    codingRequestSchema.parse({
      ...request,
      researchPacket: {
        ...request.researchPacket,
        projectContextDigest: `sha256:${"e".repeat(64)}`,
      },
    }),
  );
});

test("accepts every workflow state with deterministic logical IDs", () => {
  for (const state of workflowStateSchema.options) {
    const transitionKey = `sequence-${state}`;
    const transitionId = createTransitionId({
      workflowId: "workflow-123",
      transitionKey,
    });
    const eventId = createEventId({
      workflowId: "workflow-123",
      transitionId,
    });
    const event = {
      version: contractVersions.event,
      eventId,
      transitionId,
      transitionKey,
      workflowId: "workflow-123",
      runId: "run-123",
      workItemId: "plane:2fdebb4c",
      state,
      baseSha: sha,
      occurredAt: now,
      summary: `Entered ${state}`,
      evidence: [evidence],
    };
    assert.equal(workflowEventSchema.parse(event).state, state);
  }
});

test("defines one fixed lifecycle profile with review separate from attention", () => {
  const profile = {
    version: contractVersions.lifecycleProfile,
    phases: [
      "backlog",
      "ready",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
    ],
    reviewRequired: true,
  };
  assert.deepEqual(lifecycleProfileSchema.parse(profile), profile);
  assert.deepEqual(
    lifecycleStateSchema.parse({ phase: "in_review", attention: "needed" }),
    { phase: "in_review", attention: "needed" },
  );
  assert.throws(() =>
    lifecycleStateSchema.parse({ phase: "done", attention: "needed" }),
  );
  assert.throws(() =>
    lifecycleProfileSchema.parse({
      ...profile,
      phases: profile.phases.filter((phase) => phase !== "in_review"),
    }),
  );
});

test("maps many provider states to one CodeOps state without ambiguity", () => {
  const binding = {
    version: contractVersions.providerLifecycleBinding,
    provider: "plane",
    workspaceId: "workspace_123",
    projectId: "project_456",
    states: [
      {
        providerStateId: "review",
        codeopsState: "in_review",
        preferredForProjection: true,
      },
      {
        providerStateId: "qa",
        codeopsState: "in_review",
        preferredForProjection: false,
      },
      {
        providerStateId: "security_review",
        codeopsState: "in_review",
        preferredForProjection: false,
      },
      {
        providerStateId: "blocked",
        codeopsState: "needs_attention",
        preferredForProjection: true,
      },
    ],
  };
  assert.deepEqual(providerLifecycleBindingSchema.parse(binding), binding);
  for (const provider of ["github_issues", "github_projects", "custom"]) {
    assert.throws(() =>
      providerLifecycleBindingSchema.parse({ ...binding, provider }),
    );
  }
  assert.throws(() =>
    providerLifecycleBindingSchema.parse({
      ...binding,
      states: [
        ...binding.states,
        {
          providerStateId: "qa",
          codeopsState: "needs_attention",
          preferredForProjection: false,
        },
      ],
    }),
  );
  assert.throws(() =>
    providerLifecycleBindingSchema.parse({
      ...binding,
      states: binding.states.map((state) => ({
        ...state,
        preferredForProjection: false,
      })),
    }),
  );
  assert.throws(() =>
    providerLifecycleBindingSchema.parse({
      ...binding,
      states: binding.states.map((state) => ({
        ...state,
        preferredForProjection:
          state.codeopsState === "in_review" ? true : state.preferredForProjection,
      })),
    }),
  );
});

test("binds a deterministic immutable event to one lifecycle aggregate revision", () => {
  const transitionId = createTransitionId({
    version: contractVersions.workItemLifecycleEvent,
    workflowId: "workflow-123",
    transitionKey: "lifecycle-ready",
  });
  const event = {
    version: contractVersions.workItemLifecycleEvent,
    eventId: createEventId({
      version: contractVersions.workItemLifecycleEvent,
      workflowId: "workflow-123",
      transitionId,
    }),
    transitionId,
    transitionKey: "lifecycle-ready",
    command: "register",
    repository: { owner: "anulman", name: "codeops" },
    provider: {
      kind: "plane",
      workspaceId: "workspace_123",
      projectId: "project_456",
    },
    workItemId: "work_item_789",
    workflowId: "workflow-123",
    runId: "run-123",
    sequence: 1,
    previousState: null,
    state: { phase: "ready", attention: "clear" },
    sourceSha: sha,
    occurredAt: now,
    summary: "The admitted work item is ready.",
    evidence: [],
  };
  assert.deepEqual(workItemLifecycleEventSchema.parse(event), event);
  assert.throws(() =>
    workItemLifecycleEventSchema.parse({ ...event, sequence: 2 }),
  );
  assert.throws(() =>
    workItemLifecycleEventSchema.parse({
      ...event,
      sequence: 2,
      previousState: event.state,
    }),
  );
  assert.throws(() =>
    workItemLifecycleEventSchema.parse({
      ...event,
      eventId: createEventId({
        version: contractVersions.workItemLifecycleEvent,
        workflowId: "workflow-123",
        transitionId: "transition:wrong",
      }),
    }),
  );
  assert.throws(() =>
    workItemLifecycleEventSchema.parse({
      ...event,
      command: "approve_review",
    }),
  );
});

test("keeps normal review transitions separate from the attention condition", () => {
  function eventFor({ command, transitionKey, sequence, previousState, state }) {
    const transitionId = createTransitionId({
      version: contractVersions.workItemLifecycleEvent,
      workflowId: "workflow-review",
      transitionKey,
    });
    return {
      version: contractVersions.workItemLifecycleEvent,
      eventId: createEventId({
        version: contractVersions.workItemLifecycleEvent,
        workflowId: "workflow-review",
        transitionId,
      }),
      transitionId,
      transitionKey,
      command,
      repository: { owner: "anulman", name: "codeops" },
      provider: {
        kind: "plane",
        workspaceId: "workspace_123",
        projectId: "project_456",
      },
      workItemId: "work_item_review",
      workflowId: "workflow-review",
      runId: "run-review",
      sequence,
      previousState,
      state,
      sourceSha: sha,
      occurredAt: now,
      summary: `Applied ${command}.`,
      evidence: [],
    };
  }
  const inProgress = { phase: "in_progress", attention: "clear" };
  const inReview = { phase: "in_review", attention: "clear" };
  assert.equal(
    workItemLifecycleEventSchema.parse(eventFor({
      command: "request_review",
      transitionKey: "request-review",
      sequence: 2,
      previousState: inProgress,
      state: inReview,
    })).state.phase,
    "in_review",
  );
  const attention = { phase: "in_review", attention: "needed" };
  assert.equal(
    workItemLifecycleEventSchema.parse(eventFor({
      command: "request_attention",
      transitionKey: "request-attention",
      sequence: 3,
      previousState: inReview,
      state: attention,
    })).state.attention,
    "needed",
  );
  assert.equal(
    workItemLifecycleEventSchema.parse(eventFor({
      command: "resolve_attention",
      transitionKey: "resolve-attention",
      sequence: 4,
      previousState: attention,
      state: inReview,
    })).state.phase,
    "in_review",
  );
  assert.throws(() =>
    workItemLifecycleEventSchema.parse(eventFor({
      command: "request_changes",
      transitionKey: "invalid-attention-as-review",
      sequence: 3,
      previousState: inReview,
      state: attention,
    })),
  );
});

test("accepts every control command and all result states", () => {
  const commands = [
    command("attach", { fromSequence: 0 }),
    command("status", {}),
    command("follow_up", { message: "Run the focused matrix again." }),
    command("cancel", { reason: "Superseded by a reviewed request." }),
    command("permission_response", {
      requestId: "permission-1",
      decision: "approve",
      reason: "Scoped and expected.",
    }),
  ];
  for (const value of commands) assert.equal(controlCommandSchema.parse(value).type, value.type);

  for (const status of ["accepted", "applied", "duplicate", "rejected"]) {
    assert.equal(
      controlResultSchema.parse({
        version: contractVersions.controlResult,
        commandId: "command-status",
        workflowId: "workflow-123",
        runId: "run-123",
        status,
        recordedAt: now,
      }).status,
      status,
    );
  }
});

test("canonical serialization and logical IDs are stable and order-independent", () => {
  const value = {
    z: 1,
    unicode: "é😀\n",
    array: [3, null, true],
    a: { y: 2, x: 3 },
  };
  const expectedText =
    '{"a":{"x":3,"y":2},"array":[3,null,true],"unicode":"é😀\\n","z":1}';
  assert.equal(canonicalJsonText(value), expectedText);
  assert.deepEqual(
    canonicalJsonBytes(value),
    Uint8Array.from(Buffer.from(
      "7b2261223a7b2278223a332c2279223a327d2c226172726179223a5b332c6e756c6c2c747275655d2c22756e69636f6465223a2265cc81f09f98805c6e222c227a223a317d",
      "hex",
    )),
  );
  assert.equal(
    sha256CanonicalJsonDigest(value),
    "sha256:f02a7e21795ca73d58f07b0806759e1c71152c0ba60dba4ac6ac0e577b969d98",
  );
  assert.equal(
    canonicalSerialize({ z: 1, a: { y: 2, x: 3 } }),
    canonicalSerialize({ a: { x: 3, y: 2 }, z: 1 }),
  );
  assert.equal(canonicalSerialize(value), canonicalJsonText(value));
  const sparse = ["first", "third"];
  delete sparse[1];
  const symbolArray = [];
  symbolArray[Symbol("hidden")] = "value";
  const cycle = {};
  cycle.self = cycle;
  for (const invalid of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1n,
    Symbol("invalid"),
    () => undefined,
    { invalid: undefined },
    [undefined],
    sparse,
    symbolArray,
    cycle,
    new Date("2026-08-15T00:00:00Z"),
    new Map(),
    Object.assign(Object.create({ inherited: true }), { value: 1 }),
    { [Symbol("hidden")]: "value" },
  ]) {
    assert.throws(() => canonicalJsonText(invalid), TypeError);
  }
  const first = createTransitionId({ workflowId: "workflow-123", transitionKey: "sequence-1" });
  const retry = createTransitionId({ transitionKey: "sequence-1", workflowId: "workflow-123" });
  const next = createTransitionId({ workflowId: "workflow-123", transitionKey: "sequence-2" });
  assert.equal(first, retry);
  assert.equal(
    first,
    "transition:063d681424122ce5f7658e8128791dbf542d5d5e249762f93dfba4b4cffdf02e",
  );
  assert.notEqual(first, next);
  assert.equal(
    createEventId({ workflowId: "workflow-123", transitionId: first }),
    createEventId({ workflowId: "workflow-123", transitionId: first }),
  );
  assert.equal(
    createEventId({ workflowId: "workflow-123", transitionId: first }),
    "event:22057186e0433555f72098411ed77baba29f8d6c2d7ab81bca0e19a1fde97857",
  );
  assert.notEqual(
    createEventId({ workflowId: "workflow-123", transitionId: first }),
    createEventId({ workflowId: "workflow-123", transitionId: next }),
  );
});

test("rejects unknown versions, fields, states, commands, and malformed identifiers", () => {
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, version: "codeops.work-item/v2" }));
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, transcript: "raw transcript" }));
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, baseSha: "8f3d2c0" }));
  for (const branch of ["../main", ".", "-bad", "good/.hidden", "good.", "good.lock", "HEAD"]) {
    assert.throws(() => workItemRequestSchema.parse({ ...workItem, branch }));
  }
  assert.equal(
    workItemRequestSchema.parse({ ...workItem, branch: "release/v1.2.3" }).branch,
    "release/v1.2.3",
  );
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, runId: "../run" }));
  assert.throws(() => workflowStateSchema.parse("running"));
  assert.throws(() => controlCommandSchema.parse(command("deploy", {})));
  assert.throws(() => controlCommandSchema.parse({ ...command("status", {}), unexpected: true }));
});

test("rejects an unknown version at every contract boundary", () => {
  const transitionKey = "sequence-requested";
  const transitionId = createTransitionId({ workflowId: "workflow-123", transitionKey });
  const event = {
    version: contractVersions.event,
    eventId: createEventId({ workflowId: "workflow-123", transitionId }),
    transitionId,
    transitionKey,
    workflowId: "workflow-123",
    runId: "run-123",
    workItemId: "plane:2fdebb4c",
    state: "requested",
    baseSha: sha,
    occurredAt: now,
    summary: "Requested.",
    evidence: [],
  };
  const result = {
    version: contractVersions.controlResult,
    commandId: "command-status",
    workflowId: "workflow-123",
    runId: "run-123",
    status: "accepted",
    recordedAt: now,
  };

  for (const [schema, value] of [
    [secretReferenceSchema, secretReference],
    [evidenceReferenceSchema, evidence],
    [workflowEventSchema, event],
    [controlCommandSchema, command("status", {})],
    [controlResultSchema, result],
  ]) {
    assert.throws(() => schema.parse({ ...value, version: "codeops.unknown/v2" }));
  }
});

test("rejects inline secrets and transcript/workspace blobs", () => {
  assert.throws(() =>
    secretReferenceSchema.parse({ ...secretReference, value: "super-secret-material" }),
  );
  assert.throws(() =>
    workItemRequestSchema.parse({
      ...workItem,
      secretReferences: [{ ...secretReference, token: "secret-token" }],
    }),
  );
  assert.throws(() => controlCommandSchema.parse(command("follow_up", { message: "x", apiKey: "x" })));
  assert.throws(() => workItemRequestSchema.parse({ ...workItem, workspaceArchive: "blob" }));
});

test("rejects unsafe evidence locations and oversized fields", () => {
  assert.deepEqual(evidenceReferenceSchema.parse(evidence), evidence);
  for (const uri of [
    "http://artifacts.example/report.json",
    "https://user:password@artifacts.example/report.json",
    "https://artifacts.example/report.json?token=secret",
    "file:///workspace/secret",
    "javascript:alert(1)",
    "s3://bucket",
    "artifact://other-host/report.json",
  ]) {
    assert.throws(() => evidenceReferenceSchema.parse({ ...evidence, uri }));
  }
  assert.throws(() => evidenceReferenceSchema.parse({ ...evidence, sizeBytes: 1_000_000_001 }));
  assert.throws(() =>
    workItemRequestSchema.parse({
      ...workItem,
      acceptanceCriteria: ["x".repeat(2_001)],
    }),
  );
  assert.throws(() =>
    controlCommandSchema.parse(command("follow_up", { message: "x".repeat(8_001) })),
  );
});

test("rejects event IDs that do not match the logical transition", () => {
  const transitionKey = "sequence-complete";
  const transitionId = createTransitionId({ workflowId: "workflow-123", transitionKey });
  assert.throws(() =>
    workflowEventSchema.parse({
      version: contractVersions.event,
      eventId: createEventId({ workflowId: "workflow-123", transitionId: "transition:wrong" }),
      transitionId,
      transitionKey,
      workflowId: "workflow-123",
      runId: "run-123",
      workItemId: "plane:2fdebb4c",
      state: "completed",
      baseSha: sha,
      occurredAt: now,
      summary: "Complete.",
      evidence: [],
    }),
  );
});

const planeCommentEvent = {
  version: contractVersions.planeCommentEvent,
  deliveryId: "f819eff4-cd50-4987-bc97-e5be1e04c94f",
  eventId: "0afa042d-92a9-4326-bdca-5ff5490dbf09",
  action: "create",
  workspaceId: "d2d97c94-a6ad-4012-b526-5577c0d7c769",
  projectId: "b32e004b-3638-4bd3-972f-c5d3fac53dd3",
  workItemId: "e1c25c66-5bb8-465e-a818-92a483423443",
  commentId: "f3e29f26-708d-40f0-9209-7e0de44abc49",
  actor: {
    id: "16c61a3a-512a-48ac-b0be-b6b46fe6f430",
    kind: "human",
  },
  comment:
    "@ai-security @ai-web @ai-database Research the canonical auth state matrix.",
  occurredAt: now,
};

const researchSource = {
  repository: { owner: "example-org", name: "example-repository" },
  controlPlaneSha: sha,
  baseSha: sha,
  planeRevisionDigest: `sha256:${"b".repeat(64)}`,
  projectContext: makeProjectContext(
    planeCommentEvent.workspaceId,
    planeCommentEvent.projectId,
  ),
  ticketSnapshot: makeTicketSnapshot(planeCommentEvent.workItemId),
  defaultBrief: "Inventory canonical auth states from the Plane ticket.",
};

test("admits registered persona mentions only from a new human comment", () => {
  const request = createResearchRequestFromPlaneComment(
    planeCommentEvent,
    researchSource,
  );
  assert.equal(request.workItemId, planeCommentEvent.workItemId);
  assert.equal(request.requestedBy, planeCommentEvent.actor.id);
  assert.deepEqual(request.personas, [
    "@ai-security",
    "@ai-web",
    "@ai-database",
  ]);
  assert.equal(request.brief, "Research the canonical auth state matrix.");
  assert.equal(
    createResearchRequestFromPlaneComment(
      {
        ...planeCommentEvent,
        deliveryId: "01ab9316-f978-4449-bad6-dce958be8454",
      },
      researchSource,
    ).requestId,
    request.requestId,
  );
  assert.equal(
    createResearchRequestFromPlaneComment(
      { ...planeCommentEvent, comment: "/research" },
      researchSource,
    ),
    null,
  );
  assert.equal(
    createResearchRequestFromPlaneComment(
      { ...planeCommentEvent, comment: "@ai-unknown investigate this" },
      researchSource,
    ),
    null,
  );
  assert.deepEqual(
    createResearchRequestFromPlaneComment(
      {
        ...planeCommentEvent,
        comment: "@ai-web @ai-web",
      },
      researchSource,
    ).personas,
    ["@ai-web"],
  );
  assert.equal(
    createResearchRequestFromPlaneComment(
      {
        ...planeCommentEvent,
        comment: "@ai-product",
      },
      researchSource,
    ).brief,
    researchSource.defaultBrief,
  );
  assert.equal(
    createResearchRequestFromPlaneComment(
      { ...planeCommentEvent, action: "update" },
      researchSource,
    ),
    null,
  );
  assert.equal(
    createResearchRequestFromPlaneComment(
      { ...planeCommentEvent, actor: { ...planeCommentEvent.actor, kind: "service" } },
      researchSource,
    ),
    null,
  );
  assert.throws(() =>
    planeCommentEventSchema.parse({ ...planeCommentEvent, actor: { kind: "human" } }),
  );
});

test("binds the model classifier to one strict Plane intent", () => {
  for (const intent of [
    "ignore",
    "research",
    "response",
    "source_change",
    "steering",
  ]) {
    assert.deepEqual(planeCommentRequestClassificationSchema.parse({ intent }), {
      intent,
    });
  }
  assert.throws(() =>
    planeCommentRequestClassificationSchema.parse({
      intent: "source-change",
    }),
  );
  assert.throws(() =>
    planeCommentRequestClassificationSchema.parse({
      intent: "research",
      confidence: 0.9,
    }),
  );
});

test("creates one deterministic Agent Session request for actionable comments", () => {
  const sourceChange = createPlaneSessionRequestFromPlaneComment(
    { ...planeCommentEvent, comment: "Please fix the stale lifecycle gate." },
    researchSource,
    { intent: "source_change" },
  );
  assert.equal(sourceChange.intent, "source_change");
  assert.deepEqual(sourceChange.personas, []);
  const retry = createPlaneSessionRequestFromPlaneComment(
    {
      ...planeCommentEvent,
      deliveryId: "01ab9316-f978-4449-bad6-dce958be8454",
      comment: "Please fix the stale lifecycle gate.",
    },
    researchSource,
    { intent: "source_change" },
  );
  assert.equal(retry.requestId, sourceChange.requestId);
  assert.equal(
    createPlaneSessionRequestFromPlaneComment(
      { ...planeCommentEvent, comment: "Thanks, this is useful." },
      researchSource,
      { intent: "ignore" },
    ),
    null,
  );
});

test("binds strict Agent Job dispatch and result identities", () => {
  const request = createResearchRequestFromPlaneComment(
    planeCommentEvent,
    researchSource,
  );
  const dispatch = {
    version: contractVersions.agentJobDispatch,
    workItemId: request.workItemId,
    workflowId: request.requestId,
    baseSha: request.baseSha,
    summary: "Research the canonical authentication matrix.",
    role: "qa-contract-researcher",
    researchRequest: request,
    researchStage: { kind: "persona", persona: "@ai-security" },
  };
  assert.deepEqual(agentJobDispatchRequestSchema.parse(dispatch), dispatch);
  assert.throws(() =>
    agentJobDispatchRequestSchema.parse({
      ...dispatch,
      researchStage: { kind: "persona", persona: "@ai-ml" },
    }),
  );
  assert.throws(() =>
    agentJobDispatchRequestSchema.parse({
      ...dispatch,
      baseSha: "a".repeat(40),
    }),
  );
  const result = {
    version: contractVersions.agentJobDispatchResult,
    role: "qa-contract-researcher",
    runId: "research-123",
    checkpointUri:
      "artifact:///agent-runs/research-123/checkpoint.json",
    checkpointDigest: `sha256:${"c".repeat(64)}`,
    checkpointSizeBytes: 123,
    patchUri: "artifact:///agent-runs/research-123/changes.patch",
    patchDigest: `sha256:${"d".repeat(64)}`,
    patchSizeBytes: 0,
    researchResult: {
      kind: "persona",
      report: {
        version: contractVersions.researchPersonaReport,
        requestId: request.requestId,
        persona: "@ai-security",
        outcome: "findings",
        summary: "Authentication boundaries need qualification.",
        findings: [],
        decisions: [],
        citations: [],
      },
    },
  };
  assert.deepEqual(agentJobDispatchResultSchema.parse(result), result);
  assert.throws(() =>
    agentJobDispatchResultSchema.parse({
      ...result,
      checkpointUri: "file:///checkpoint.json",
    }),
  );
});

test("verifies Plane webhook signatures over the exact raw body", () => {
  const secret = "plane-webhook-secret";
  const rawBody = JSON.stringify({ event: "issue_comment", action: "create" });
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
  assert.equal(
    verifyPlaneWebhookSignature({ secret, rawBody, signature }),
    true,
  );
  assert.equal(
    verifyPlaneWebhookSignature({
      secret,
      rawBody: `${rawBody}\n`,
      signature,
    }),
    false,
  );
  assert.equal(
    verifyPlaneWebhookSignature({ secret: "", rawBody, signature }),
    false,
  );
  assert.equal(
    verifyPlaneWebhookSignature({ secret, rawBody, signature: "invalid" }),
    false,
  );
});

test("the research mutation contract cannot express lifecycle state changes", () => {
  const comment = {
    type: "comment.create",
    targetWorkItemId: planeCommentEvent.workItemId,
    bodyHtml: "<p>Research packet ready.</p>",
    attachments: [],
  };
  assert.deepEqual(researchPlaneMutationSchema.parse(comment), comment);
  const descriptionUpdate = {
    type: "ticket.update",
    targetWorkItemId: planeCommentEvent.workItemId,
    changes: { descriptionHtml: "<p>Refined description.</p>" },
  };
  assert.deepEqual(
    researchPlaneMutationSchema.parse(descriptionUpdate),
    descriptionUpdate,
  );
  const taskUpsert = {
    type: "task.upsert",
    key: "otp-rate-limit",
    targetWorkItemId: null,
    expectedDescriptionDigest: null,
    name: "Bound OTP verification attempts",
    descriptionHtml:
      "<p>Evidence-backed task.</p><p><code>[codeops-research-task:otp-rate-limit]</code></p>",
  };
  assert.deepEqual(researchPlaneMutationSchema.parse(taskUpsert), taskUpsert);
  assert.throws(() =>
    researchPlaneMutationSchema.parse({
      type: "ticket.cancel-proposal",
      targetWorkItemId: planeCommentEvent.workItemId,
      reason: "Superseded.",
    }),
  );
  assert.throws(() =>
    researchPlaneMutationSchema.parse({
      type: "ticket.update",
      targetWorkItemId: planeCommentEvent.workItemId,
      changes: { stateId: "cc8562ab-79c7-4f1c-b4a2-1ed51dfcd6aa" },
    }),
  );
  assert.throws(() =>
    researchPlaneMutationSchema.parse({
      type: "state.update",
      targetWorkItemId: planeCommentEvent.workItemId,
      state: "Ready",
    }),
  );
  assert.throws(() =>
    researchPlaneMutationSchema.parse({
      type: "ticket.cancel",
      targetWorkItemId: planeCommentEvent.workItemId,
    }),
  );
  assert.ok(qaContractResearcherPolicy.forbiddenMutationTypes.includes("state.update"));
  assert.ok(qaContractResearcherPolicy.allowedMutationTypes.includes("task.upsert"));
  assert.ok(qaContractResearcherPolicy.forbiddenMutationTypes.includes("ticket.create"));
});

test("research packets bind evidence and mutations to one source request", () => {
  const request = createResearchRequestFromPlaneComment(
    planeCommentEvent,
    researchSource,
  );
  const video = {
    ...evidence,
    kind: "video",
    uri: "artifact:///runs/research-1/current-behavior.mp4",
    mediaType: "video/mp4",
  };
  const proposedMutations = {
    version: contractVersions.researchMutationBatch,
    requestId: request.requestId,
    projectId: request.projectId,
    sourceWorkItemId: request.workItemId,
    mutations: [
      {
        type: "ticket.update",
        targetWorkItemId: request.workItemId,
        changes: { descriptionHtml: "<p>Refined description.</p>" },
      },
      {
        type: "comment.create",
        targetWorkItemId: request.workItemId,
        bodyHtml: "<p>Research packet v1</p>",
        attachments: [video],
      },
    ],
  };
  assert.deepEqual(
    researchMutationBatchSchema.parse(proposedMutations),
    proposedMutations,
  );
  const packet = {
    version: contractVersions.researchPacket,
    personas: request.personas,
    perspectives: request.personas.map((persona) => ({
      persona,
      outcome:
        persona === "@ai-database" ? "no-additional-findings" : "findings",
      summary:
        persona === "@ai-database"
          ? "No database findings beyond the shared inventory."
          : `${persona} completed its bounded review.`,
    })),
    requestId: request.requestId,
    projectId: request.projectId,
    workItemId: request.workItemId,
    baseSha: request.baseSha,
    projectContextDigest: request.projectContext.digest,
    planeRevisionDigest: request.planeRevisionDigest,
    summary: "Current and expected routing behavior are documented.",
    synthesis: {
      ...makeSynthesis(request.requestId),
      topFindings: [
        {
          id: "finding-1",
          category: "matrix-fact",
          severity: "high",
          confidence: "high",
          currentBehavior: "Wrong-file cookies reach the public claim route.",
          expectedBehavior: "Wrong-file cookies reveal no private file state.",
          citationIds: ["citation-1"],
        },
      ],
    },
    currentBehavior: ["Wrong-file cookies reach the public claim route."],
    expectedBehavior: ["Wrong-file cookies reveal no private file state."],
    evidence: [video],
    decisions: [],
    proposedMutations,
    createdAt: now,
  };
  assert.deepEqual(researchPacketSchema.parse(packet), packet);
  assert.deepEqual(
    researchPacketSchema.parse({ ...packet, evidence: [] }).evidence,
    [],
  );
  assert.equal(
    researchPacketSchema.parse({
      ...packet,
      evidence: [],
      videoNotApplicableReason: "This ticket changes only a schema contract.",
    }).videoNotApplicableReason,
    "This ticket changes only a schema contract.",
  );
  assert.throws(() =>
    researchPacketSchema.parse({
      ...packet,
      proposedMutations: {
        ...proposedMutations,
        sourceWorkItemId: "acba7524-61e7-41a7-a2f6-083667016d3f",
      },
    }),
  );
  assert.throws(() =>
    researchPacketSchema.parse({
      ...packet,
      perspectives: packet.perspectives.slice(1),
    }),
  );
});

test("compiles applicability-aware readiness gates without adding Plane lifecycle states", () => {
  const identity = {
    version: contractVersions.readinessGate,
    projectId: planeCommentEvent.projectId,
    workItemId: planeCommentEvent.workItemId,
    repository: researchSource.repository,
    baseSha: researchSource.baseSha,
    planeRevisionDigest: researchSource.planeRevisionDigest,
    evaluatedAt: now,
    policy: "qa-ticket-readiness/v1",
    objective: "Establish the contract needed to perform the work.",
    expectedOutcome: "The ticket is actionable without inventing product behavior.",
  };
  const requiredSatisfied = {
    id: "intent-and-outcome",
    category: "intent",
    requirement: "required",
    applicability: "applicable",
    status: "satisfied",
    rationale: "Every ticket needs a bounded objective and expected outcome.",
    evidence: [],
  };
  assert.equal(
    readinessGateSchema.parse({
      ...identity,
      profile: "research",
      criteria: [
        requiredSatisfied,
        {
          id: "authoritative-sources",
          category: "source",
          requirement: "required",
          applicability: "applicable",
          status: "satisfied",
          rationale: "The research question depends on repository sources.",
          evidence: [],
        },
        {
          id: "canonical-video",
          category: "video",
          requirement: "recommended",
          applicability: "applicable",
          status: "missing",
          rationale: "A video would help a human review the flow but is not an admission blocker.",
          evidence: [],
        },
      ],
      blockingProductDecisions: 0,
      ready: true,
    }).profile,
    "research",
  );
  const artifact = {
    ...evidence,
    kind: "artifact",
    uri: "artifact:///runs/readiness/contract.json",
    mediaType: "application/json",
  };
  assert.equal(
    readinessGateSchema.parse({
      ...identity,
      profile: "implementation",
      criteria: [
        requiredSatisfied,
        {
          id: "reproduction",
          category: "reproduction",
          requirement: "recommended",
          applicability: "not-applicable",
          status: "not-applicable",
          rationale: "This is a new capability, not a defect claim.",
          evidence: [],
        },
        {
          id: "fixture",
          category: "fixture",
          requirement: "recommended",
          applicability: "applicable",
          status: "missing",
          rationale: "A fixture would improve repeatability, but this documentation-only change does not depend on controlled state.",
          evidence: [],
        },
      ],
      blockingProductDecisions: 0,
      ready: true,
    }).profile,
    "implementation",
  );
  assert.equal(
    readinessGateSchema.parse({
      ...identity,
      profile: "qualification",
      criteria: [
        requiredSatisfied,
        {
          id: "candidate-provenance",
          category: "provenance",
          requirement: "required",
          applicability: "applicable",
          status: "satisfied",
          rationale: "The qualification verdict must bind an exact candidate.",
          evidence: [artifact],
        },
      ],
      blockingProductDecisions: 0,
      ready: true,
    }).profile,
    "qualification",
  );
  assert.throws(() =>
    readinessGateSchema.parse({
      ...identity,
      profile: "implementation",
      criteria: [requiredSatisfied],
      blockingProductDecisions: 1,
      ready: true,
    }),
  );
  assert.throws(() =>
    readinessGateSchema.parse({
      ...identity,
      profile: "implementation",
      criteria: [
        requiredSatisfied,
        {
          id: "expected-flow",
          category: "expected-behavior",
          requirement: "required",
          applicability: "applicable",
          status: "missing",
          rationale: "The implementation would otherwise invent product behavior.",
          evidence: [],
        },
      ],
      blockingProductDecisions: 0,
      ready: true,
    }),
  );
  assert.throws(() =>
    readinessGateSchema.parse({
      ...identity,
      profile: "implementation",
      criteria: [
        requiredSatisfied,
        {
          id: "reproduction",
          category: "reproduction",
          requirement: "recommended",
          applicability: "not-applicable",
          status: "missing",
          rationale: "Applicability and status disagree.",
          evidence: [],
        },
      ],
      blockingProductDecisions: 0,
      ready: true,
    }),
  );
});

test("binds native GitHub stacks to one exact linear pull-request chain", () => {
  assert.deepEqual(
    githubPullRequestStackPositionSchema.parse({
      number: 42,
      size: 2,
      position: 2,
      base: { ref: "main", sha },
    }),
    {
      number: 42,
      size: 2,
      position: 2,
      base: { ref: "main", sha },
    },
  );
  assert.equal(
    githubPullRequestStackSnapshotSchema.parse({
      version: contractVersions.githubPullRequestStackSnapshot,
      repository: "example-org/example-repository",
      number: 42,
      baseRef: "main",
      open: true,
      pullRequests: [
        {
          number: 155,
          state: "open",
          draft: true,
          mergedAt: null,
          head: { ref: "feat/base", sha: "a".repeat(40) },
          base: { ref: "main", sha },
        },
        {
          number: 158,
          state: "open",
          draft: false,
          mergedAt: null,
          head: { ref: "feat/child", sha: "b".repeat(40) },
          base: { ref: "feat/base", sha: "a".repeat(40) },
        },
      ],
    }).pullRequests.length,
    2,
  );
  assert.equal(
    githubPullRequestStackLinkSchema.parse({
      version: contractVersions.githubPullRequestStackLink,
      repository: { owner: "example-org", name: "example-repository" },
      parent: {
        number: 155,
        headSha: "a".repeat(40),
        headRef: "feat/base",
        baseRef: "main",
      },
      child: {
        number: 158,
        headSha: "b".repeat(40),
        headRef: "feat/child",
        baseRef: "feat/base",
      },
    }).child.number,
    158,
  );
  assert.throws(() =>
    githubPullRequestStackLinkSchema.parse({
      version: contractVersions.githubPullRequestStackLink,
      repository: { owner: "example-org", name: "example-repository" },
      parent: {
        number: 155,
        headSha: "a".repeat(40),
        headRef: "feat/base",
        baseRef: "main",
      },
      child: {
        number: 158,
        headSha: "b".repeat(40),
        headRef: "feat/child",
        baseRef: "main",
      },
    }),
  );
});
