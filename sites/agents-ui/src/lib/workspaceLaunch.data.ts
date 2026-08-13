import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
  workspaceLaunchRequestSchema,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import { agentsContextMiddleware } from "./agentsContext";
import { workspaceLaunchClient } from "./workspaceLaunch.server";

const launchIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

function protectResponse(): void {
  setResponseHeader("Cache-Control", "private, no-store");
  setResponseHeader("Referrer-Policy", "no-referrer");
  setResponseHeader("X-Robots-Tag", "noindex, nofollow");
}

export const getWorkspaceCatalog = createServerFn({ method: "GET" })
  .middleware([agentsContextMiddleware])
  .handler(async () => {
    protectResponse();
    return (await workspaceLaunchClient()).getCatalog();
  });

export const createWorkspaceLaunch = createServerFn({ method: "POST" })
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) => workspaceLaunchRequestSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await workspaceLaunchClient()).createLaunch({
      request: data,
      principalId: context.agentsPrincipal,
    });
  });

export const getWorkspaceLaunch = createServerFn({ method: "GET" })
  .middleware([agentsContextMiddleware])
  .inputValidator((value: unknown) =>
    z.object({ launchId: launchIdSchema }).strict().parse(value),
  )
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await workspaceLaunchClient()).getLaunch({
      launchId: data.launchId,
      principalId: context.agentsPrincipal,
    });
  });
