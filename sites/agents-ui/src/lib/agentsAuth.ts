import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

function accessRequired(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.AGENTS_UI_ACCESS_REQUIRED === "true"
  );
}

function accessPrincipal(): string | null {
  return getRequestHeader("cf-access-authenticated-user-email")?.trim() || null;
}

export const agentsAuthMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const principal = accessPrincipal();
    if (accessRequired() && !principal) {
      throw new Response("Unauthorized", { status: 401 });
    }
    return next({ context: { agentsPrincipal: principal } });
  },
);
