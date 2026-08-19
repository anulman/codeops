import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { sessionCommandSchema } from "@codeops/codeops-contracts/session-broker";
import { webPushSubscriptionSchema } from "@codeops/codeops-contracts/session-notification";
import { agentsContextMiddleware } from "./agentsContext";
import { sessionOwnerContextMiddleware } from "./sessionOwnerContext";
import {
  sessionBrokerClient,
  sessionNotificationClient,
} from "./sessionBroker.server";
import {
  submitSessionForkSynthesis,
} from "./sessionForkComparison.server";

const sessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const webPushFailureDiagnosticSchema = z.object({
  version: z.literal("codeops.web-push-failure-diagnostic/v1"),
  flow: z.enum(["automatic", "gesture"]),
  stage: z.enum(["read-existing", "revoke", "subscribe", "serialize", "register"]),
  name: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
  message: z.string().min(1).max(240),
  permission: z.enum(["default", "denied", "granted"]),
  serviceWorkerState: z.enum(["activated", "activating", "installed", "installing", "redundant", "missing"]),
  installed: z.boolean(),
}).strict();
function protectResponse(): void {
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("Referrer-Policy", "no-referrer");
  setResponseHeader("X-Robots-Tag", "noindex, nofollow");
}

export const getSessionFleet = createServerFn({ method: "GET" })
  .middleware([sessionOwnerContextMiddleware])
  .handler(async ({ context }) => {
    protectResponse();
    return (await sessionBrokerClient()).listSessions(
      context.sessionOwnerPrincipal,
    );
  });

export const getProviderEffectFleet = createServerFn({ method: "GET" })
  .middleware([sessionOwnerContextMiddleware])
  .handler(async ({ context }) => {
    protectResponse();
    return (await sessionBrokerClient()).listProviderEffects(
      context.sessionOwnerPrincipal,
    );
  });

export const reconcileProviderEffect = createServerFn({ method: "POST" })
  .middleware([sessionOwnerContextMiddleware])
  .inputValidator((value: unknown) =>
    z.object({
      effectId: z.string().regex(/^githubmutation-[0-9a-f]{64}$/),
    }).strict().parse(value),
  )
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await sessionBrokerClient()).reconcileProviderEffect({
      effectId: data.effectId,
      principalId: context.sessionOwnerPrincipal,
    });
  });

export const getSessionDetail = createServerFn({ method: "GET" })
  .middleware([sessionOwnerContextMiddleware])
  .inputValidator((value: unknown) =>
    z.object({ sessionId: sessionIdSchema }).strict().parse(value),
  )
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await sessionBrokerClient()).getSession(
      data.sessionId,
      context.sessionOwnerPrincipal,
    );
  });

export const getSessionEvents = createServerFn({ method: "GET" })
  .middleware([sessionOwnerContextMiddleware])
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
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await sessionBrokerClient()).getEvents({
      ...data,
      principalId: context.sessionOwnerPrincipal,
    });
  });

export const executeSessionCommand = createServerFn({ method: "POST" })
  .middleware([sessionOwnerContextMiddleware])
  .inputValidator((value: unknown) => sessionCommandSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await sessionBrokerClient()).executeCommand({
      command: data,
      principalId: context.sessionOwnerPrincipal,
    });
  });

export const synthesizeSessionForks = createServerFn({ method: "POST" })
  .middleware([sessionOwnerContextMiddleware])
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
      principalId: context.sessionOwnerPrincipal,
      targetSessionId: data.targetSessionId,
      candidateSessionIds: data.candidateSessionIds,
      idempotencyKey: data.idempotencyKey,
    });
  });

export const getWebPushConfiguration = createServerFn({ method: "GET" })
  .middleware([agentsContextMiddleware])
  .handler(async () => {
    protectResponse();
    return (await sessionNotificationClient()).getWebPushConfiguration();
  });

export const registerWebPushSubscription = createServerFn({ method: "POST" })
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) => webPushSubscriptionSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await sessionNotificationClient()).registerWebPushSubscription({
      subscription: data,
      principalId: context.agentsPrincipal,
    });
  });

export const revokeWebPushSubscription = createServerFn({ method: "POST" })
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) => webPushSubscriptionSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await sessionNotificationClient()).revokeWebPushSubscription({
      subscription: data,
      principalId: context.agentsPrincipal,
    });
  });

export const reportWebPushFailure = createServerFn({ method: "POST" })
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) => webPushFailureDiagnosticSchema.parse(value))
  .handler(({ data, context }) => {
    protectResponse();
    console.warn(JSON.stringify({
      event: "agents_ui_web_push_enable_failed",
      principalId: context.agentsPrincipal,
      ...data,
    }));
    return { ok: true as const };
  });
