import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  canonicalJsonText,
  githubBranchPublishInputSchema,
  githubBranchPublishCandidateSchema,
  githubBranchPublishLegacyInlineInputSchema,
  githubCheckRerunInputSchema,
  githubMutationResultSchema,
  githubPullRequestUpdateBranchInputSchema,
  githubPullRequestUpdateInputSchema,
  githubPullRequestCreateInputSchema,
  githubReviewThreadReplyInputSchema,
  sessionPermissionOperationSchema,
  type GitHubMutationOperation,
  type SessionRuntimeDispatch,
} from "@codeops/codeops-contracts";
import { linkTrustedPlaneWorkItemReferences } from "./plane-work-item-links.js";
import type {
  RuntimeExecutionContext,
  RuntimeGitHubMutationRequest,
} from "./transport.js";

const MAX_BODY_BYTES = 4_456_448;
const routes = new Map<string, GitHubMutationOperation>([
  ["/v1/github-mutations/branch/publish", "branch_publish"],
  ["/v1/github-mutations/pull-request/create", "pull_request_create"],
  ["/v1/github-mutations/pull-request/update-branch", "pull_request_update_branch"],
  ["/v1/github-mutations/pull-request/update", "pull_request_update"],
  ["/v1/github-mutations/review-thread/reply", "review_thread_reply"],
  ["/v1/github-mutations/check/rerun", "check_rerun"],
]);

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonText(value)).digest("hex")}`;
}

async function mutationRequest(
  dispatchId: string,
  operation: GitHubMutationOperation,
  rawInput: unknown,
  dispatch: SessionRuntimeDispatch,
  context: RuntimeExecutionContext,
): Promise<RuntimeGitHubMutationRequest> {
  const schemas = {
    branch_publish: githubBranchPublishInputSchema,
    pull_request_create: githubPullRequestCreateInputSchema,
    pull_request_update_branch: githubPullRequestUpdateBranchInputSchema,
    pull_request_update: githubPullRequestUpdateInputSchema,
    review_thread_reply: githubReviewThreadReplyInputSchema,
    check_rerun: githubCheckRerunInputSchema,
  } as const;
  const identity = dispatch.snapshot?.identity;
  const planeWorkItem = identity !== undefined && "version" in identity &&
      identity.version === "codeops.temporal-session-identity/v2"
    ? identity.planeWorkItem
    : undefined;
  let preparedInput = rawInput;
  if (planeWorkItem !== undefined && operation === "pull_request_create") {
    const input = githubPullRequestCreateInputSchema.parse(rawInput);
    preparedInput = {
      ...input,
      body: linkTrustedPlaneWorkItemReferences(input.body, [planeWorkItem]),
    };
  } else if (planeWorkItem !== undefined && operation === "pull_request_update") {
    const input = githubPullRequestUpdateInputSchema.parse(rawInput);
    if (input.body !== undefined) preparedInput = {
      ...input,
      body: linkTrustedPlaneWorkItemReferences(input.body, [planeWorkItem]),
    };
  }
  if (operation === "branch_publish") {
    const logicalInput = githubBranchPublishLegacyInlineInputSchema.parse(
      preparedInput,
    );
    const candidate = githubBranchPublishCandidateSchema.parse({
      version: "codeops.github-branch-publish-candidate/v1",
      changes: logicalInput.changes,
    });
    const candidateBytes = Buffer.from(canonicalJsonText(candidate));
    const chunks = Array.from(
      { length: Math.ceil(candidateBytes.length / 65_536) },
      (_, ordinal) => candidateBytes.subarray(ordinal * 65_536, (ordinal + 1) * 65_536),
    );
    const candidateDigest = digest(candidate);
    const chunkIdentities = chunks.map((bytes, ordinal) => ({
      ordinal,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      sizeBytes: bytes.length,
    }));
    const effectDigest = digest(logicalInput);
    const operationId = `githubmutation-${createHash("sha256")
      .update(canonicalJsonText({ dispatchId, operation, input: logicalInput })).digest("hex")}`;
    const manifestId = `githubcandidate-${createHash("sha256")
      .update(canonicalJsonText({
        version: "codeops.github-branch-publish-candidate-manifest/v1",
        dispatchId,
        sessionId: dispatch.command.sessionId,
        ownerPrincipalId: dispatch.principalId,
        repository: logicalInput.repository,
        operationId,
        effectDigest,
        candidate: {
          digest: candidateDigest,
          sizeBytes: candidateBytes.length,
          chunkCount: chunks.length,
        },
        chunks: chunkIdentities,
        operation: "branch_publish",
      })).digest("hex")}`;
    const { changes: _changes, ...metadata } = logicalInput;
    const candidateReference = {
      manifestId, digest: candidateDigest,
      sizeBytes: candidateBytes.length, chunkCount: chunks.length,
    };
    const finalInput = githubBranchPublishInputSchema.parse({
      ...metadata, candidate: candidateReference,
    });
    await context.storeGitHubBranchCandidate({
      manifest: {
        operationId, effectDigest, repository: finalInput.repository,
        candidate: candidateReference, chunks: chunkIdentities,
      },
      chunks: chunks.map((bytes, ordinal) => ({
        operationId, manifestId, ordinal,
        digest: chunkIdentities[ordinal]!.digest,
        bytesBase64: bytes.toString("base64"),
      })),
    });
    return { operation, operationId, input: finalInput } as RuntimeGitHubMutationRequest;
  }
  const input = schemas[operation].parse(preparedInput);
  return {
    operation,
    operationId: `githubmutation-${createHash("sha256")
      .update(canonicalJsonText({ dispatchId, operation, input })).digest("hex")}`,
    input,
  } as RuntimeGitHubMutationRequest;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("GitHub mutation request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": String(encoded.byteLength),
  });
  response.end(encoded);
}

function permissionTarget(request: RuntimeGitHubMutationRequest): {
  pullRequestNumber: number | null;
  targetId: string | null;
} {
  switch (request.operation) {
    case "branch_publish":
      return { pullRequestNumber: null, targetId: request.input.branchName };
    case "pull_request_create":
      return { pullRequestNumber: null, targetId: request.input.headBranch };
    case "pull_request_update_branch":
    case "pull_request_update":
      return { pullRequestNumber: request.input.pullRequestNumber, targetId: null };
    case "review_thread_reply":
      return {
        pullRequestNumber: request.input.pullRequestNumber,
        targetId: request.input.threadId,
      };
    case "check_rerun":
      return { pullRequestNumber: null, targetId: String(request.input.checkRunId) };
  }
}

export class GitHubMutationsBroker {
  readonly #server;
  #active: { readonly dispatch: SessionRuntimeDispatch; readonly context: RuntimeExecutionContext } | undefined;

  constructor() {
    this.#server = createServer((request, response) => void this.#serve(request, response));
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const operation = request.url === undefined ? undefined : routes.get(request.url);
    if (request.method !== "POST" || operation === undefined) {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { status: "unsupported-media-type" });
      return;
    }
    const active = this.#active;
    if (active === undefined || active.dispatch.command.type !== "prompt") {
      json(response, 409, { status: "no-active-prompt" });
      return;
    }
    try {
      const mutation = await mutationRequest(
        active.dispatch.dispatchId,
        operation,
        await readJson(request),
        active.dispatch,
        active.context,
      );
      const target = permissionTarget(mutation);
      const permissionOperation = sessionPermissionOperationSchema.parse({
        kind: "github_mutation",
        repository: mutation.input.repository,
        operation,
        ...target,
        expectedHeadSha: mutation.input.expectedHeadSha,
        payloadJson: canonicalJsonText(mutation.input),
      });
      const permissionRequestId = `permission-${createHash("sha256")
        .update(canonicalJsonText(permissionOperation))
        .update("\0")
        .update(active.dispatch.dispatchId)
        .update("\0")
        .update(mutation.operationId)
        .digest("hex")}`;
      const decision = await active.context.requestPermission({
        request: {
          requestId: permissionRequestId,
          title: `Allow ${operation.replaceAll("_", " ")} once in ${mutation.input.repository}?`,
          description: "CodeOps will reject repository, target, branch, or commit drift before it performs this one GitHub operation.",
          operation: permissionOperation,
          operationDigest: digest(permissionOperation),
          options: [
            { optionId: "allow-once", label: "Allow once" },
            { optionId: "deny", label: "Do not allow it" },
          ],
          requestedAt: new Date().toISOString(),
        },
        acpSessionId: "codeops-github",
        toolCallId: mutation.operationId,
        options: [
          { optionId: "allow-once", acpOptionId: "allow-once" },
          { optionId: "deny", acpOptionId: "deny" },
        ],
      });
      if (decision.outcome !== "selected" || decision.acpOptionId !== "allow-once") {
        json(response, 403, { status: "permission-denied" });
        return;
      }
      json(response, 200, githubMutationResultSchema.parse(
        await active.context.mutateGitHub(mutation),
      ));
    } catch {
      json(response, 503, { status: "unavailable" });
    }
  }

  async listen(port: number): Promise<number> {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error("GitHub mutations broker port is invalid");
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("GitHub mutations broker did not bind a TCP port");
    }
    return address.port;
  }

  async run<Result>(
    dispatch: SessionRuntimeDispatch,
    context: RuntimeExecutionContext,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#active !== undefined) throw new Error("GitHub mutations broker is already active");
    this.#active = { dispatch, context };
    try {
      return await operation();
    } finally {
      this.#active = undefined;
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
