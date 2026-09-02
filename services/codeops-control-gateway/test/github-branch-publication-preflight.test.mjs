import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJsonText,
  sessionPermissionOperationSchema,
  sha256CanonicalJsonDigest,
} from "@codeops/codeops-contracts";
import {
  GITHUB_BRANCH_PUBLICATION_BODY_BYTES,
  GITHUB_BRANCH_PUBLICATION_CHANGED_PATHS,
  GITHUB_BRANCH_PUBLICATION_CONCURRENCY,
  GITHUB_BRANCH_PUBLICATION_DEADLINE_MS,
  GITHUB_BRANCH_PUBLICATION_READ_TIMEOUT_MS,
  GITHUB_BRANCH_PUBLICATION_READ_WAVE_MS,
  GITHUB_BRANCH_PUBLICATION_SAFETY_MARGIN_MS,
  GITHUB_BRANCH_PUBLICATION_WRITE_TIMEOUT_MS,
  GITHUB_BRANCH_PUBLICATION_WRITE_WAVE_MS,
  estimateGitHubBranchPublicationDeadline,
  publicationPlan,
  preflightGitHubBranchPublicationRequest as preflightCandidate,
} from "../dist/github-branch-publication.js";
import { createGitHubMutationAdapter as createFastForwardAdapter } from "../dist/github-branch-fast-forward.js";
import {
  createGitHubMutationAdapter as createCreateAdapter,
  GitHubMutationPreflightNoEffectError,
} from "../dist/github-mutations-adapter.js";
import {
  createGitHubMutationProviderClient,
  executeAuthorizedSessionRuntimeGitHubMutation,
  GitHubMutationProviderNoEffectError,
} from "../dist/session-runtime-github-mutations.js";
import { sessionCapabilitiesFor } from "../dist/session-broker-transitions.js";

function publication(changes, mode = "create") {
  return {
    repository: "example-org/example-repository",
    mode,
    expectedHeadSha: "a".repeat(40),
    ...(mode === "fast_forward"
      ? {
          expectedBranchHeadSha: "b".repeat(40),
          expectedBranchHeadEffectId: `githubmutation-${"c".repeat(64)}`,
        }
      : {}),
    baseBranch: "main",
    branchName: "codeops/candidate",
    commitMessage: "Publish the admitted candidate",
    changes,
  };
}

function preflightGitHubBranchPublicationRequest(input, candidateSizeBytes) {
  const { changes, ...metadata } = input;
  const candidate = {
    version: "codeops.github-branch-publish-candidate/v1",
    changes,
  };
  const sizeBytes = candidateSizeBytes ?? Buffer.byteLength(
    canonicalJsonText(candidate),
  );
  return preflightCandidate({
    ...metadata,
    candidate: {
      manifestId: `githubcandidate-${"d".repeat(64)}`,
      digest: `sha256:${"e".repeat(64)}`,
      sizeBytes,
      chunkCount: Math.ceil(sizeBytes / 65_536),
    },
  }, changes);
}

const newFiles = (count) => Array.from({ length: count }, (_, index) => ({
  path: `proof-${index}.txt`,
  oldText: "",
  newText: `proof-${index}\n`,
}));

test("retains publication timing and capacity contract constants", () => {
  assert.equal(GITHUB_BRANCH_PUBLICATION_CONCURRENCY, 4);
  assert.equal(GITHUB_BRANCH_PUBLICATION_READ_TIMEOUT_MS, 30_000);
  assert.equal(GITHUB_BRANCH_PUBLICATION_WRITE_TIMEOUT_MS, 120_000);
  assert.equal(GITHUB_BRANCH_PUBLICATION_DEADLINE_MS, 230_000);
  assert.equal(GITHUB_BRANCH_PUBLICATION_BODY_BYTES, 4_194_304);
  assert.equal(GITHUB_BRANCH_PUBLICATION_CHANGED_PATHS, 20);
  assert.equal(GITHUB_BRANCH_PUBLICATION_READ_WAVE_MS, 10_000);
  assert.equal(GITHUB_BRANCH_PUBLICATION_WRITE_WAVE_MS, 30_000);
  assert.equal(GITHUB_BRANCH_PUBLICATION_SAFETY_MARGIN_MS, 20_000);
});

test("estimates each sequential phase independently at concurrency four", () => {
  assert.equal(estimateGitHubBranchPublicationDeadline({
    readPhases: [4],
    writePhases: [4],
  }), 60_000);
  assert.equal(estimateGitHubBranchPublicationDeadline({
    readPhases: [5],
    writePhases: [5],
  }), 100_000);
  assert.equal(estimateGitHubBranchPublicationDeadline({
    readPhases: [9],
    writePhases: [12, 1, 1, 1],
  }), GITHUB_BRANCH_PUBLICATION_DEADLINE_MS);
  assert.equal(estimateGitHubBranchPublicationDeadline({
    readPhases: [4, 5],
    writePhases: [4, 5],
  }), 140_000);
});

