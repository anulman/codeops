import {
  existingPullRequestAdoptionRequestSchema,
  existingPullRequestAdoptionResultSchema,
  type CodingRequest,
} from "@codeops/codeops-contracts";
import type { CodingRequestStore } from "./coding-request-store.js";
import type { PullRequestBindingStore } from "./pr-binding-store.js";
import type { WorkflowBindingStore } from "./workflow-binding-store.js";
import type { GitHubCurrentPullRequest } from "./runtime.js";

export async function adoptExistingPullRequest(input: {
  request: unknown;
  resolveCurrent: (input: {
    repository: string;
    number: number;
  }) => Promise<GitHubCurrentPullRequest>;
  codingRequests: CodingRequestStore;
  pullRequestBindings: PullRequestBindingStore;
  workflowBindings: WorkflowBindingStore;
  enqueue: (input: {
    workflowId: string;
    request: CodingRequest;
  }) => Promise<"enqueued" | "already-enqueued">;
}) {
  const adoption = existingPullRequestAdoptionRequestSchema.parse(input.request);
  const request = adoption.codingRequest;
  const pullRequest = adoption.pullRequest;
  const repository = `${request.workItem.repository.owner}/${request.workItem.repository.name}`;
  const current = await input.resolveCurrent({
    repository,
    number: pullRequest.pullRequestNumber,
  });
  if (
    current.state !== "open" ||
    current.repository !== pullRequest.repository ||
    current.number !== pullRequest.pullRequestNumber ||
    current.headSha !== pullRequest.headSha ||
    current.headRef !== pullRequest.headRef ||
    current.baseSha !== pullRequest.baseSha ||
    current.baseRef !== pullRequest.baseRef
  ) {
    throw new Error("existing pull-request adoption observed remote identity drift");
  }

  const existing = await input.pullRequestBindings.getByPullRequest({
    repository,
    number: pullRequest.pullRequestNumber,
  });
  if (
    existing !== null &&
    (existing.workspaceId !== request.workspaceId ||
      existing.projectId !== request.projectId ||
      existing.workItemId !== request.workItem.workItemId ||
      existing.workflowId !== request.workItem.workflowId ||
      existing.headSha !== pullRequest.headSha ||
      existing.headRef !== pullRequest.headRef ||
      existing.baseSha !== pullRequest.baseSha ||
      existing.baseRef !== pullRequest.baseRef ||
      existing.state !== "open")
  ) {
    throw new Error("pull request is already bound to different CodeOps authority");
  }

  await input.codingRequests.put(request);
  const enqueueResult = await input.enqueue({
    workflowId: request.workItem.workflowId,
    request,
  });
  const updatedAt = pullRequest.adoptedAt;
  await input.workflowBindings.put({
    version: "codeops.workflow-binding/v1",
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    workItemId: request.workItem.workItemId,
    repository,
    workflowId: request.workItem.workflowId,
    status: "active",
    baseSha: pullRequest.headSha,
    branch: pullRequest.headRef,
    updatedAt,
  });
  await input.pullRequestBindings.put({
    version: "codeops.pull-request-binding/v1",
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    workItemId: request.workItem.workItemId,
    workflowId: request.workItem.workflowId,
    repository,
    number: pullRequest.pullRequestNumber,
    state: "open",
    headSha: pullRequest.headSha,
    headRef: pullRequest.headRef,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    qualified: false,
    updatedAt,
  });
  return existingPullRequestAdoptionResultSchema.parse({
    version: "codeops.existing-pull-request-adoption-result/v1",
    status: enqueueResult,
    workflowId: request.workItem.workflowId,
    workItemId: request.workItem.workItemId,
    repository,
    pullRequestNumber: pullRequest.pullRequestNumber,
    headSha: pullRequest.headSha,
  });
}
