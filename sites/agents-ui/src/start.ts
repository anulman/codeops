import { createStart } from "@tanstack/react-start";
import { agentsAuthMiddleware } from "./lib/agentsAuth";

export const startInstance = createStart(() => ({
  requestMiddleware: [agentsAuthMiddleware],
}));
