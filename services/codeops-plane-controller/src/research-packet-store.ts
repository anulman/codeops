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
const storedPacketMetadataSchema = z
  .object({
    version: z.string().min(1).max(128),
    requestId: z.string().min(1).max(256),
    projectId: uuid,
    workItemId: uuid,
    createdAt: z.string().datetime({ offset: true }),
  })
  .passthrough();

type StoredPacket = Readonly<{
  metadata: z.infer<typeof storedPacketMetadataSchema>;
  packet: ResearchPacket | null;
}>;

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

  async function readStoredPacket(
    workItemId: string,
  ): Promise<StoredPacket | null> {
    try {
      const value = JSON.parse(
        await readFile(packetPath(workItemId), "utf8"),
      ) as unknown;
      const metadata = storedPacketMetadataSchema.parse(value);
      if (metadata.workItemId !== workItemId) {
        throw new Error("research packet store work-item identity mismatch");
      }
      const current = researchPacketSchema.safeParse(value);
      return {
        metadata,
        packet: current.success ? current.data : null,
      };
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
      const existing = await readStoredPacket(packet.workItemId);
      if (existing !== null) {
        if (
          existing.packet !== null &&
          existing.packet.requestId === packet.requestId &&
          canonicalSerialize(existing.packet) === canonicalSerialize(packet)
        ) {
          return;
        }
        if (
          existing.metadata.projectId !== packet.projectId ||
          Date.parse(existing.metadata.createdAt) >= Date.parse(packet.createdAt)
        ) {
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
      const stored = await readStoredPacket(query.workItemId);
      if (stored === null) return null;
      if (stored.metadata.projectId !== uuid.parse(query.projectId)) {
        throw new Error("research packet store project identity mismatch");
      }
      if (stored.packet === null) {
        throw new Error(
          "research packet store contains an unsupported legacy packet",
        );
      }
      return stored.packet;
    },
  };
}
