import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import {
  workspaceLaunchRequestSchema,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import { sessionOwnerContextMiddleware } from "./sessionOwnerContext";
import { workspaceLaunchClient, readOptionalLaunch } from "./workspaceLaunch.server";

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
  .middleware([sessionOwnerContextMiddleware])
  .handler(async () => {
    protectResponse();
    return (await workspaceLaunchClient()).getCatalog();
  });

export const createWorkspaceLaunch = createServerFn({ method: "POST" })
  .middleware([sessionOwnerContextMiddleware])
  .inputValidator((value: unknown) => workspaceLaunchRequestSchema.parse(value))
  .handler(async ({ data, context }) => {
    protectResponse();
    return (await workspaceLaunchClient()).createLaunch({
      request: data,
      principalId: context.sessionOwnerPrincipal,
    });
  });

export const getWorkspaceLaunch = createServerFn({ method: "GET" })
  .middleware([sessionOwnerContextMiddleware])
  .inputValidator((value: unknown) =>
    z.object({ launchId: launchIdSchema }).strict().parse(value),
  )
  .handler(async ({ data, context }) => {
    protectResponse();
    return readOptionalLaunch(await workspaceLaunchClient(), {
      launchId: data.launchId,
      principalId: context.sessionOwnerPrincipal,
    });
  });
