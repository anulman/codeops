import { createHash } from "node:crypto";
import {
  SESSION_BROKER_VERSION,
  sessionEventSchema,
  sessionForkComparisonSchema,
  sessionSnapshotSchema,
  type SessionEvent,
  type SessionForkCandidate,
  type SessionForkComparison,
  type SessionSnapshot,
} from "@codeops/codeops-contracts/session-broker";
import type { SessionBrokerClient } from "./sessionBroker.server";

export interface ForkComparisonCandidateInput {
  readonly snapshot: SessionSnapshot;
  readonly afterCursor: number;
  readonly events: readonly SessionEvent[];
}

export async function submitSessionForkSynthesis(input: {
  readonly broker: SessionBrokerClient;
  readonly principalId: string;
  readonly targetSessionId: string;
  readonly candidateSessionIds: readonly string[];
  readonly idempotencyKey: string;
}) {
  const [target, ...candidateSnapshots] = await Promise.all([
    input.broker.getSession(input.targetSessionId),
    ...input.candidateSessionIds.map((sessionId) => input.broker.getSession(sessionId)),
  ]);
  if (!target || candidateSnapshots.some((snapshot) => snapshot === null)) {
    throw new Error("fork comparison session is unavailable");
  }
  const candidates = await Promise.all(
    candidateSnapshots.map(async (snapshot) => {
      if (!snapshot) throw new Error("fork comparison session is unavailable");
      const page = await input.broker.getEvents({
        sessionId: snapshot.sessionId,
        afterCursor: Math.max(0, snapshot.eventCursor - 500),
        limit: 500,
      });
      return { snapshot, afterCursor: page.afterCursor, events: page.events };
    }),
  );
  const comparison = buildSessionForkComparison({ target, candidates });
  if (!target.lease) {
    throw new Error("fork synthesis target has no durable lease identity");
  }
  const submission = await input.broker.executeCommand({
    principalId: input.principalId,
    command: {
      version: "codeops.session-command/v1",
      sessionId: target.sessionId,
      generation: target.generation,
      leaseId: target.lease.leaseId,
      idempotencyKey: input.idempotencyKey,
      type: "prompt",
      prompt: renderForkSynthesisPrompt(comparison),
    },
  });
  return { comparison, submission };
}

export function buildSessionForkComparison(input: {
  readonly target: SessionSnapshot;
  readonly candidates: readonly ForkComparisonCandidateInput[];
}): SessionForkComparison {
  const target = sessionSnapshotSchema.parse(input.target);
  if (!target.capabilities.some(({ action, availability }) =>
    action === "prompt" && availability === "enabled"
  )) {
    throw new Error("fork synthesis target requires an active prompt capability");
  }
  const candidates = input.candidates.map(({ snapshot, afterCursor, events }) => ({
    snapshot: sessionSnapshotSchema.parse(snapshot),
    afterCursor,
    events: events.map((event) => sessionEventSchema.parse(event)),
  }));
  if (candidates.length < 2 || candidates.length > 4) {
    throw new Error("fork comparison requires two to four candidates");
  }
  const forkedAtCursor = candidates[0]!.snapshot.identity.forkedAtCursor;
  if (forkedAtCursor === null || target.eventCursor < forkedAtCursor) {
    throw new Error("fork synthesis target does not contain the child fork point");
  }
  for (const candidate of candidates) {
    if (candidate.snapshot.sessionId === target.sessionId) {
      throw new Error("fork comparison candidate cannot be the target");
    }
    if (
      candidate.snapshot.identity.parentSessionId !== target.sessionId ||
      candidate.snapshot.identity.forkedAtCursor !== forkedAtCursor
    ) {
      throw new Error("fork comparison candidate lineage drifted");
    }
    if (candidate.events.some((event) => event.sessionId !== candidate.snapshot.sessionId)) {
      throw new Error("fork comparison event identity drifted");
    }
    if (
      !Number.isSafeInteger(candidate.afterCursor) ||
      candidate.afterCursor < 0 ||
      candidate.events.some((event, index) => event.cursor !== candidate.afterCursor + index + 1)
    ) {
      throw new Error("fork comparison event window drifted");
    }
    const latestCursor = candidate.events.at(-1)?.cursor ?? 0;
    if (
      candidate.snapshot.eventCursor > 0 && latestCursor !== candidate.snapshot.eventCursor ||
      candidate.snapshot.eventCursor === 0 && candidate.afterCursor !== 0
    ) {
      throw new Error("fork comparison candidate cursor drifted");
    }
  }
  const content = {
    version: SESSION_BROKER_VERSION.forkComparison,
    lineage: {
      parentSessionId: target.sessionId,
      forkedAtCursor,
    },
    target: {
      sessionId: target.sessionId,
      workflowId: target.identity.workflowId,
      generation: target.generation,
      eventCursor: target.eventCursor,
    },
    candidates: candidates
      .map(({ snapshot, afterCursor, events }) => candidateFrom(snapshot, afterCursor, events))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
  } as const;
  const comparisonDigest = `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
  return sessionForkComparisonSchema.parse({ ...content, comparisonDigest });
}

export function renderForkSynthesisPrompt(comparison: SessionForkComparison): string {
  const exact = sessionForkComparisonSchema.parse(comparison);
  const { comparisonDigest, ...content } = exact;
  const expectedDigest = `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
  if (comparisonDigest !== expectedDigest) {
    throw new Error("fork comparison digest does not match its exact content");
  }
  return [
    "Synthesize the following exact CodeOps fork comparison.",
    `Comparison digest: ${comparisonDigest}`,
    "Compare behavior, observed diff size, test evidence, and risk signals. Return: (1) recommendation, (2) trade-offs, (3) retained evidence, (4) rejected alternatives, and (5) next action.",
    "Do not claim authority beyond this session policy. Do not merge, release, deploy, or mutate GitHub unless a later operation-specific permission grants that action.",
    JSON.stringify(exact),
  ].join("\n\n");
}

