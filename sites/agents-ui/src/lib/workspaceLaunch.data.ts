import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";
import {
  workspaceLaunchRequestSchema,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import { agentsAuthMiddleware } from "./agentsAuth";
import { commandOriginIsAllowed } from "./sessionBroker.server";
import { workspaceLaunchClient } from "./workspaceLaunch.server";

const launchIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

function protectResponse(): void {
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("Referrer-Policy", "no-referrer");
  setResponseHeader("Vary", "CF-Access-Authenticated-User-Email, Origin");
  setResponseHeader("X-Robots-Tag", "noindex, nofollow");
}

function requirePrincipal(principal: string | null | undefined): string {
  const value = principal ??
    (process.env.NODE_ENV === "production" ? null : "agents-ui-local");
  if (!value) throw new Response("Unauthorized", { status: 401 });
  return value;
}

export const getWorkspaceCatalog = createServerFn({ method: "GET" })
  .middleware([agentsAuthMiddleware])
  .handler(async () => {
    protectResponse();
    return (await workspaceLaunchClient()).getCatalog();
  });

export const createWorkspaceLaunch = createServerFn({ method: "POST" })
  .middleware([agentsAuthMiddleware])
  .inputValidator((value: unknown) => workspaceLaunchRequestSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    if (!commandOriginIsAllowed(getRequestHeader("origin")?.trim())) {
      throw new Response("Forbidden", { status: 403 });
    }
    return (await workspaceLaunchClient()).createLaunch({
      request: data,
      principalId: requirePrincipal(context.agentsPrincipal),
    });
  });

export const getWorkspaceLaunch = createServerFn({ method: "GET" })
  .middleware([agentsAuthMiddleware])
  .inputValidator((value: unknown) =>
    z.object({ launchId: launchIdSchema }).strict().parse(value),
  )
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await workspaceLaunchClient()).getLaunch({
      launchId: data.launchId,
      principalId: requirePrincipal(context.agentsPrincipal),
    });
  });
