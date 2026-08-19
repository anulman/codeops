import { createHash } from "node:crypto";
import type { AgentJobDispatchRequest } from "@codeops/codeops-contracts";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function agentJobSessionId(runId: string): string {
  return `ses_${hash(`agent-job:${runId}`).slice(0, 24)}`;
}

export function agentJobModelBudgetAuthority(
  request: AgentJobDispatchRequest,
  runId: string,
): Readonly<{ budgetId: string; generation: number }> | null {
  if (
    (request.role !== "coding-agent" && request.role !== "critic-agent") ||
    request.codingRequest.adoptedPullRequest === undefined
  ) {
    return null;
  }
  return { budgetId: agentJobSessionId(runId), generation: 1 };
}
