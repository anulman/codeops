import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type {
  ResearchPersonaHandle,
  ResearchRequest,
} from "@renoconcierge/codeops-contracts";
import type { DispatchResult } from "./activities.js";
import {
  transition,
  type WorkflowSnapshot,
} from "./model.js";

interface WorkItemInputBase {
  readonly workItemId: string;
  readonly workflowId: string;
  readonly baseSha: string;
  readonly summary: string;
}

export type WorkItemInput =
  | (WorkItemInputBase & {
      readonly role: "coding-agent";
    })
  | (WorkItemInputBase & {
      readonly role: "qa-contract-researcher";
      readonly researchRequest: ResearchRequest;
    });

export type AgentJobDispatchInput =
  | Extract<WorkItemInput, { readonly role: "coding-agent" }>
  | (Extract<WorkItemInput, { readonly role: "qa-contract-researcher" }> & {
      readonly researchPersona: ResearchPersonaHandle;
    });

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
}

const { dispatchAgentJob, recordTransition } = proxyActivities<Activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1 second",
    maximumAttempts: 3,
  },
});

export const approvePlan = defineSignal("approvePlan");
export const rejectPlan = defineSignal<[string]>("rejectPlan");
export const cancelWorkItem = defineSignal<[string]>("cancelWorkItem");
export const reportAcceptance =
  defineSignal<[AcceptanceResult]>("reportAcceptance");
export const workflowStatus = defineQuery<WorkflowSnapshot>("workflowStatus");

export async function workItemWorkflow(
  workItem: WorkItemInput,
): Promise<WorkflowSnapshot> {
  let snapshot: WorkflowSnapshot = {
    state: "requested",
    sequence: 0,
    summary: workItem.summary,
  };
  let planDecision: "approved" | "rejected" | null = null;
  let planRejection = "";
  let cancellation = "";
  const external = {
    acceptance: null as AcceptanceResult | null,
  };

  setHandler(workflowStatus, () => snapshot);
  setHandler(approvePlan, () => {
    if (snapshot.state === "approval_required") planDecision = "approved";
  });
  setHandler(rejectPlan, (reason) => {
    if (snapshot.state === "approval_required") {
      planDecision = "rejected";
      planRejection = reason;
    }
  });
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

  await move("started", "Temporal accepted the work item");
  await move("planning", "Preparing the implementation plan");
  await move("approval_required", "Plan review is required before execution");
  await condition(() => planDecision !== null || cancellation.length > 0);

  if (await cancelIfRequested()) return snapshot;
  if (planDecision === "rejected") {
    await move("failed", planRejection || "Plan rejected");
    return snapshot;
  }

  await move("executing", "Dispatching the isolated Agent Job");
  const dispatches: DispatchResult[] = [];
  try {
    if (workItem.role === "coding-agent") {
      dispatches.push(await dispatchAgentJob(workItem));
    } else {
      // Preserve the strict one-Agent-Job Trial 0 concurrency cap while still
      // giving every tagged persona an isolated, terminal execution.
      for (const persona of workItem.researchRequest.personas) {
        dispatches.push(
          await dispatchAgentJob({
            ...workItem,
            researchPersona: persona,
          }),
        );
      }
    }
  } catch {
    await move(
      "failed",
      "Agent Job dispatch failed closed before workload execution",
    );
    return snapshot;
  }
  await move(
    "evidence_ready",
    `Checkpoints ready at ${dispatches
      .map((dispatch) => dispatch.checkpointUri)
      .join(", ")}`,
  );
  await move("validating", "Waiting for independent acceptance");
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
}
