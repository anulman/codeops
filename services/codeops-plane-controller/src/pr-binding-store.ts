import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const uuid = z.string().uuid();
const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const repository = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const gitRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*(?:\/\/|@\{|\\|\.\.))(?!.*\/$)[A-Za-z0-9._/-]+$/);
const nativeStack = z
  .object({
    number: z.number().int().positive().max(10_000_000),
    size: z.number().int().min(2).max(100),
    position: z.number().int().positive().max(100),
    base: z
      .object({
        ref: gitRef,
        sha: gitSha,
      })
      .strict(),
    active: z.boolean(),
  })
  .strict()
  .refine(
    (stack) => stack.position <= stack.size,
    "pull-request stack position must not exceed its size",
  );

const pullRequestBindingShape = {
  version: z.literal("codeops.pull-request-binding/v1"),
  workspaceId: uuid,
  projectId: uuid,
  workItemId: uuid,
  workflowId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  repository,
  number: z.number().int().positive().max(10_000_000),
  state: z.enum(["open", "closed", "merged"]),
  headSha: gitSha,
  headRef: gitRef,
  baseRef: gitRef,
  baseTicketId: uuid.optional(),
  nativeStack: nativeStack.optional(),
  qualified: z.boolean(),
  updatedAt: z.string().datetime({ offset: true }),
};

const legacyStoredPullRequestBindingSchema = z
  .object(pullRequestBindingShape)
  .strict();

export const storedPullRequestBindingSchema = z
  .object({
    ...pullRequestBindingShape,
    baseSha: gitSha.nullable(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.baseRef !== "main" && binding.baseTicketId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseTicketId"],
        message: "non-main PR binding requires base ticket provenance",
      });
    }
    if (binding.state !== "open" && binding.qualified) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["qualified"],
        message: "only an open PR may be qualified for stacking",
      });
    }
    if (binding.baseSha === null && binding.qualified) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["qualified"],
        message: "a binding without exact base authority cannot be qualified",
      });
    }
    if (binding.nativeStack?.active === false && binding.qualified) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["qualified"],
        message: "an inactive native stack cannot qualify a PR for stacking",
      });
    }
  });

export type StoredPullRequestBinding = z.infer<
  typeof storedPullRequestBindingSchema
>;

export interface PullRequestBindingStore {
  put(binding: StoredPullRequestBinding): Promise<void>;
  getByWorkItem(workItemId: string): Promise<StoredPullRequestBinding | null>;
  getByPullRequest(input: {
    repository: string;
    number: number;
  }): Promise<StoredPullRequestBinding | null>;
}

export function createFilePullRequestBindingStore(input: {
  rootDirectory: string;
}): PullRequestBindingStore {
  if (!path.isAbsolute(input.rootDirectory)) {
    throw new Error("pull-request binding store root must be absolute");
  }

  async function ensureRoot(): Promise<void> {
    await mkdir(input.rootDirectory, { recursive: true, mode: 0o700 });
    const root = await lstat(input.rootDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("pull-request binding store root must be a real directory");
    }
  }

  function bindingPath(workItemId: string): string {
    return path.join(input.rootDirectory, `${uuid.parse(workItemId)}.json`);
  }

  async function readBinding(
    workItemId: string,
  ): Promise<StoredPullRequestBinding | null> {
    try {
      const raw = JSON.parse(
        await readFile(bindingPath(workItemId), "utf8"),
      ) as unknown;
      const current = storedPullRequestBindingSchema.safeParse(raw);
      const binding = current.success
        ? current.data
        : storedPullRequestBindingSchema.parse({
            ...legacyStoredPullRequestBindingSchema.parse(raw),
            baseSha: null,
            qualified: false,
          });
      if (binding.workItemId !== workItemId) {
        throw new Error("pull-request binding work-item identity mismatch");
      }
      return binding;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  return {
    async put(value): Promise<void> {
      await ensureRoot();
      const binding = storedPullRequestBindingSchema.parse(value);
      const existing = await readBinding(binding.workItemId);
      if (existing !== null) {
        if (JSON.stringify(existing) === JSON.stringify(binding)) return;
        if (
          existing.workspaceId !== binding.workspaceId ||
          existing.projectId !== binding.projectId ||
          existing.workflowId !== binding.workflowId ||
          existing.repository !== binding.repository ||
          existing.number !== binding.number ||
          existing.headRef !== binding.headRef ||
          existing.baseTicketId !== binding.baseTicketId
        ) {
          throw new Error("pull-request binding identity is immutable");
        }
        if (
          (existing.nativeStack !== undefined &&
            binding.nativeStack === undefined) ||
          (existing.nativeStack !== undefined &&
            binding.nativeStack !== undefined &&
            (existing.nativeStack.number !== binding.nativeStack.number ||
              existing.nativeStack.position !== binding.nativeStack.position))
        ) {
          throw new Error("pull-request native stack provenance is immutable");
        }
        if (
          existing.nativeStack !== undefined &&
          binding.nativeStack !== undefined &&
          binding.nativeStack.active &&
          binding.nativeStack.size < existing.nativeStack.size
        ) {
          throw new Error("active pull-request native stack size cannot shrink");
        }
        if (
          existing.nativeStack === undefined &&
          binding.nativeStack !== undefined &&
          binding.qualified
        ) {
          throw new Error(
            "new native stack membership must be requalified before stacking",
          );
        }
        if (
          existing.baseRef !== binding.baseRef &&
          !(
            existing.baseTicketId !== undefined &&
            existing.baseRef !== "main" &&
            binding.baseRef === "main" &&
            binding.state === "open" &&
            !binding.qualified
          )
        ) {
          throw new Error("pull-request binding base retarget is invalid");
        }
        if (Date.parse(existing.updatedAt) >= Date.parse(binding.updatedAt)) {
          throw new Error("pull-request binding refused stale replacement");
        }
        if (existing.state === "merged") {
          throw new Error("merged pull-request binding is terminal");
        }
        if (existing.headSha !== binding.headSha && binding.qualified) {
          throw new Error(
            "changed pull-request head must be requalified before stacking",
          );
        }
        if (existing.baseSha !== binding.baseSha && binding.qualified) {
          throw new Error(
            "changed pull-request base must be requalified before stacking",
          );
        }
      }

      const target = bindingPath(binding.workItemId);
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

    async getByWorkItem(workItemId): Promise<StoredPullRequestBinding | null> {
      await ensureRoot();
      return readBinding(uuid.parse(workItemId));
    },

    async getByPullRequest(query): Promise<StoredPullRequestBinding | null> {
      await ensureRoot();
      const repo = repository.parse(query.repository);
      const number = z.number().int().positive().max(10_000_000).parse(query.number);
      const entries = (await readdir(input.rootDirectory))
        .filter((entry) => entry.endsWith(".json"))
        .sort();
      if (entries.length > 500) {
        throw new Error("pull-request binding store exceeds 500 entries");
      }
      let match: StoredPullRequestBinding | null = null;
      for (const entry of entries) {
        const workItemId = entry.slice(0, -".json".length);
        const binding = await readBinding(workItemId);
        if (binding?.repository !== repo || binding.number !== number) continue;
        if (match !== null) {
          throw new Error("pull request is bound to multiple work items");
        }
        match = binding;
      }
      return match;
    },
  };
}