test("models exact create, fast-forward, and replay request phases", () => {
  const changes = [
    { path: "new.txt", oldText: "", newText: "new\n" },
    { path: "src/old.txt", oldText: "old\n", newText: "new\n" },
  ];
  assert.deepEqual(
    preflightGitHubBranchPublicationRequest(publication(changes)),
    {
      changedPaths: 2,
      serializedBytes: Buffer.byteLength(canonicalJsonText({
        version: "codeops.github-branch-publish-candidate/v1",
        changes,
      })),
      plans: [{
        path: "create",
        readRequests: 7,
        writeRequests: 5,
        readPhases: [3, 1, 1, 1, 1],
        writePhases: [2, 1, 1, 1],
        estimatedDurationMs: 190_000,
      }],
      estimatedDurationMs: 190_000,
    },
  );
  const fastForward = preflightGitHubBranchPublicationRequest(
    publication(changes, "fast_forward"),
  );
  assert.deepEqual(fastForward.plans, [{
    path: "fast_forward",
    readRequests: 8,
    writeRequests: 1,
    readPhases: [4, 1, 1, 1, 1],
    writePhases: [1],
    estimatedDurationMs: 100_000,
  }, {
    path: "replay",
    readRequests: 9,
    writeRequests: 0,
    readPhases: [4, 2, 1, 1, 1],
    writePhases: [],
    estimatedDurationMs: 70_000,
  }]);
  assert.equal(fastForward.estimatedDurationMs, 100_000);
});

test("accepts exactly 230000 ms and rejects the next create write wave", () => {
  const exact = newFiles(12);
  assert.equal(
    preflightGitHubBranchPublicationRequest(publication(exact))
      .estimatedDurationMs,
    GITHUB_BRANCH_PUBLICATION_DEADLINE_MS,
  );
  assert.throws(
    () => preflightGitHubBranchPublicationRequest(publication(newFiles(13))),
    /create estimate exceeds the 230000 ms request deadline/,
  );
});

test("counts unique changed paths and enforces the twenty-path limit", () => {
  assert.equal(
    preflightGitHubBranchPublicationRequest(publication(newFiles(20), "fast_forward"))
      .changedPaths,
    20,
  );
  assert.throws(
    () => preflightGitHubBranchPublicationRequest(publication([
      ...newFiles(1),
      ...newFiles(1),
    ])),
    /unique changed paths/,
  );
  assert.throws(
    () => preflightGitHubBranchPublicationRequest(publication(newFiles(21))),
    /1 to 20 unique changed paths/,
  );
});

test("accepts the candidate size limit and rejects the next byte", () => {
  const request = publication(newFiles(1));
  assert.equal(
    preflightGitHubBranchPublicationRequest(
      request,
      GITHUB_BRANCH_PUBLICATION_BODY_BYTES,
    ).serializedBytes,
    GITHUB_BRANCH_PUBLICATION_BODY_BYTES,
  );
  assert.throws(
    () => preflightGitHubBranchPublicationRequest(
      request,
      GITHUB_BRANCH_PUBLICATION_BODY_BYTES + 1,
    ),
    /exceeds 4194304 bytes/,
  );
});

test("fails closed for invalid estimator counts", () => {
  for (const counts of [
    { readPhases: [-1], writePhases: [] },
    { readPhases: [0.5], writePhases: [] },
    { readPhases: [], writePhases: [Number.MAX_SAFE_INTEGER + 1] },
  ]) {
    assert.throws(
      () => estimateGitHubBranchPublicationDeadline(counts),
      /request counts are invalid/,
    );
  }
});

test("fails closed when safe phase counts overflow derived estimator totals", () => {
  assert.throws(
    () => estimateGitHubBranchPublicationDeadline({
      readPhases: Array(5).fill(Number.MAX_SAFE_INTEGER),
      writePhases: [],
    }),
    /request counts are invalid/,
  );
  assert.throws(
    () => estimateGitHubBranchPublicationDeadline({
      readPhases: [Number.MAX_SAFE_INTEGER],
      writePhases: [],
    }),
    /request counts are invalid/,
  );
});

test("fails closed when publication plan request totals overflow", () => {
  assert.throws(
    () => publicationPlan({
      path: "create",
      readPhases: [Number.MAX_SAFE_INTEGER, 1],
      writePhases: [],
    }),
    /request counts are invalid/,
  );
});

const authority = {
  repository: "example-org/example-repository",
  repositoryUrl: "https://github.com/example-org/example-repository.git",
  readToken: "unused-read-token",
  writeToken: "bounded-write-token",
};

