import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import {
  readCloudflareAccessConfiguration,
  verifyCloudflareAccessJwt,
} from "./cloudflareAccess.server";

function accessRequired(): boolean {
  const localHost = process.env.HOST?.trim();
  if (
    process.env.AGENTS_UI_ACCESS_REQUIRED === "false" &&
    (localHost === "127.0.0.1" || localHost === "localhost" || localHost === "::1")
  ) {
    return false;
  }
  return (
    process.env.NODE_ENV === "production" ||
    process.env.AGENTS_UI_ACCESS_REQUIRED === "true"
  );
}

let configuration: ReturnType<typeof readCloudflareAccessConfiguration> | null = null;

async function accessPrincipal(): Promise<string | null> {
  const token = getRequestHeader("cf-access-jwt-assertion")?.trim();
  if (!token) return null;
  configuration ??= readCloudflareAccessConfiguration({
    issuer: process.env.AGENTS_UI_ACCESS_ISSUER,
    audience: process.env.AGENTS_UI_ACCESS_AUDIENCE,
    allowedEmailsFile: process.env.AGENTS_UI_ACCESS_ALLOWED_EMAILS_FILE,
  }).catch((error) => {
    configuration = null;
    throw error;
  });
  return verifyCloudflareAccessJwt({
    token,
    configuration: await configuration,
  });
}

export const agentsAuthMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    let principal: string | null = null;
    try {
      principal = await accessPrincipal();
    } catch {
      throw new Response("Unauthorized", { status: 401 });
    }
    if (accessRequired() && !principal) {
      throw new Response("Unauthorized", { status: 401 });
    }
    return next({ context: { agentsPrincipal: principal } });
  },
);
