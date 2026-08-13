import { z } from "zod";
import type {
  PlaneContentClient,
  PlaneWorkItemContentPatch,
  PlaneWorkItemRecord,
} from "./mutations.js";

const uuid = z.string().uuid();
const workspaceSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const workItemSchema = z
  .object({
    id: uuid,
    project: uuid,
    labels: z.array(uuid),
    name: z.string().max(500).default(""),
    description_html: z.string().nullable().optional(),
    priority: z.string().max(64).default("none"),
    state: uuid.optional(),
    updated_at: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();
const workItemPageSchema = z.union([
  z.array(workItemSchema),
  z
    .object({
      results: z.array(workItemSchema),
      next_cursor: z.string().optional(),
      next_page_results: z.boolean().optional(),
    })
    .passthrough(),
]);
const intakeWorkItemSchema = z
  .object({
    id: uuid,
    issue: workItemSchema,
  })
  .passthrough();
const commentSchema = z
  .object({
    id: uuid,
    comment_html: z.string().max(50_000).default(""),
    created_by: uuid.optional(),
    created_at: z.string().datetime({ offset: true }).optional(),
    external_source: z.string().nullable().optional(),
    external_id: z.string().nullable().optional(),
  })
  .passthrough();
const commentPageSchema = z.union([
  z.array(commentSchema),
  z
    .object({
      results: z.array(commentSchema),
      next_cursor: z.string().optional(),
      next_page_results: z.boolean().optional(),
    })
    .passthrough(),
]);
const relationsSchema = z.record(
  z.array(
    z
      .object({
        project_id: uuid,
        issue_id: uuid,
      })
      .passthrough(),
  ),
);

export type PlaneApiClientConfig = Readonly<{
  baseUrl: string;
  workspaceSlug: string;
  apiKey: string;
  fetch?: typeof fetch;
}>;

export interface PlaneApiClient extends PlaneContentClient {
  getProjectSnapshot(projectId: string): Promise<unknown>;
  getWorkItemSnapshot(
    projectId: string,
    workItemId: string,
  ): Promise<unknown>;
  getWorkItemComments(
    projectId: string,
    workItemId: string,
  ): Promise<readonly unknown[]>;
  getWorkItemRelations(projectId: string, workItemId: string): Promise<unknown>;
  listProjectWorkItemSnapshots(projectId: string): Promise<readonly unknown[]>;
}

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
): PlaneApiClient {
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

  async function listWorkItemComments(
    projectId: string,
    workItemId: string,
  ): Promise<readonly z.infer<typeof commentSchema>[]> {
    const commentsPath = `${projectPath(projectId)}/work-items/${encodeURIComponent(
      uuid.parse(workItemId),
    )}/comments/`;
    const comments: z.infer<typeof commentSchema>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query =
        cursor === undefined
          ? "?per_page=100"
          : `?per_page=100&cursor=${encodeURIComponent(cursor)}`;
      const listed = commentPageSchema.parse(
        await request("GET", `${commentsPath}${query}`),
      );
      if (Array.isArray(listed)) {
        comments.push(...listed);
        return comments;
      }
      comments.push(...listed.results);
      if (
        listed.next_page_results !== true ||
        listed.next_cursor === undefined ||
        listed.next_cursor === ""
      ) {
        return comments;
      }
      cursor = listed.next_cursor;
    }
    throw new Error("Plane comment pagination exceeded 100 pages");
  }

  async function listProjectWorkItems(
    projectId: string,
  ): Promise<readonly z.infer<typeof workItemSchema>[]> {
    const items: z.infer<typeof workItemSchema>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const query =
        cursor === undefined
          ? "?per_page=100"
          : `?per_page=100&cursor=${encodeURIComponent(cursor)}`;
      const listed = workItemPageSchema.parse(
        await request("GET", `${projectPath(projectId)}/work-items/${query}`),
      );
      if (Array.isArray(listed)) {
        if (listed.length > 200) {
          throw new Error("Plane project task index exceeds 200 work items");
        }
        return listed;
      }
      items.push(...listed.results);
      if (items.length > 200) {
        throw new Error("Plane project task index exceeds 200 work items");
      }
      if (
        listed.next_page_results !== true ||
        listed.next_cursor === undefined ||
        listed.next_cursor === ""
      ) {
        return items;
      }
      cursor = listed.next_cursor;
    }
    throw new Error("Plane project task index exceeds 200 work items");
  }

  return {
    async getProjectSnapshot(projectId: string): Promise<unknown> {
      return request("GET", `${projectPath(projectId)}/`);
    },

    async getWorkItemSnapshot(
      projectId: string,
      workItemId: string,
    ): Promise<unknown> {
      return request(
        "GET",
        `${projectPath(projectId)}/work-items/${encodeURIComponent(uuid.parse(workItemId))}/`,
      );
    },

    async getWorkItemComments(projectId, workItemId) {
      return listWorkItemComments(projectId, workItemId);
    },

    async getWorkItemRelations(projectId, workItemId) {
      return relationsSchema.parse(
        await request(
          "GET",
          `${projectPath(projectId)}/work-items/${encodeURIComponent(
            uuid.parse(workItemId),
          )}/relations/`,
        ),
      );
    },

    async listProjectWorkItemSnapshots(projectId) {
      // Admission binds this immutable index into the research request, so
      // preserve Plane's full snapshot shape. The content-mutation adapter's
      // narrower PlaneWorkItemRecord projection is only appropriate when
      // reconciling one specifically permitted write.
      return listProjectWorkItems(projectId);
    },

    async listProjectWorkItems(projectId) {
      return (await listProjectWorkItems(projectId)).map((item) => ({
        id: item.id,
        project: item.project,
        labels: item.labels,
        name: item.name,
        descriptionHtml: item.description_html ?? "",
      }));
    },

    async getWorkItem(
      projectId: string,
      workItemId: string,
    ): Promise<PlaneWorkItemRecord> {
      const item = workItemSchema.parse(
        await request(
          "GET",
          `${projectPath(projectId)}/work-items/${encodeURIComponent(uuid.parse(workItemId))}/`,
        ),
      );
      return {
        id: item.id,
        project: item.project,
        labels: item.labels,
        name: item.name,
        descriptionHtml: item.description_html ?? "",
      };
    },

    async createComment(projectId, workItemId, input) {
      const commentsPath = `${projectPath(projectId)}/work-items/${encodeURIComponent(
        uuid.parse(workItemId),
      )}/comments/`;
      const comments = await listWorkItemComments(projectId, workItemId);
      const matches = comments.filter(
        (comment) =>
          comment.external_source === input.external_source &&
          comment.external_id === input.external_id,
      );
      if (matches.length > 1) {
        throw new Error("duplicate Plane comments share the CodeOps identity");
      }
      if (matches.length === 1) return matches[0]!;
      return commentSchema.parse(
        await request(
          "POST",
          commentsPath,
          { ...input, access: "INTERNAL" },
        ),
      );
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
      const item = workItemSchema.parse(
        await request("POST", `${projectPath(projectId)}/work-items/`, input),
      );
      return {
        id: item.id,
        project: item.project,
        labels: item.labels,
        name: item.name,
        descriptionHtml: item.description_html ?? "",
      };
    },

    async createIntakeWorkItem(projectId, input): Promise<PlaneWorkItemRecord> {
      const intake = intakeWorkItemSchema.parse(
        await request("POST", `${projectPath(projectId)}/intake-issues/`, {
          issue: input,
        }),
      );
      return {
        id: intake.issue.id,
        project: intake.issue.project,
        labels: intake.issue.labels,
        name: intake.issue.name,
        descriptionHtml: intake.issue.description_html ?? "",
      };
    },

  };
}
