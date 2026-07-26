import { readFile } from "node:fs/promises";
import {
  agentJobDispatchRequestSchema,
  agentJobDispatchResultSchema,
  type AgentJobDispatchRequest,
  type AgentJobDispatchResult,
  researchPacketSchema,
  type ResearchPacket,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";
import type { WorkflowSnapshot } from "./model.js";
import type {
  WorkItemInput,
} from "./workflow.js";

export type DispatchResult = AgentJobDispatchResult;
export type ResearchProjectionResult = Readonly<{
  passed: boolean;
  summary: string;
}>;

const researchProjectionResultSchema = z
  .object({
    version: z.literal("codeops.research-projection-result/v1"),
    requestId: z.string().min(1).max(128),
    status: z.enum(["applied", "duplicate"]),
    mutationCount: z.number().int().nonnegative().max(100),
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
  workItem: AgentJobDispatchRequest,
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
    body: JSON.stringify(agentJobDispatchRequestSchema.parse(workItem)),
    signal: AbortSignal.timeout(65 * 60 * 1_000),
  });
  if (!response.ok) {
    throw new Error(`CodeOps Agent Job dispatch failed with status ${response.status}`);
  }
  return agentJobDispatchResultSchema.parse(await response.json());
}

export async function publishResearchPacket(
  packet: ResearchPacket,
): Promise<ResearchProjectionResult> {
  const endpoint = new URL(
    "/v1/research-packets",
    required("CODEOPS_RESEARCH_PROJECTION_ORIGIN"),
  );
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("CodeOps research projection origin must use HTTP or HTTPS");
  }
  const token = (
    await readFile(required("CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE"), "utf8")
  ).trim();
  if (token.length < 32 || token.length > 4_096) {
    throw new Error("CodeOps research projection token is invalid");
  }
  const boundPacket = researchPacketSchema.parse(packet);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(boundPacket),
    signal: AbortSignal.timeout(2 * 60 * 1_000),
  });
  if (!response.ok) {
    throw new Error(
      `CodeOps research projection failed with status ${response.status}`,
    );
  }
  const result = researchProjectionResultSchema.parse(await response.json());
  if (result.requestId !== boundPacket.requestId) {
    throw new Error("CodeOps research projection identity mismatch");
  }
  return {
    passed: true,
    summary: `Plane research packet ${result.status} with ${result.mutationCount} content mutation(s)`,
  };
}
