import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { WorkflowSnapshot } from "./model.js";
import type {
  AgentJobDispatchInput,
  WorkItemInput,
} from "./workflow.js";

export interface DispatchResult {
  readonly checkpointUri: string;
  readonly checkpointDigest: string;
}

const dispatchResultSchema = z
  .object({
    checkpointUri: z.string().min(1).max(2_000),
    checkpointDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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
  workItem: AgentJobDispatchInput,
): Promise<DispatchResult> {
  const endpoint = new URL("/v1/agent-jobs", required("CODEOPS_AGENT_DISPATCH_ORIGIN"));
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("CodeOps Agent Job dispatch origin must use HTTP or HTTPS");
  }
  const token = (
    await readFile(required("CODEOPS_AGENT_DISPATCH_TOKEN_FILE"), "utf8")
  ).trim();
  if (token.length < 32 || token.length > 4_096) {
    throw new Error("CodeOps Agent Job dispatch token is invalid");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(workItem),
    signal: AbortSignal.timeout(65 * 60 * 1_000),
  });
  if (!response.ok) {
    throw new Error(`CodeOps Agent Job dispatch failed with status ${response.status}`);
  }
  return dispatchResultSchema.parse(await response.json());
}
