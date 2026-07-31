import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const uuid = z.string().uuid();
export const storedWorkflowBindingSchema = z
  .object({
    version: z.literal("codeops.workflow-binding/v1"),
    workspaceId: uuid,
    projectId: uuid,
    workItemId: uuid,
    workflowId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    status: z.enum(["active", "terminal"]),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z
      .string()
      .min(1)
      .max(200)
      .regex(/^(?!\/|.*(?:\/\/|@\{|\\|\.\.))(?!.*\/$)[A-Za-z0-9._/-]+$/),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type StoredWorkflowBinding = z.infer<typeof storedWorkflowBindingSchema>;

export interface WorkflowBindingStore {
  put(binding: StoredWorkflowBinding): Promise<void>;
  getByWorkItem(workItemId: string): Promise<StoredWorkflowBinding | null>;
}

export function createFileWorkflowBindingStore(input: {
  rootDirectory: string;
}): WorkflowBindingStore {
  if (!path.isAbsolute(input.rootDirectory)) {
    throw new Error("workflow binding store root must be absolute");
  }
  async function ensureRoot(): Promise<void> {
    await mkdir(input.rootDirectory, { recursive: true, mode: 0o700 });
    const root = await lstat(input.rootDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("workflow binding store root must be a real directory");
    }
  }
  function recordPath(workItemId: string): string {
    return path.join(input.rootDirectory, `${uuid.parse(workItemId)}.json`);
  }
  async function read(workItemId: string): Promise<StoredWorkflowBinding | null> {
    try {
      const record = storedWorkflowBindingSchema.parse(
        JSON.parse(await readFile(recordPath(workItemId), "utf8")) as unknown,
      );
      if (record.workItemId !== workItemId) {
        throw new Error("workflow binding work-item identity mismatch");
      }
      return record;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  return {
    async put(value) {
      await ensureRoot();
      const binding = storedWorkflowBindingSchema.parse(value);
      const existing = await read(binding.workItemId);
      if (existing !== null) {
        if (JSON.stringify(existing) === JSON.stringify(binding)) return;
        if (
          existing.workspaceId !== binding.workspaceId ||
          existing.projectId !== binding.projectId
        ) {
          throw new Error("workflow binding identity is immutable");
        }
        if (Date.parse(existing.updatedAt) >= Date.parse(binding.updatedAt)) {
          throw new Error("workflow binding refused stale replacement");
        }
        if (existing.workflowId !== binding.workflowId) {
          if (existing.status !== "terminal" || binding.status !== "active") {
            throw new Error(
              "only a terminal workflow may advance to a new active revision",
            );
          }
          if (existing.branch !== binding.branch) {
            throw new Error(
              "workflow revision must retain the bound pull-request branch",
            );
          }
        } else if (
          existing.baseSha !== binding.baseSha ||
          existing.branch !== binding.branch
        ) {
          throw new Error("workflow binding identity is immutable");
        } else if (existing.status === "terminal") {
          throw new Error("terminal workflow binding is immutable");
        }
      }
      const target = recordPath(binding.workItemId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(binding)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, target);
        const root = await open(input.rootDirectory, "r");
        try {
          await root.sync();
        } finally {
          await root.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async getByWorkItem(workItemId) {
      await ensureRoot();
      return read(uuid.parse(workItemId));
    },
  };
}
