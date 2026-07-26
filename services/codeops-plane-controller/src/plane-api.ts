import { z } from "zod";
import type {
  PlaneContentClient,
  PlaneLabelRecord,
  PlaneProjectContentPatch,
  PlaneWorkItemContentPatch,
  PlaneWorkItemRecord,
} from "./mutations.js";

const uuid = z.string().uuid();
const workspaceSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const labelSchema = z
  .object({
    id: uuid,
    name: z.string(),
    color: z.string(),
    description: z.string(),
  })
  .passthrough();
const workItemSchema = z
  .object({
    id: uuid,
    project: uuid,
    labels: z.array(uuid),
  })
  .passthrough();
const commentSchema = z.object({ id: uuid }).passthrough();
const labelPageSchema = z.union([
  z.array(labelSchema),
  z
    .object({
      results: z.array(labelSchema),
      next_cursor: z.string().optional(),
      next_page_results: z.boolean().optional(),
    })
    .passthrough(),
]);

export type PlaneApiClientConfig = Readonly<{
  baseUrl: string;
  workspaceSlug: string;
  apiKey: string;
  fetch?: typeof fetch;
}>;

function planeOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Plane API base URL must be a credential-free HTTPS origin");
  }
  return url;
}

function assertNoLifecycleState(body: Readonly<Record<string, unknown>>): void {
  for (const key of ["state", "state_id", "status"]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new Error(`Plane content API cannot write lifecycle field ${key}`);
    }
  }
}

export function createPlaneApiClient(
  config: PlaneApiClientConfig,
): PlaneContentClient {
  const origin = planeOrigin(config.baseUrl);
  const slug = workspaceSlug.parse(config.workspaceSlug);
  if (config.apiKey.length < 16 || /\s/.test(config.apiKey)) {
    throw new Error("invalid Plane API key");
  }
  const requestFetch = config.fetch ?? fetch;
  const workspacePath = `/api/v1/workspaces/${encodeURIComponent(slug)}`;

  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (!path.startsWith(`${workspacePath}/`)) {
      throw new Error("Plane API request escaped the configured workspace");
    }
    if (body !== undefined) assertNoLifecycleState(body);
    const response = await requestFetch(new URL(path, origin), {
      method,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": config.apiKey,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`Plane API ${method} ${path} failed with ${response.status}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  function projectPath(projectId: string): string {
    return `${workspacePath}/projects/${encodeURIComponent(uuid.parse(projectId))}`;
  }

  return {
    async getWorkItem(
      projectId: string,
      workItemId: string,
    ): Promise<PlaneWorkItemRecord> {
      return workItemSchema.parse(
        await request(
          "GET",
          `${projectPath(projectId)}/work-items/${encodeURIComponent(uuid.parse(workItemId))}/`,
        ),
      );
    },

    async listLabels(projectId: string): Promise<readonly PlaneLabelRecord[]> {
      const labels: PlaneLabelRecord[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const query =
          cursor === undefined
            ? "?per_page=100"
            : `?per_page=100&cursor=${encodeURIComponent(cursor)}`;
        const parsed = labelPageSchema.parse(
          await request("GET", `${projectPath(projectId)}/labels/${query}`),
        );
        if (Array.isArray(parsed)) return parsed;
        labels.push(...parsed.results);
        if (
          parsed.next_page_results !== true ||
          parsed.next_cursor === undefined ||
          parsed.next_cursor === ""
        ) {
          return labels;
        }
        cursor = parsed.next_cursor;
      }
      throw new Error("Plane label pagination exceeded 100 pages");
    },

    async createLabel(projectId, input): Promise<PlaneLabelRecord> {
      return labelSchema.parse(
        await request("POST", `${projectPath(projectId)}/labels/`, input),
      );
    },

    async updateLabel(projectId, labelId, input): Promise<PlaneLabelRecord> {
      return labelSchema.parse(
        await request(
          "PATCH",
          `${projectPath(projectId)}/labels/${encodeURIComponent(uuid.parse(labelId))}/`,
          input,
        ),
      );
    },

    async createComment(projectId, workItemId, input) {
      return commentSchema.parse(
        await request(
          "POST",
          `${projectPath(projectId)}/work-items/${encodeURIComponent(uuid.parse(workItemId))}/comments/`,
          { ...input, access: "INTERNAL" },
        ),
      );
    },

    async updateProject(
      projectId: string,
      input: PlaneProjectContentPatch,
    ): Promise<void> {
      await request("PATCH", `${projectPath(projectId)}/`, input);
    },

    async updateWorkItem(
      projectId: string,
      workItemId: string,
      input: PlaneWorkItemContentPatch,
    ): Promise<void> {
      await request(
        "PATCH",
        `${projectPath(projectId)}/work-items/${encodeURIComponent(uuid.parse(workItemId))}/`,
        input,
      );
    },

    async createWorkItem(projectId, input): Promise<PlaneWorkItemRecord> {
      return workItemSchema.parse(
        await request("POST", `${projectPath(projectId)}/work-items/`, input),
      );
    },
  };
}
