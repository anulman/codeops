import {
  canonicalSerialize,
  type WorkItemLifecycleEvent,
} from "@renoconcierge/codeops-contracts";

import type { LifecyclePublicationClaim } from "./work-item-lifecycle-journal.js";

export const WORK_ITEM_LIFECYCLE_SUBJECT = "codeops.lifecycle.v1.events";

export interface LifecycleRelayPublicationAck {
  readonly stream: string;
  readonly streamSequence: number;
  readonly duplicate: boolean;
}

export interface LifecycleRelayPorts {
  readonly claim: (input: {
    readonly claimedBy: string;
    readonly now: string;
    readonly leaseMs: number;
  }) => Promise<LifecyclePublicationClaim | null>;
  readonly publish: (input: {
    readonly subject: string;
    readonly payload: Uint8Array;
    readonly messageId: string;
  }) => Promise<LifecycleRelayPublicationAck>;
  readonly acknowledge: (input: {
    readonly eventId: string;
    readonly claimToken: string;
    readonly stream: string;
    readonly streamSequence: number;
    readonly publishedAt: string;
  }) => Promise<"published" | "duplicate">;
}

export interface LifecycleRelayResult {
  readonly status: "idle" | "published";
  readonly eventId?: string;
  readonly stream?: string;
  readonly streamSequence?: number;
  readonly jetStreamDuplicate?: boolean;
  readonly journalResult?: "published" | "duplicate";
}

function canonicalEventBytes(event: WorkItemLifecycleEvent): Uint8Array {
  return new TextEncoder().encode(canonicalSerialize(event));
}

export async function relayOneWorkItemLifecycleEvent(
  ports: LifecycleRelayPorts,
  input: {
    readonly relayId: string;
    readonly leaseMs: number;
    readonly now?: () => Date;
  },
): Promise<LifecycleRelayResult> {
  const now = input.now ?? (() => new Date());
  const claim = await ports.claim({
    claimedBy: input.relayId,
    now: now().toISOString(),
    leaseMs: input.leaseMs,
  });
  if (!claim) return { status: "idle" };

  const publication = await ports.publish({
    subject: WORK_ITEM_LIFECYCLE_SUBJECT,
    payload: canonicalEventBytes(claim.event),
    messageId: claim.event.eventId,
  });
  const publishedAt = now().toISOString();
  const journalResult = await ports.acknowledge({
    eventId: claim.event.eventId,
    claimToken: claim.claimToken,
    stream: publication.stream,
    streamSequence: publication.streamSequence,
    publishedAt,
  });
  return {
    status: "published",
    eventId: claim.event.eventId,
    stream: publication.stream,
    streamSequence: publication.streamSequence,
    jetStreamDuplicate: publication.duplicate,
    journalResult,
  };
}