function providerRequest(input) {
  const { changes, ...metadata } = input;
  lastCandidate = { version: "codeops.github-branch-publish-candidate/v1", changes };
  const candidateText = canonicalJsonText(lastCandidate);
  input = {
    ...metadata,
    candidate: {
      manifestId: `githubcandidate-${"f".repeat(64)}`,
      digest: sha256CanonicalJsonDigest(lastCandidate),
      sizeBytes: Buffer.byteLength(candidateText),
      chunkCount: Math.ceil(Buffer.byteLength(candidateText) / 65_536),
    },
  };
  const operationId = `githubmutation-${"d".repeat(64)}`;
  const permission = sessionPermissionOperationSchema.parse({
    kind: "github_mutation",
    repository: input.repository,
    operation: "branch_publish",
    pullRequestNumber: null,
    targetId: input.branchName,
    expectedHeadSha: input.expectedHeadSha,
    payloadJson: canonicalJsonText(input),
  });
  return {
    version: "codeops.github-mutation-provider-request/v1",
    operation: "branch_publish",
    operationId,
    input,
    payloadDigest: sha256CanonicalJsonDigest(input),
    permissionDigest: sha256CanonicalJsonDigest(permission),
    provenance: {
      sessionId: "session-admission",
      dispatchId: "11111111-1111-4111-8111-111111111111",
      admissionId: "22222222-2222-4222-8222-222222222222",
      sessionGeneration: 1,
      sessionLeaseId: "33333333-3333-4333-8333-333333333333",
      permissionRequestId: "permission-runtime",
      authorizationExpiresAt: "2026-08-31T12:00:00.000Z",
      principalDigest: `sha256:${"e".repeat(64)}`,
    },
  };
}

let lastCandidate;

test("proves over-deadline create admission has no provider effect", async () => {
  let providerCalls = 0;
  const mutate = createCreateAdapter({
    resolve: () => authority,
    loadBranchCandidate: async () => lastCandidate,
    fetch: async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
  });
  await assert.rejects(
    mutate(providerRequest(publication(newFiles(13)))),
    (error) => error instanceof GitHubMutationPreflightNoEffectError &&
      /create estimate exceeds/.test(error.message),
  );
  assert.equal(providerCalls, 0);
});

test("validates fast-forward digests before deterministic admission", async () => {
  let providerCalls = 0;
  let resolutions = 0;
  const mutate = createFastForwardAdapter({
    loadBranchCandidate: async () => lastCandidate,
    resolve: () => {
      resolutions += 1;
      return authority;
    },
    fetch: async () => {
      providerCalls += 1;
      throw new Error("provider must not be called");
    },
  });
  const admitted = publication(newFiles(1), "fast_forward");
  const forged = providerRequest(admitted);
  forged.permissionDigest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(mutate(forged), /digests do not match/);
  assert.equal(resolutions, 0);
  assert.equal(providerCalls, 0);
});

test("classifies create and fast-forward candidate loader failure as proven no-effect", async () => {
  for (const create of [createCreateAdapter, createFastForwardAdapter]) {
    let providerCalls = 0;
    const mutate = create({
      resolve: () => authority,
      loadBranchCandidate: async () => { throw new Error("candidate unavailable"); },
      fetch: async () => {
        providerCalls += 1;
        throw new Error("provider must not be called");
      },
    });
    const input = publication(newFiles(1),
      create === createFastForwardAdapter ? "fast_forward" : "create");
    await assert.rejects(mutate(providerRequest(input)), (error) =>
      error instanceof GitHubMutationPreflightNoEffectError &&
      /candidate unavailable/.test(error.message));
    assert.equal(providerCalls, 0);
  }
});

test("maps a 409 no-effect response to a durable failed outcome", async () => {
  const request = providerRequest(publication(newFiles(1)));
  const responses = [];
  const provider = createGitHubMutationProviderClient({
    origin: "http://codeops-control-gateway:8080",
    token: "distinct-github-mutation-provider-token",
    fetch: async () => {
      const response = new Response('{"status":"no-effect"}', {
        status: 409,
        headers: { "content-type": "application/json" },
      });
      responses.push(response.status);
      return response;
    },
  });
  const calls = [];
  const client = {
    query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("SELECT snapshot_json")) return { rowCount: 1, rows: [{
        snapshot_json: {
          version: "codeops.session-snapshot/v1", sessionId: request.provenance.sessionId,
          generation: 1, state: "running", identity: { repository: request.input.repository,
            branch: "codeops/runtime-permission", baseSha: request.input.expectedHeadSha,
            workflowId: "runtime-permission", runId: "runtime-permission-1",
            parentSessionId: null, forkedAtCursor: null },
          lease: { leaseId: request.provenance.sessionLeaseId, generation: 1,
            status: "active", holderId: "runtime-worker",
            acquiredAt: "2026-08-31T10:00:00.000Z",
            expiresAt: "2026-08-31T12:00:00.000Z" }, checkpoint: null,
          pendingPermission: null, eventCursor: 1,
          capabilities: sessionCapabilitiesFor("running", false),
          updatedAt: "2026-08-31T10:00:00.000Z",
        },
      }] };
      return { rowCount: 1, rows: [] };
    },
  };
  await assert.rejects(
    executeAuthorizedSessionRuntimeGitHubMutation(client, { request, provider,
      now: () => new Date("2026-08-31T10:30:00.000Z") }),
    GitHubMutationProviderNoEffectError,
  );
  assert.deepEqual(responses, [409]);
  const failure = calls.find(({ text }) => text.includes("SET state = $1"));
  assert.equal(failure.values[0], "failed");
  assert.notEqual(failure.values[0], "unknown");
  assert.ok(calls.some(({ text }) => text.includes("FOR UPDATE OF manifest SKIP LOCKED")));
  assert.equal(calls.at(-1).text, "COMMIT");
});
