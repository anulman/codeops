import type { WorkflowSnapshot } from "./model.js";
import type {
  AgentJobDispatchInput,
  WorkItemInput,
} from "./workflow.js";

export interface DispatchResult {
  readonly checkpointUri: string;
  readonly checkpointDigest: string;
}

export async function recordTransition(
  workItem: WorkItemInput,
  snapshot: WorkflowSnapshot,
): Promise<void> {
  console.log(
    JSON.stringify({
      type: "codeops.workflow-transition",
      workItemId: workItem.workItemId,
      workflowId: workItem.workflowId,
      baseSha: workItem.baseSha,
      ...snapshot,
    }),
  );
}

export async function dispatchAgentJob(
  _workItem: AgentJobDispatchInput,
): Promise<DispatchResult> {
  throw new Error(
    "CodeOps Agent Job adapter is not configured; refusing to simulate execution",
  );
}
