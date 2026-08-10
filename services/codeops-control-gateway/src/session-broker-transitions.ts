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
  type SessionPermissionRequest,
  type SessionSnapshot,
  type SessionState,
  type SessionTimelineUpdate,
} from "@renoconcierge/codeops-contracts";

type LocalLifecycleCommand = Extract<
  SessionCommand,
  { readonly type: "cancel" | "archive" }
>;
type PermissionCommand = Extract<
  SessionCommand,
  { readonly type: "respond_permission" }
>;
type ResumeCommand = Extract<SessionCommand, { readonly type: "resume" }>;
type ForkCommand = Extract<SessionCommand, { readonly type: "fork" }>;
type PromptCommand = Extract<SessionCommand, { readonly type: "prompt" }>;

export interface RuntimePromptMaterial {
  readonly response: string;
  readonly stopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled";
  readonly updates?: readonly SessionTimelineUpdate[];
}

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

export function sessionCapabilitiesFor(
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
  } as const;
  const transition = target[command.type];
  const cursor = snapshot.eventCursor + 1;
  const checkpoint = snapshot.checkpoint;
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    state: transition.state,
    lease: releaseLease(snapshot, occurredAt),
    checkpoint,
    pendingPermission: null,
    eventCursor: cursor,
    capabilities: sessionCapabilitiesFor(transition.state, checkpoint !== null),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    cursor,
    type: transition.eventType,
    action: {
      type: command.type,
      ...(command.reason ? { detail: command.reason } : {}),
    },
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
  const selectedOptionId =
    command.decision.outcome === "selected" ? command.decision.optionId : null;
  const actionDecision = selectedOptionId === null
    ? ({ outcome: "denied" } as const)
    : ({
        outcome: "selected",
        optionLabel: request.options.find(
          ({ optionId }) => optionId === selectedOptionId,
        )!.label,
      } as const);
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    state: "running",
    pendingPermission: null,
    eventCursor: cursor,
    capabilities: sessionCapabilitiesFor("running", snapshot.checkpoint !== null),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    cursor,
    type: "command_committed",
    action: {
      type: "respond_permission",
      decision: actionDecision,
    },
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

export function applyRuntimePermissionRequestTransition(
  snapshot: SessionSnapshot,
  request: SessionPermissionRequest,
  occurredAt: string,
): LocalSessionTransition {
  if (snapshot.state !== "running" || snapshot.pendingPermission !== null) {
    throw new Error("runtime permission request requires one running session");
  }
  const cursor = snapshot.eventCursor + 1;
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    state: "waiting_permission",
    pendingPermission: request,
    eventCursor: cursor,
    capabilities: sessionCapabilitiesFor(
      "waiting_permission",
      snapshot.checkpoint !== null,
    ),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    cursor,
    type: "permission_requested",
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
  command: PromptCommand,
  material: RuntimePromptMaterial,
  occurredAt: string,
): {
  readonly snapshot: SessionSnapshot;
  readonly events: readonly SessionEvent[];
} {
  if (snapshot.state !== "running") {
    throw new Error("prompt completion requires a running session");
  }
  const userCursor = snapshot.eventCursor + 1;
  const userEventBody = {
    sessionId: snapshot.sessionId,
    generation: snapshot.generation,
    cursor: userCursor,
    type: "command_committed",
    message: {
      role: "user",
      text: command.prompt,
    },
    occurredAt,
  } as const;
  const retainedUpdates = (material.updates ?? []).filter(
    (update, index) =>
      !(
        index === 0 &&
        update.kind === "user_content" &&
        update.content.type === "text" &&
        update.content.text === command.prompt
      ),
  );
  const lastAssistantText = retainedUpdates.findLastIndex(
    (update) => update.kind === "assistant_content" && update.content.type === "text",
  );
  const updateEventBodies = retainedUpdates.map((update, index) => {
    const base = {
      sessionId: snapshot.sessionId,
      generation: snapshot.generation,
      cursor: userCursor + index + 1,
      type: "acp_update" as const,
      occurredAt,
    };
    if (update.kind === "assistant_content" && update.content.type === "text") {
      return {
        ...base,
        message: {
          role: "assistant" as const,
          text: update.content.text,
          ...(update.messageId !== undefined ? { messageId: update.messageId } : {}),
          ...(index === lastAssistantText ? { stopReason: material.stopReason } : {}),
        },
      };
    }
    if (update.kind === "user_content" && update.content.type === "text") {
      return {
        ...base,
        message: {
          role: "user" as const,
          text: update.content.text,
          ...(update.messageId !== undefined ? { messageId: update.messageId } : {}),
        },
      };
    }
    return { ...base, update };
  });
  if (
    lastAssistantText === -1 &&
    (material.response.length > 0 || retainedUpdates.length === 0)
  ) {
    updateEventBodies.push({
      sessionId: snapshot.sessionId,
      generation: snapshot.generation,
      cursor: userCursor + updateEventBodies.length + 1,
      type: "acp_update",
      message: {
        role: "assistant",
        text: material.response,
        stopReason: material.stopReason,
      },
      occurredAt,
    });
  }
  const eventBodies = [userEventBody, ...updateEventBodies];
  const nextSnapshot = sessionSnapshotSchema.parse({
    ...snapshot,
    eventCursor: eventBodies.at(-1)!.cursor,
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

export function applyCheckpointSessionTransition(
  snapshot: SessionSnapshot,
  command: Extract<SessionCommand, { readonly type: "checkpoint" | "hibernate" }>,
  material: RuntimeCheckpointMaterial,
  occurredAt: string,
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
  const hibernate = command.type === "hibernate";
  const eventBodies: readonly Omit<SessionEvent, "version" | "eventId">[] =
    hibernate
      ? [
          {
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            cursor: checkpointCursor,
            type: "checkpoint_committed",
            action: {
              type: "hibernate",
              ...(command.reason ? { detail: command.reason } : {}),
            },
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
            action: { type: "checkpoint" },
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
    capabilities: sessionCapabilitiesFor(state, true),
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
    capabilities: sessionCapabilitiesFor("running", true),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: snapshot.sessionId,
    generation,
    cursor,
    type: "lease_changed",
    action: { type: "resume" },
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
    capabilities: sessionCapabilitiesFor("running", false),
    updatedAt: occurredAt,
  });
  const eventBody = {
    sessionId: child.sessionId,
    generation: child.generation,
    cursor: 1,
    type: "session_created",
    action: { type: "fork", detail: command.title },
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
