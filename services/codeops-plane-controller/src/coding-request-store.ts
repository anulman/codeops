import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  canonicalSerialize,
  codingRequestSchema,
  type CodingRequest,
} from "@codeops/codeops-contracts";
import { z } from "zod";

const uuid = z.string().uuid();

export interface CodingRequestStore {
  put(request: CodingRequest): Promise<void>;
  getInitialByWorkItem(workItemId: string): Promise<CodingRequest | null>;
}

export function createFileCodingRequestStore(input: {
  rootDirectory: string;
}): CodingRequestStore {
  if (!path.isAbsolute(input.rootDirectory)) {
    throw new Error("coding request store root must be absolute");
  }

  async function ensureRoot(): Promise<void> {
    await mkdir(input.rootDirectory, { recursive: true, mode: 0o700 });
    const root = await lstat(input.rootDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("coding request store root must be a real directory");
    }
  }

  function requestPath(workItemId: string): string {
    return path.join(input.rootDirectory, `${uuid.parse(workItemId)}.json`);
  }

  async function read(workItemId: string): Promise<CodingRequest | null> {
    try {
      const request = codingRequestSchema.parse(
        JSON.parse(await readFile(requestPath(workItemId), "utf8")) as unknown,
      );
      if (request.workItem.workItemId !== workItemId) {
        throw new Error("coding request store work-item identity mismatch");
      }
      return request;
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
      const request = codingRequestSchema.parse(value);
      if (request.humanReview !== undefined) {
        throw new Error("coding request store accepts only initial Ready requests");
      }
      const existing = await read(request.workItem.workItemId);
      if (existing !== null) {
        if (canonicalSerialize(existing) === canonicalSerialize(request)) return;
        throw new Error("initial coding request binding is immutable");
      }
      const target = requestPath(request.workItem.workItemId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(request)}\n`, "utf8");
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

    async getInitialByWorkItem(workItemId): Promise<CodingRequest | null> {
      await ensureRoot();
      return read(uuid.parse(workItemId));
    },
  };
}
