import { createHash } from "node:crypto";
import {
  SESSION_BROKER_VERSION,
  allowedSessionActionsForState,
  sessionActionTypeSchema,
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
