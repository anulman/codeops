import { createMiddleware } from "@tanstack/react-start";

export const agentsContextMiddleware = createMiddleware().server(
  async ({ next }) => next({ context: { agentsPrincipal: "codeops:agents-ui" } }),
);
