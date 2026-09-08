import type { IncomingHttpHeaders } from "node:http";
import { agentMessageInputSchema, type AgentMessageResult } from "@codeops/codeops-contracts";
import { authenticateBearer } from "./bearer-auth.js";
import type { SupervisorRoute } from "./agent-messages.js";

export async function serveSupervisorMessages(input: {
  method?: string; url?: string; headers: IncomingHttpHeaders;
  routes: readonly SupervisorRoute[]; readBody: () => Promise<unknown>;
  operate: (route: SupervisorRoute, request: unknown) => Promise<AgentMessageResult>;
}): Promise<{ status: number; body: Readonly<Record<string, unknown>> } | null> {
  if (input.method !== "POST" || input.url !== "/v1/supervisor/messages") return null;
  const route = input.routes.find((candidate) =>
    authenticateBearer(input.headers.authorization, candidate.token));
  if (!route) return { status: 401, body: { status: "unauthorized" } };
  if (!input.headers["content-type"]?.startsWith("application/json")) {
    return { status: 415, body: { status: "unsupported-media-type" } };
  }
  const request = agentMessageInputSchema.safeParse(await input.readBody());
  if (!request.success || request.data.operation === "send") {
    return { status: 400, body: { status: "invalid-request" } };
  }
  return { status: 200, body: await input.operate(route, request.data) };
}
