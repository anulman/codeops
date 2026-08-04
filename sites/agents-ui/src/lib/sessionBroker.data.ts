import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { sessionCommandSchema } from "@renoconcierge/codeops-contracts/session-broker";
import { agentsAuthMiddleware } from "./agentsAuth";
import { sessionBrokerClient } from "./sessionBroker.server";

const sessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

function protectResponse(): void {
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("Referrer-Policy", "no-referrer");
  setResponseHeader("Vary", "CF-Access-Authenticated-User-Email");
  setResponseHeader("X-Robots-Tag", "noindex, nofollow");
}

export const getSessionFleet = createServerFn({ method: "GET" })
  .middleware([agentsAuthMiddleware])
  .handler(async () => {
    protectResponse();
    return (await sessionBrokerClient()).listSessions();
  });

export const getSessionDetail = createServerFn({ method: "GET" })
  .middleware([agentsAuthMiddleware])
  .inputValidator((value: unknown) =>
    z.object({ sessionId: sessionIdSchema }).strict().parse(value),
  )
  .handler(async ({ data }) => {
    protectResponse();
    return (await sessionBrokerClient()).getSession(data.sessionId);
  });

export const getSessionEvents = createServerFn({ method: "GET" })
  .middleware([agentsAuthMiddleware])
  .inputValidator((value: unknown) =>
    z
      .object({
        sessionId: sessionIdSchema,
        afterCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .strict()
      .parse(value),
  )
  .handler(async ({ data }) => {
    protectResponse();
    return (await sessionBrokerClient()).getEvents(data);
  });

export const executeSessionCommand = createServerFn({ method: "POST" })
  .middleware([agentsAuthMiddleware])
  .inputValidator((value: unknown) => sessionCommandSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    const principalId = context.agentsPrincipal ??
      (process.env.NODE_ENV === "production" ? null : "agents-ui-local");
    if (!principalId) throw new Response("Unauthorized", { status: 401 });
    return (await sessionBrokerClient()).executeCommand({
      command: data,
      principalId,
    });
  });