function candidateFrom(
  snapshot: SessionSnapshot,
  afterCursor: number,
  events: readonly SessionEvent[],
): SessionForkCandidate {
  const checkpoint = snapshot.checkpoint === null ? null : {
    checkpointId: snapshot.checkpoint.checkpointId,
    eventCursor: snapshot.checkpoint.eventCursor,
    patchDigests: ("patchDigest" in snapshot.checkpoint
      ? [snapshot.checkpoint.patchDigest]
      : [
          ...snapshot.checkpoint.sourcePatches.map(({ patchDigest }) => patchDigest),
          snapshot.checkpoint.scratchArtifactDigest,
        ]).sort(),
    evidenceReferences: [...snapshot.checkpoint.evidenceReferences].sort(),
  };
  const conclusion = [...events].reverse().find((event) =>
    event.message?.role === "assistant" && event.message.text.trim().length > 0,
  )?.message?.text.trim();
  const evidence = evidenceFrom(events, snapshot.checkpoint === null);
  return {
    sessionId: snapshot.sessionId,
    workflowId: snapshot.identity.workflowId,
    displayName: "displayName" in snapshot.identity && snapshot.identity.displayName
      ? snapshot.identity.displayName
      : snapshot.identity.runId,
    generation: snapshot.generation,
    state: snapshot.state,
    eventCursor: snapshot.eventCursor,
    eventWindow: {
      afterCursor,
      eventCount: events.length,
      truncated: afterCursor > 0,
    },
    parentSessionId: snapshot.identity.parentSessionId,
    forkedAtCursor: snapshot.identity.forkedAtCursor,
    checkpoint,
    ...evidence,
    latestConclusion: conclusion ? conclusion.slice(0, 4_000) : null,
  };
}

function evidenceFrom(events: readonly SessionEvent[], missingCheckpoint: boolean): Pick<
  SessionForkCandidate,
  "observedDiff" | "testEvidence" | "riskSignals"
> {
  const diffs = new Map<string, number>();
  const tools = new Map<string, { readonly label: string; readonly status?: string }>();
  const encoder = new TextEncoder();
  const riskSignals: string[] = [];
  for (const event of events) {
    if (event.message?.role === "assistant" && event.message.stopReason && event.message.stopReason !== "end_turn") {
      riskSignals.push(`Assistant stopped with ${event.message.stopReason}.`);
    }
    const update = event.update;
    if (!update || (update.kind !== "tool_call" && update.kind !== "tool_call_update")) continue;
    const label = (update.title ?? update.name ?? update.toolKind ?? "Tool call").trim().slice(0, 500);
    tools.set(update.toolCallId, { label, status: update.status });
    for (const content of update.content ?? []) {
      if (content.type !== "diff") continue;
      const bytes = encoder.encode(content.newText).byteLength +
        (content.oldText === undefined || content.oldText === null ? 0 : encoder.encode(content.oldText).byteLength);
      diffs.set(content.path, bytes);
    }
  }
  const completedTools = [...tools.values()].filter(
    (tool): tool is { readonly label: string; readonly status: "completed" | "failed" } =>
      (tool.status === "completed" || tool.status === "failed") &&
      /(?:^|\b)(?:tests?|checks?|verify|build|lint|typecheck|acceptance)(?:\b|$)/i.test(tool.label),
  ).slice(-20);
  for (const tool of tools.values()) {
    if (tool.status === "failed") riskSignals.push(`Failed tool: ${tool.label}`);
  }
  if (missingCheckpoint) riskSignals.push("No committed checkpoint evidence.");
  return {
    observedDiff: {
      fileCount: diffs.size,
      byteCount: [...diffs.values()].reduce((total, bytes) => total + bytes, 0),
    },
    testEvidence: completedTools,
    riskSignals: [...new Set(riskSignals)].slice(0, 20),
  };
}
