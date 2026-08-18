import { readFile } from "node:fs/promises";
import {
  workspaceCatalogSchema,
  workspaceLaunchDetailSchema,
  workspaceLaunchRequestSchema,
  workspaceLaunchSchema,
  type WorkspaceCatalog,
  type WorkspaceLaunch,
  type WorkspaceLaunchDetail,
  type WorkspaceLaunchRequest,
} from "@codeops/codeops-contracts";
import { z } from "zod";
import { parseSessionBrokerBaseUrl } from "./sessionBroker.server.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const launchIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const principalSchema = z
  .string()
  .min(3)
  .max(320)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

export interface WorkspaceLaunchClient {
  getCatalog(): Promise<WorkspaceCatalog>;
  createLaunch(input: {
    readonly request: WorkspaceLaunchRequest;
    readonly principalId: string;
  }): Promise<WorkspaceLaunch>;
  getLaunch(input: {
    readonly launchId: string;
    readonly principalId: string;
  }): Promise<WorkspaceLaunchDetail | null>;
}

export function createWorkspaceLaunchClient(input: {
  readonly baseUrl: URL;
  readonly token: string;
  readonly fetch?: typeof fetch;
}): WorkspaceLaunchClient {
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("workspace launch token length is invalid");
  }
  const request = async (
    path: string,
    options: {
      readonly method?: "GET" | "POST";
      readonly principalId?: string;
      readonly body?: string;
      readonly expectedStatus?: 200 | 202;
      readonly allowMissing?: boolean;
    } = {},
  ): Promise<unknown> => {
    const response = await (input.fetch ?? fetch)(new URL(path, input.baseUrl), {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.principalId === undefined
          ? {}
          : { "X-CodeOps-Principal": options.principalId }),
      },
      body: options.body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (options.allowMissing && response.status === 404) return null;
    if (response.status !== (options.expectedStatus ?? 200)) {
      throw new Error(`workspace launcher returned status ${response.status}`);
    }
    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      throw new Error("workspace launcher response is not JSON");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("workspace launcher response exceeds the size limit");
    }
    const responseBody = await response.text();
    if (Buffer.byteLength(responseBody) > MAX_RESPONSE_BYTES) {
      throw new Error("workspace launcher response exceeds the size limit");
    }
    return JSON.parse(responseBody);
  };

  return {
    async getCatalog() {
      return workspaceCatalogSchema.parse(await request("/v1/workspace-catalog"));
    },
    async createLaunch({ request: launchRequest, principalId }) {
      const parsedRequest = workspaceLaunchRequestSchema.parse(launchRequest);
      const parsedPrincipal = principalSchema.parse(principalId);
      return workspaceLaunchSchema.parse(
        await request("/v1/workspace-launches", {
          method: "POST",
          principalId: parsedPrincipal,
          body: JSON.stringify(parsedRequest),
          expectedStatus: 202,
        }),
      );
    },
    async getLaunch({ launchId, principalId }) {
      const parsedLaunchId = launchIdSchema.parse(launchId);
      const parsedPrincipal = principalSchema.parse(principalId);
      const response = await request(`/v1/workspace-launches/${parsedLaunchId}`, {
        principalId: parsedPrincipal,
        allowMissing: true,
      });
      return response === null
        ? null
        : workspaceLaunchDetailSchema.parse(response);
    },
  };
}

let client: Promise<WorkspaceLaunchClient> | null = null;

export function workspaceLaunchClient(): Promise<WorkspaceLaunchClient> {
  client ??= (async () => {
    const tokenPath = process.env.CODEOPS_WORKSPACE_LAUNCH_TOKEN_FILE?.trim();
    const baseUrl = process.env.CODEOPS_WORKSPACE_LAUNCH_URL?.trim();
    if (!tokenPath || !baseUrl) {
      throw new Error("workspace launcher server configuration is incomplete");
    }
    const token = await readFile(tokenPath, "utf8").then((value) => value.trim());
    return createWorkspaceLaunchClient({
      baseUrl: parseSessionBrokerBaseUrl(
        baseUrl,
        process.env.NODE_ENV,
        ["127.0.0.1", "localhost", "::1"].includes(
          process.env.HOST?.trim() ?? "",
        ),
      ),
      token,
    });
  })().catch((error) => {
    client = null;
    throw error;
  });
  return client;
}
