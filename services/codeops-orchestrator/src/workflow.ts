import {
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type {
  AgentJobDispatchRequest,
  CandidateCheckpoint,
  CandidatePublication,
  CandidatePublicationResult,
  CodingRequest,
  ResearchRequest,
} from "@codeops/codeops-contracts";
import type {
  DispatchResult,
  ResearchProjectionResult,
} from "./activities.js";
import { agentJobActivityOptions } from "./activity-options.js";
import { transition, type WorkflowSnapshot } from "./model.js";
import { buildResearchPacket } from "./research.js";
import {
  adversarialReviewMatchesCandidate,
  candidateCheckpointFromDispatch,
  criticLoopAction,
} from "./review.js";

interface WorkItemInputBase {
  readonly workItemId: string;
  readonly workflowId: string;
  readonly baseSha: string;
  readonly summary: string;
}

export type WorkItemInput =
  | (WorkItemInputBase & {
      readonly role: "coding-agent";
      readonly codingRequest: CodingRequest;
    })
  | (WorkItemInputBase & {
      readonly role: "qa-contract-researcher";
      readonly researchRequest: ResearchRequest;
    });

export type AgentJobDispatchInput = AgentJobDispatchRequest;

export interface AcceptanceResult {
  readonly passed: boolean;
  readonly summary: string;
}

interface Activities {
  recordTransition(
    workItem: WorkItemInput,
    snapshot: WorkflowSnapshot,
  ): Promise<void>;
  dispatchAgentJob(workItem: AgentJobDispatchInput): Promise<DispatchResult>;
  publishResearchPacket(
    packet: ReturnType<typeof buildResearchPacket>,
  ): Promise<ResearchProjectionResult>;
  publishCandidateRevision(
    publication: CandidatePublication,
  ): Promise<CandidatePublicationResult>;
}

const { recordTransition } = proxyActivities<
  Pick<Activities, "recordTransition">
>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1 second",
    maximumAttempts: 3,
  },
});
const { dispatchAgentJob } = proxyActivities<
  Pick<Activities, "dispatchAgentJob">
>(agentJobActivityOptions);
const { publishResearchPacket } = proxyActivities<
  Pick<Activities, "publishResearchPacket">
>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 3,
  },
});
const { publishCandidateRevision } = proxyActivities<
  Pick<Activities, "publishCandidateRevision">
>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "5 seconds",
    maximumAttempts: 3,
  },
});

export const cancelWorkItem = defineSignal<[string]>("cancelWorkItem");
export const reportAcceptance =
  defineSignal<[AcceptanceResult]>("reportAcceptance");
export const workflowStatus = defineQuery<WorkflowSnapshot>("workflowStatus");

