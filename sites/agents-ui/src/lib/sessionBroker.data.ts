import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { sessionCommandSchema } from "@codeops/codeops-contracts/session-broker";
import { agentsContextMiddleware } from "./agentsContext";
import { sessionBrokerClient } from "./sessionBroker.server";
import {
  submitSessionForkSynthesis,
} from "./sessionForkComparison.server";

const sessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
function protectResponse(): void {
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("Referrer-Policy", "no-referrer");
  setResponseHeader("X-Robots-Tag", "noindex, nofollow");
}

export const getSessionFleet = createServerFn({ method: "GET" })
  .middleware([agentsContextMiddleware])
  .handler(async () => {
    protectResponse();
    return (await sessionBrokerClient()).listSessions();
  });

export const getSessionDetail = createServerFn({ method: "GET" })
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) =>
    z.object({ sessionId: sessionIdSchema }).strict().parse(value),
  )
  .handler(async ({ data }) => {
    protectResponse();
    return (await sessionBrokerClient()).getSession(data.sessionId);
  });

export const getSessionEvents = createServerFn({ method: "GET" })
  .middleware([agentsContextMiddleware])
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
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) => sessionCommandSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await sessionBrokerClient()).executeCommand({
      command: data,
      principalId: context.agentsPrincipal,
    });
  });

export const synthesizeSessionForks = createServerFn({ method: "POST" })
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) =>
    z
      .object({
        targetSessionId: sessionIdSchema,
        candidateSessionIds: z.array(sessionIdSchema).min(2).max(4),
        idempotencyKey: z.string().uuid(),
      })
      .strict()
      .superRefine((input, context) => {
        if (new Set(input.candidateSessionIds).size !== input.candidateSessionIds.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["candidateSessionIds"],
            message: "fork comparison candidates must be unique",
          });
        }
      })
      .parse(value),
  )
  .handler(async ({ data, context }) => {
    protectResponse();
    return submitSessionForkSynthesis({
      broker: await sessionBrokerClient(),
      principalId: context.agentsPrincipal,
      targetSessionId: data.targetSessionId,
      candidateSessionIds: data.candidateSessionIds,
      idempotencyKey: data.idempotencyKey,
    });
  });
