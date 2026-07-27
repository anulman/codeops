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
  researchPacketSchema,
  type ResearchPacket,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";

const uuid = z.string().uuid();

export interface ResearchPacketStore {
  put(packet: ResearchPacket): Promise<void>;
  getLatest(input: {
    projectId: string;
    workItemId: string;
  }): Promise<ResearchPacket | null>;
}

export function createFileResearchPacketStore(input: {
  rootDirectory: string;
}): ResearchPacketStore {
  if (!path.isAbsolute(input.rootDirectory)) {
    throw new Error("research packet store root must be absolute");
  }

  async function ensureRoot(): Promise<void> {
    await mkdir(input.rootDirectory, { recursive: true, mode: 0o700 });
    const root = await lstat(input.rootDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("research packet store root must be a real directory");
    }
  }

  function packetPath(workItemId: string): string {
    return path.join(input.rootDirectory, `${uuid.parse(workItemId)}.json`);
  }

  async function readPacket(workItemId: string): Promise<ResearchPacket | null> {
    try {
      return researchPacketSchema.parse(
        JSON.parse(await readFile(packetPath(workItemId), "utf8")) as unknown,
      );
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
      const packet = researchPacketSchema.parse(value);
      const existing = await readPacket(packet.workItemId);
      if (existing !== null) {
        if (
          existing.requestId === packet.requestId &&
          canonicalSerialize(existing) === canonicalSerialize(packet)
        ) {
          return;
        }
        if (Date.parse(existing.createdAt) >= Date.parse(packet.createdAt)) {
          throw new Error(
            "research packet store refused stale or conflicting replacement",
          );
        }
      }
      const target = packetPath(packet.workItemId);
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(packet)}\n`, "utf8");
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

    async getLatest(query): Promise<ResearchPacket | null> {
      await ensureRoot();
      const packet = await readPacket(query.workItemId);
      if (packet === null) return null;
      if (packet.projectId !== uuid.parse(query.projectId)) {
        throw new Error("research packet store project identity mismatch");
      }
      return packet;
    },
  };
}