export async function workItemWorkflow(
  workItem: WorkItemInput,
): Promise<WorkflowSnapshot> {
  if (
    workItem.role === "coding-agent" &&
    (workItem.codingRequest.workItem.workItemId !== workItem.workItemId ||
      workItem.codingRequest.workItem.workflowId !== workItem.workflowId ||
      workItem.codingRequest.workItem.baseSha !== workItem.baseSha ||
      workItem.codingRequest.workItem.summary !== workItem.summary)
  ) {
    throw new Error("coding workflow identity does not match its request");
  }
  const autonomousCritic =
    workItem.role === "coding-agent" &&
    patched("coding-autonomous-critic-v1");
  let snapshot: WorkflowSnapshot = {
    state: "requested",
    sequence: 0,
    summary: workItem.summary,
  };
  let cancellation = "";
  const external = {
    acceptance: null as AcceptanceResult | null,
  };
  let codingCheckpoint: DispatchResult | null = null;

  setHandler(workflowStatus, () => snapshot);
  setHandler(cancelWorkItem, (reason) => {
    cancellation = reason;
  });
  setHandler(reportAcceptance, (result) => {
    if (snapshot.state === "validating") external.acceptance = result;
  });

  const move = async (state: Parameters<typeof transition>[1], summary: string) => {
    snapshot = transition(snapshot, state, summary);
    await recordTransition(workItem, snapshot);
  };

  const cancelIfRequested = async (): Promise<boolean> => {
    if (cancellation.length === 0) return false;
    await move("cancelled", cancellation);
    return true;
  };

  try {
    await move("started", "Temporal accepted the work item");
    await move(
      "planning",
      workItem.role === "coding-agent"
        ? "Ready authorizes routine planning and execution"
        : "The admitted human persona request authorizes research execution",
    );

    if (await cancelIfRequested()) return snapshot;

    await move("executing", "Dispatching the isolated Agent Job");
    const dispatches: DispatchResult[] = [];
    let synthesisDispatch: DispatchResult | undefined;
    try {
      if (workItem.role === "coding-agent") {
        codingCheckpoint = await dispatchAgentJob({
          version: "codeops.agent-job-dispatch/v1",
          ...workItem,
          ...(autonomousCritic ? { codingRound: 1 } : {}),
        });
        dispatches.push(codingCheckpoint);
      } else {
        // Preserve the strict one-Agent-Job Trial 0 concurrency cap while still
        // giving every tagged persona an isolated, terminal execution.
        for (const persona of workItem.researchRequest.personas) {
          dispatches.push(
            await dispatchAgentJob({
              version: "codeops.agent-job-dispatch/v1",
              ...workItem,
              researchStage: { kind: "persona", persona },
            }),
          );
        }
        const reports = dispatches.map((dispatch) => {
          if (
            dispatch.role !== "qa-contract-researcher" ||
            dispatch.researchResult.kind !== "persona"
          ) {
            throw new Error("persona dispatch returned the wrong result kind");
          }
          return dispatch.researchResult.report;
        });
        synthesisDispatch = await dispatchAgentJob({
          version: "codeops.agent-job-dispatch/v1",
          ...workItem,
          researchStage: { kind: "synthesis", reports },
        });
      }
    } catch (error) {
      if (isCancellation(error)) {
        await CancellationScope.nonCancellable(() =>
          move("cancelled", "Workflow cancellation requested"),
        );
        throw error;
      }
      await move(
        "failed",
        "Agent Job dispatch failed closed before workload execution",
      );
      return snapshot;
    }
    await move(
      "evidence_ready",
      `Checkpoints ready at ${[...dispatches, ...(synthesisDispatch ? [synthesisDispatch] : [])]
        .map((dispatch) => dispatch.checkpointUri)
        .join(", ")}`,
    );
    if (await cancelIfRequested()) return snapshot;
    if (workItem.role === "qa-contract-researcher") {
      let projection: ResearchProjectionResult;
      try {
        projection = await publishResearchPacket(
          buildResearchPacket({
            request: workItem.researchRequest,
            personaDispatches: dispatches,
            synthesisDispatch:
              synthesisDispatch ??
              (() => {
                throw new Error("research synthesis checkpoint is missing");
              })(),
          }),
        );
      } catch {
        await move(
          "failed",
          "Research evidence failed closed before Plane projection",
        );
        return snapshot;
      }
      await move("validating", "Validating trusted Plane research projection");
      if (projection.passed) {
        await move("completed", projection.summary);
      } else {
        await move("failed", projection.summary);
      }
      return snapshot;
    }
    if (workItem.role === "coding-agent" && autonomousCritic) {
      let round = 1;
      let acceptedCandidate: CandidateCheckpoint | null = null;
      let candidateDispatch = codingCheckpoint;
      if (!candidateDispatch || candidateDispatch.role !== "coding-agent") {
        await move("failed", "Coding Agent Job returned no candidate checkpoint");
        return snapshot;
      }
      while (true) {
        const candidate = candidateCheckpointFromDispatch(
          candidateDispatch,
          round,
        );
        await move(
          "reviewing",
          `Dispatching critic round ${round} for ${candidate.patch.digest}`,
        );
        let criticDispatch: DispatchResult;
        try {
          criticDispatch = await dispatchAgentJob({
            version: "codeops.agent-job-dispatch/v1",
            role: "critic-agent",
            workItemId: workItem.workItemId,
            workflowId: workItem.workflowId,
            baseSha: workItem.baseSha,
            summary: workItem.summary,
            codingRequest: workItem.codingRequest,
            codingRound: round,
            candidate,
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          await move("failed", `Critic Agent Job failed in round ${round}`);
          return snapshot;
        }
        if (
          criticDispatch.role !== "critic-agent" ||
          !adversarialReviewMatchesCandidate({
            review: criticDispatch.criticReview,
            workflowId: workItem.workflowId,
            workItemId: workItem.workItemId,
            baseSha: workItem.baseSha,
            candidate,
          })
        ) {
          await move(
            "failed",
            `Critic report identity drifted in round ${round}`,
          );
          return snapshot;
        }
        const action = criticLoopAction({
          review: criticDispatch.criticReview,
          round,
        });
        if (action === "accept") {
          acceptedCandidate = candidate;
          if (await cancelIfRequested()) return snapshot;
          break;
        }
        if (action === "exhausted") {
          await move(
            "failed",
            `Autonomous critic loop exhausted after ${round} coding rounds: ${criticDispatch.criticReview.summary}`,
          );
          return snapshot;
        }
        if (await cancelIfRequested()) return snapshot;
        const nextRound = round + 1;
        await move(
          "executing",
          `Dispatching coding revision round ${nextRound} from critic findings`,
        );
        try {
          candidateDispatch = await dispatchAgentJob({
            version: "codeops.agent-job-dispatch/v1",
            role: "coding-agent",
            workItemId: workItem.workItemId,
            workflowId: workItem.workflowId,
            baseSha: workItem.baseSha,
            summary: workItem.summary,
            codingRequest: workItem.codingRequest,
            codingRound: nextRound,
            revision: {
              candidate,
              review: criticDispatch.criticReview,
            },
          });
        } catch (error) {
          if (isCancellation(error)) throw error;
          await move(
            "failed",
            `Coding revision Agent Job failed in round ${nextRound}`,
          );
          return snapshot;
        }
        if (candidateDispatch.role !== "coding-agent") {
          await move(
            "failed",
            `Coding revision returned the wrong result kind in round ${nextRound}`,
          );
          return snapshot;
        }
        round = nextRound;
        await move(
          "evidence_ready",
          `Coding round ${round} checkpoint ready at ${candidateDispatch.checkpointUri}`,
        );
        if (await cancelIfRequested()) return snapshot;
      }
      const publicationProvenance =
        workItem.codingRequest.humanReview ??
        workItem.codingRequest.adoptedPullRequest;
      if (
        publicationProvenance !== undefined &&
        acceptedCandidate !== null &&
        acceptedCandidate.patch.sizeBytes > 0
      ) {
        await move(
          "validating",
          "Autonomous critic passed; publishing the exact human-review revision",
        );
        try {
          const publication = await publishCandidateRevision({
            version: "codeops.candidate-publication/v1",
            workspaceId: workItem.codingRequest.workspaceId,
            projectId: workItem.codingRequest.projectId,
            workItemId: workItem.workItemId,
            workflowId: workItem.workflowId,
            repository: workItem.codingRequest.workItem.repository,
            pullRequestNumber: publicationProvenance.pullRequestNumber,
            expectedHeadSha: workItem.baseSha,
            headRef: workItem.codingRequest.workItem.branch,
            ...(workItem.codingRequest.humanReview === undefined
              ? {
                  adoptedPullRequest:
                    workItem.codingRequest.adoptedPullRequest!,
                }
              : { humanReview: workItem.codingRequest.humanReview }),
            candidate: acceptedCandidate,
            commitMessage:
              workItem.codingRequest.humanReview === undefined
                ? `Address CodeOps review of PR #${publicationProvenance.pullRequestNumber}`
                : `Address PR #${publicationProvenance.pullRequestNumber} review`,
          });
          await move(
            "completed",
            `Published review revision ${publication.publishedHeadSha} to ${publication.headRef}`,
          );
        } catch (error) {
          if (isCancellation(error)) throw error;
          await move(
            "failed",
            "Critic-approved review revision failed closed before publication",
          );
        }
        return snapshot;
      }
      await move(
        "validating",
        "Autonomous critic passed; waiting for independent human acceptance",
      );
    } else {
      await move("validating", "Waiting for independent acceptance");
    }
    await condition(
      () => external.acceptance !== null || cancellation.length > 0,
    );

    if (await cancelIfRequested()) return snapshot;
    if (external.acceptance?.passed === true) {
      await move("completed", external.acceptance.summary);
    } else {
      await move(
        "failed",
        external.acceptance?.summary ?? "Independent acceptance failed",
      );
    }
    return snapshot;
  } catch (error) {
    if (isCancellation(error) && snapshot.state !== "cancelled") {
      await CancellationScope.nonCancellable(() =>
        move("cancelled", "Workflow cancellation requested"),
      );
    }
    throw error;
  }
}
