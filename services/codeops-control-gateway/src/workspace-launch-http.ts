import type { IncomingHttpHeaders } from "node:http";
import {
  workspaceCatalogSchema,
  workspaceLaunchSchema,
  type WorkspaceCatalog,
  type WorkspaceLaunch,
} from "@codeops/codeops-contracts";
import { ZodError } from "zod";
import { authenticateBearer } from "./bearer-auth.js";
import {
  WorkspaceLaunchConflictError,
  InvalidWorkspaceLaunchInputError,
  WorkspaceLaunchQuotaError,
} from "./workspace-launch.js";

const launchPath = /^\/v1\/workspace-launches\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

function principal(headers: IncomingHttpHeaders): string {
  const value = headers["x-codeops-principal"];
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidWorkspaceLaunchRequestError(
      "workspace launch principal is invalid",
    );
  }
  return value;
}

export class InvalidWorkspaceLaunchRequestError extends Error {}

export async function serveWorkspaceLaunch(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly catalog: WorkspaceCatalog;
  readonly admit: (request: unknown, principalId: string) => Promise<WorkspaceLaunch>;
  readonly load: (launchId: string, principalId: string) => Promise<WorkspaceLaunch | null>;
}): Promise<{
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} | null> {
  const isCatalog = input.method === "GET" && input.url === "/v1/workspace-catalog";
  const isCreate = input.method === "POST" && input.url === "/v1/workspace-launches";
  const detail = input.method === "GET" ? input.url?.match(launchPath) : null;
  if (!isCatalog && !isCreate && detail === null) return null;
  const authorization =
    typeof input.headers.authorization === "string"
      ? input.headers.authorization
      : undefined;
  if (!authenticateBearer(authorization, input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (isCatalog) {
    return { status: 200, body: workspaceCatalogSchema.parse(input.catalog) };
  }
  const principalId = principal(input.headers);
  if (isCreate) {
    if (!input.headers["content-type"]?.startsWith("application/json")) {
      return { status: 415, body: { status: "unsupported-media-type" } };
    }
    try {
      const launch = workspaceLaunchSchema.parse(
        await input.admit(await input.readBody(), principalId),
      );
      return { status: 202, body: launch };
    } catch (error) {
      if (error instanceof WorkspaceLaunchConflictError) {
        return { status: 409, body: { status: "idempotency-conflict" } };
      }
      if (error instanceof WorkspaceLaunchQuotaError) {
        return { status: 429, body: { status: "quota-exceeded" } };
      }
      if (
        error instanceof InvalidWorkspaceLaunchRequestError ||
        error instanceof InvalidWorkspaceLaunchInputError ||
        error instanceof ZodError ||
        error instanceof SyntaxError
      ) {
        throw new InvalidWorkspaceLaunchRequestError(
          "workspace launch request is invalid",
          { cause: error },
        );
      }
      throw error;
    }
  }
  const launchId = detail?.[1];
  if (!launchId) {
    throw new InvalidWorkspaceLaunchRequestError(
      "workspace launch identity is invalid",
    );
  }
  const launch = await input.load(launchId, principalId);
  return launch === null
    ? { status: 404, body: { status: "not-found" } }
    : { status: 200, body: workspaceLaunchSchema.parse(launch) };
}
