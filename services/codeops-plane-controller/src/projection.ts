import { createHash } from "node:crypto";
import {
  canonicalSerialize,
  researchPacketSchema,
  type ResearchPacket,
} from "@renoconcierge/codeops-contracts";
import {
  applyResearchMutationBatch,
  type PlaneContentClient,
} from "./mutations.js";
import type {
  DedupClaim,
  ResearchDedupLedger,
} from "./dedup-ledger.js";
import type { ResearchPacketStore } from "./research-packet-store.js";

export type ResearchProjectionResult =
  | Readonly<{
      status: "busy";
      requestId: string;
      leaseExpiresAt: string;
    }>
  | Readonly<{
      status: "applied" | "duplicate";
      requestId: string;
      mutationCount: number;
    }>;

function assertTrial0Projection(packet: ResearchPacket): void {
  const mutations = packet.proposedMutations.mutations;
  if (
    mutations.length !== 2 ||
    mutations[0]?.type !== "ticket.update" ||
    mutations[1]?.type !== "comment.create" ||
    mutations.some((mutation) => mutation.targetWorkItemId !== packet.workItemId)
  ) {
    throw new Error(
      "research projection must refine and comment on only the source ticket",
    );
  }
  if (
    canonicalSerialize(mutations[1].attachments) !==
    canonicalSerialize(packet.evidence)
  ) {
    throw new Error("research projection attachments do not match packet evidence");
  }
}

export async function projectResearchPacket(input: {
  packet: unknown;
  ledger: ResearchDedupLedger;
  packetStore: ResearchPacketStore;
  client: PlaneContentClient;
  now?: () => string;
}): Promise<ResearchProjectionResult> {
  const packet = researchPacketSchema.parse(input.packet);
  assertTrial0Projection(packet);
  const now = input.now ?? (() => new Date().toISOString());
  const payloadDigest = `sha256:${createHash("sha256")
    .update(canonicalSerialize(packet))
    .digest("hex")}`;
  let claim: Extract<DedupClaim, { status: "acquired" }> | undefined;
  const claimed = await input.ledger.claim({
    kind: "projection",
    stableId: packet.requestId,
    payloadDigest,
    now: now(),
  });
  if (claimed.status === "busy") {
    return {
      status: "busy",
      requestId: packet.requestId,
      leaseExpiresAt: claimed.leaseExpiresAt,
    };
  }
  if (claimed.status === "complete") {
    if (claimed.outcome !== "mutations-applied") {
      throw new Error(
        `completed research projection has unexpected outcome ${claimed.outcome}`,
      );
    }
    return {
      status: "duplicate",
      requestId: packet.requestId,
      mutationCount: packet.proposedMutations.mutations.length,
    };
  }
  claim = claimed;

  try {
    const results = await applyResearchMutationBatch({
      batch: packet.proposedMutations,
      expected: {
        requestId: packet.requestId,
        projectId: packet.projectId,
        sourceWorkItemId: packet.workItemId,
      },
      client: input.client,
    });
    await input.packetStore.put(packet);
    await input.ledger.complete({
      claim,
      outcome: "mutations-applied",
      now: now(),
    });
    claim = undefined;
    return {
      status: "applied",
      requestId: packet.requestId,
      mutationCount: results.length,
    };
  } catch (error) {
    if (claim !== undefined) {
      await input.ledger.fail({
        claim,
        failure: "research projection failed",
        now: now(),
      });
    }
    throw error;
  }
}
