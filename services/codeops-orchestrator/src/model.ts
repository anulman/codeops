export const workflowStates = [
  "requested",
  "started",
  "planning",
  "approval_required",
  "executing",
  "evidence_ready",
  "validating",
  "completed",
  "failed",
  "cancelled",
] as const;

export type WorkflowState = (typeof workflowStates)[number];

const allowedTransitions: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  requested: ["started", "cancelled"],
  started: ["planning", "failed", "cancelled"],
  planning: ["approval_required", "failed", "cancelled"],
  approval_required: ["executing", "failed", "cancelled"],
  executing: ["evidence_ready", "failed", "cancelled"],
  evidence_ready: ["validating", "failed", "cancelled"],
  validating: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface WorkflowSnapshot {
  readonly state: WorkflowState;
  readonly sequence: number;
  readonly summary: string;
}

export type PlanDecision = "approved" | "rejected" | null;

export function initialPlanDecision(
  role: "coding-agent" | "qa-contract-researcher",
): PlanDecision {
  return role === "qa-contract-researcher" ? "approved" : null;
}

export function transition(
  snapshot: WorkflowSnapshot,
  nextState: WorkflowState,
  summary: string,
): WorkflowSnapshot {
  if (!allowedTransitions[snapshot.state].includes(nextState)) {
    throw new Error(`invalid CodeOps transition: ${snapshot.state} -> ${nextState}`);
  }
  const normalizedSummary = summary.trim();
  if (normalizedSummary.length === 0 || normalizedSummary.length > 1_000) {
    throw new Error("transition summary must contain 1 to 1000 characters");
  }
  return {
    state: nextState,
    sequence: snapshot.sequence + 1,
    summary: normalizedSummary,
  };
}
