import { createStart } from "@tanstack/react-start";
import { agentsContextMiddleware } from "./lib/agentsContext";

export const startInstance = createStart(() => ({
  requestMiddleware: [agentsContextMiddleware],
}));
