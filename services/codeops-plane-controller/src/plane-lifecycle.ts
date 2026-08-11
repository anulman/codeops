import { z } from "zod";

const uuid = z.string().uuid();
const workspaceSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const snapshotSchema = z
  .object({
    id: uuid,
    project: uuid,
    state: uuid,
    updated_at: z.string().datetime({ offset: true }),
  })
  .passthrough();

export type PlaneLifecycleClientConfig = Readonly<{
  baseUrl: string;
  workspaceSlug: string;
  apiKey: string;
  allowedTargetStateIds: readonly string[];
  fetch?: typeof fetch;
}>;

export interface PlaneLifecycleClient {
  transition(input: {
    projectId: string;
    workItemId: string;
    expectedStateId: string;
    expectedUpdatedAt: string;
    targetStateId: string;
  }): Promise<"updated" | "already-applied">;
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

/**
 * A deliberately separate capability from the content client. It can change
 * only explicitly configured lifecycle states, and only from an exact,
 * caller-observed Plane snapshot.
 */
export function createPlaneLifecycleClient(
  config: PlaneLifecycleClientConfig,
): PlaneLifecycleClient {
  const origin = planeOrigin(config.baseUrl);
  const slug = workspaceSlug.parse(config.workspaceSlug);
  if (config.apiKey.length < 16 || /\s/.test(config.apiKey)) {
    throw new Error("invalid Plane API key");
  }
  const allowedTargets = new Set(config.allowedTargetStateIds.map((id) => uuid.parse(id)));
  if (allowedTargets.size === 0) {
    throw new Error("Plane lifecycle client requires allowed target states");
  }
  const requestFetch = config.fetch ?? fetch;
  const workspacePath = `/api/v1/workspaces/${encodeURIComponent(slug)}`;

  function workItemPath(projectId: string, workItemId: string): string {
    return `${workspacePath}/projects/${encodeURIComponent(
      uuid.parse(projectId),
    )}/work-items/${encodeURIComponent(uuid.parse(workItemId))}/`;
  }

  async function read(projectId: string, workItemId: string) {
    const response = await requestFetch(
      new URL(workItemPath(projectId, workItemId), origin),
      {
        method: "GET",
        redirect: "error",
        headers: { Accept: "application/json", "X-API-Key": config.apiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Plane lifecycle snapshot failed with ${response.status}`);
    }
    return snapshotSchema.parse(await response.json());
  }

  return {
    async transition(input) {
      const projectId = uuid.parse(input.projectId);
      const workItemId = uuid.parse(input.workItemId);
      const expectedStateId = uuid.parse(input.expectedStateId);
      const expectedUpdatedAt = z
        .string()
        .datetime({ offset: true })
        .parse(input.expectedUpdatedAt);
      const targetStateId = uuid.parse(input.targetStateId);
      if (!allowedTargets.has(targetStateId)) {
        throw new Error("Plane lifecycle target state is outside configured authority");
      }

      const before = await read(projectId, workItemId);
      if (before.project !== projectId || before.id !== workItemId) {
        throw new Error("Plane lifecycle snapshot identity mismatch");
      }
      if (before.state === targetStateId) return "already-applied";
      if (
        before.state !== expectedStateId ||
        before.updated_at !== expectedUpdatedAt
      ) {
        throw new Error("Plane lifecycle snapshot drifted before transition");
      }

      const response = await requestFetch(
        new URL(workItemPath(projectId, workItemId), origin),
        {
          method: "PATCH",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-API-Key": config.apiKey,
          },
          body: JSON.stringify({ state: targetStateId }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Plane lifecycle transition failed with ${response.status}`);
      }
      const after =
        response.status === 204
          ? await read(projectId, workItemId)
          : snapshotSchema.parse(await response.json());
      if (
        after.id !== workItemId ||
        after.project !== projectId ||
        after.state !== targetStateId
      ) {
        throw new Error("Plane lifecycle transition was not confirmed");
      }
      return "updated";
    },
  };
}
