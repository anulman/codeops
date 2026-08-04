import { createHash } from "node:crypto";
import {
  SESSION_BROKER_VERSION,
  allowedSessionActionsForState,
  sessionActionTypeSchema,
  sessionCheckpointSchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  type SessionCapability,
  type SessionCommand,
  type SessionEvent,
  type SessionSnapshot,
  type SessionState,
} from "@renoconcierge/codeops-contracts";

type LocalLifecycleCommand = Extract<
  SessionCommand,
  { readonly type: "cancel" | "archive" | "delete" }
>;
type PermissionCommand = Extract<
  SessionCommand,
  { readonly type: "respond_permission" }
>;
type ResumeCommand = Extract<SessionCommand, { readonly type: "resume" }>;
type ForkCommand = Extract<SessionCommand, { readonly type: "fork" }>;
type PromptCommand = Extract<SessionCommand, { readonly type: "prompt" }>;

export interface RuntimeCheckpointMaterial {
  readonly checkpointId: string;
  readonly patchDigest: string;
  readonly acpSessionId: string;
  readonly evidenceReferences: readonly string[];
}

export interface RuntimeLeaseMaterial {
  readonly leaseId: string;
  readonly holderId: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface RuntimeForkMaterial extends RuntimeLeaseMaterial {
  readonly sessionId: string;
  readonly branch: string;
  readonly workflowId: string;
  readonly runId: string;
}

const forkableStates = new Set<SessionState>([
  "hibernated",
  "completed",
  "failed",
  "cancelled",
  "archived",
]);

export interface LocalSessionTransition {
  readonly snapshot: SessionSnapshot;
  readonly event: SessionEvent;
}

function capabilitiesFor(
  state: SessionState,
  hasCheckpoint: boolean,
): readonly SessionCapability[] {
  const enabled = allowedSessionActionsForState(state, hasCheckpoint);
  return sessionActionTypeSchema.options.map((action) =>
    enabled.includes(action)
      ? { action, availability: "enabled" as const }
      : {
          action,
          availability: "disabled" as const,
          reason: "The current session lifecycle state does not authorize this action.",
        },
  );
}

function releaseLease(
  snapshot: SessionSnapshot,
  occurredAt: string,
): SessionSnapshot["lease"] {
  if (!snapshot.lease) {
    throw new Error("a lifecycle command requires a durable lease identity");
  }
  return {
    leaseId: snapshot.lease.leaseId,
    generation: snapshot.generation,
    status: "released",
    releasedAt: occurredAt,
  };
}

function eventId(event: Omit<SessionEvent, "eventId" | "version">): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(event))
    .digest("hex")}`;
}

export function applyLocalSessionTransition(
  snapshot: SessionSnapshot,
  command: LocalLifecycleCommand,
  occurredAt: string,
): LocalSessionTransition {
  const target = {
    cancel: { state: "cancelled", eventType: "state_changed" },
    archive: { state: "archived", eventType: "session_archived" },
    delete: { state: "deleted", eventType: "session_deleted" },
  } as const;
  const transition = target[command.type];
  const cursor = snapshot.eventCursor + 1;
  const checkpoint = command.type === "delete" ? null : snapshot.checkpoint;
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    state: transition.state,
    lease:
      command.type === "delete" ? null : releaseLease(snapshot, occurredAt),
    checkpoint,
    pendingPermission: null,
    eventCursor: cursor,
    capabilities: capabilitiesFor(transition.state, checkpoint !== null),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    cursor,
    type: transition.eventType,
    occurredAt,
  } as const;
  const event = sessionEventSchema.parse({
    version: SESSION_BROKER_VERSION.event,
    eventId: eventId(eventBody),
    ...eventBody,
  });
  return { snapshot: nextSnapshot, event };
}

export function applyPermissionSessionTransition(
  snapshot: SessionSnapshot,
  command: PermissionCommand,
  occurredAt: string,
): LocalSessionTransition {
  const request = snapshot.pendingPermission;
  if (snapshot.state !== "waiting_permission" || request === null) {
    throw new Error("permission response requires one pending request");
  }
  if (request.requestId !== command.permissionRequestId) {
    throw new Error("permission response does not match the pending request");
  }
  if (command.decision.outcome === "selected") {
    const selectedOptionId = command.decision.optionId;
    if (
      !request.options.some(({ optionId }) => optionId === selectedOptionId)
    ) {
      throw new Error("permission response selected an unknown option");
    }
  }
  const cursor = snapshot.eventCursor + 1;
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    state: "running",
    pendingPermission: null,
    eventCursor: cursor,
    capabilities: capabilitiesFor("running", snapshot.checkpoint !== null),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    cursor,
    type: "command_committed",
    occurredAt,
  } as const;
  return {
    snapshot: nextSnapshot,
    event: sessionEventSchema.parse({
      version: SESSION_BROKER_VERSION.event,
      eventId: eventId(eventBody),
      ...eventBody,
    }),
  };
}

export function applyPromptSessionTransition(
  snapshot: SessionSnapshot,
  _command: PromptCommand,
  occurredAt: string,
): LocalSessionTransition {
  if (snapshot.state !== "running") {
    throw new Error("prompt completion requires a running session");
  }
  const cursor = snapshot.eventCursor + 1;
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    eventCursor: cursor,
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    cursor,
    type: "acp_update",
    occurredAt,
  } as const;
  return {
    snapshot: nextSnapshot,
    event: sessionEventSchema.parse({
      version: SESSION_BROKER_VERSION.event,
      eventId: eventId(eventBody),
      ...eventBody,
    }),
  };
}

export function applyCheckpointSessionTransition(
  snapshot: SessionSnapshot,
  material: RuntimeCheckpointMaterial,
  occurredAt: string,
  hibernate = false,
): {
  readonly snapshot: SessionSnapshot;
  readonly events: readonly SessionEvent[];
} {
  if (
    snapshot.state !== "running" &&
    snapshot.state !== "waiting_permission"
  ) {
    throw new Error("checkpoint completion requires an active session");
  }
  const checkpointCursor = snapshot.eventCursor + 1;
  const checkpoint = sessionCheckpointSchema.parse({
    version: SESSION_BROKER_VERSION.checkpoint,
    ...material,
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    baseSha: snapshot.identity.baseSha,
    eventCursor: checkpointCursor,
    createdAt: occurredAt,
  });
  const eventBodies: readonly Omit<SessionEvent, "version" | "eventId">[] =
    hibernate
      ? [
          {
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            cursor: checkpointCursor,
            type: "checkpoint_committed",
            occurredAt,
          },
          {
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            cursor: checkpointCursor + 1,
            type: "lease_changed",
            occurredAt,
          },
        ]
      : [
          {
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            cursor: checkpointCursor,
            type: "checkpoint_committed",
            occurredAt,
          },
        ];
  const state = hibernate ? "hibernated" : snapshot.state;
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    state,
    lease: hibernate ? releaseLease(snapshot, occurredAt) : snapshot.lease,
    checkpoint,
    pendingPermission: hibernate ? null : snapshot.pendingPermission,
    eventCursor: eventBodies.at(-1)!.cursor,
    capabilities: capabilitiesFor(state, true),
    updatedAt: occurredAt,
  });
  return {
    snapshot: nextSnapshot,
    events: eventBodies.map((body) =>
      sessionEventSchema.parse({
        version: SESSION_BROKER_VERSION.event,
        eventId: eventId(body),
        ...body,
      }),
    ),
  };
}

export function applyResumeSessionTransition(
  snapshot: SessionSnapshot,
  command: ResumeCommand,
  lease: RuntimeLeaseMaterial,
  occurredAt: string,
): LocalSessionTransition {
  if (
    !(snapshot.state === "hibernated" || snapshot.state === "archived") ||
    snapshot.checkpoint?.checkpointId !== command.checkpointId
  ) {
    throw new Error(
      "resume requires the exact checkpoint from a hibernated or archived session",
    );
  }
  const generation = snapshot.generation + 1;
  const cursor = snapshot.eventCursor + 1;
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    generation,
    state: "running",
    lease: {
      ...lease,
      generation,
      status: "active",
    },
    pendingPermission: null,
    eventCursor: cursor,
    capabilities: capabilitiesFor("running", true),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation,
    cursor,
    type: "lease_changed",
    occurredAt,
  } as const;
  return {
    snapshot: nextSnapshot,
    event: sessionEventSchema.parse({
      version: SESSION_BROKER_VERSION.event,
      eventId: eventId(eventBody),
      ...eventBody,
    }),
  };
}

export function applyForkSessionTransition(
  snapshot: SessionSnapshot,
  command: ForkCommand,
  material: RuntimeForkMaterial,
  occurredAt: string,
): LocalSessionTransition {
  if (
    snapshot.checkpoint?.checkpointId !== command.checkpointId ||
    snapshot.eventCursor !== command.parentEventCursor ||
    !forkableStates.has(snapshot.state)
  ) {
    throw new Error("fork requires the exact committed parent checkpoint and cursor");
  }
  const child = sessionSnapshotSchema.parse({
    version: SESSION_BROKER_VERSION.snapshot,
    sessionId: material.sessionId,
    generation: 1,
    state: "running",
    identity: {
      ...snapshot.identity,
      branch: material.branch,
      workflowId: material.workflowId,
      runId: material.runId,
      parentSessionId: snapshot.sessionId,
      forkedAtCursor: snapshot.eventCursor,
    },
    lease: {
      leaseId: material.leaseId,
      generation: 1,
      status: "active",
      holderId: material.holderId,
      acquiredAt: material.acquiredAt,
      expiresAt: material.expiresAt,
    },
    checkpoint: null,
    pendingPermission: null,
    eventCursor: 1,
    capabilities: capabilitiesFor("running", false),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: child.sessionId,
    generation: child.generation,
    cursor: 1,
    type: "session_created",
    occurredAt,
  } as const;
  return {
    snapshot: child,
    event: sessionEventSchema.parse({
      version: SESSION_BROKER_VERSION.event,
      eventId: eventId(eventBody),
      ...eventBody,
    }),
  };
}
