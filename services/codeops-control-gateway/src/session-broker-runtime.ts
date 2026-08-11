import {
  SESSION_BROKER_VERSION,
  sessionCommandResultSchema,
  sessionRuntimeCompletionSchema,
  sessionRuntimeDispatchSchema,
  sessionSnapshotSchema,
  type SessionCommandResult,
  type SessionRuntimeCommand,
  type SessionRuntimeCompletion,
  type SessionRuntimeDispatch,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
export {
  sessionRuntimeCompletionSchema,
  sessionRuntimeDispatchSchema,
  type SessionRuntimeCompletion,
  type SessionRuntimeDispatch,
} from "@codeops/codeops-contracts";
import type {
  SessionMutation,
  SessionMutationContext,
} from "./session-broker-repository.js";
import {
  applyCheckpointSessionTransition,
  applyForkSessionTransition,
  applyPromptSessionTransition,
  applyResumeSessionTransition,
} from "./session-broker-transitions.js";

export function buildSessionRuntimeDispatch(input: {
  readonly dispatchId: string;
  readonly principalId: string;
  readonly command: unknown;
  readonly snapshot: SessionSnapshot;
  readonly dispatchedAt: string;
}): SessionRuntimeDispatch {
  return sessionRuntimeDispatchSchema.parse({
    version: "codeops.session-runtime-dispatch/v1",
    ...input,
  });
}

function requireCompletionIdentity(
  dispatch: SessionRuntimeDispatch,
  completion: SessionRuntimeCompletion,
): void {
  const { command, snapshot } = dispatch;
  if (
    completion.dispatchId !== dispatch.dispatchId ||
    completion.sessionId !== command.sessionId ||
    completion.generation !== command.generation ||
    completion.leaseId !== command.leaseId ||
    completion.idempotencyKey !== command.idempotencyKey ||
    completion.type !== command.type ||
    completion.observedEventCursor !== snapshot.eventCursor ||
    Date.parse(completion.completedAt) < Date.parse(dispatch.dispatchedAt)
  ) {
    throw new Error(
      "runtime completion does not match the exact dispatch and observed snapshot",
    );
  }
}

function committedResult(
  command: SessionRuntimeCommand,
  transition: {
    readonly snapshot: SessionSnapshot;
    readonly events: SessionMutation["events"];
  },
  context: SessionMutationContext,
): SessionMutation {
  const result: SessionCommandResult = sessionCommandResultSchema.parse({
    version: SESSION_BROKER_VERSION.commandResult,
    commandId: context.commandId,
    sessionId: command.sessionId,
    generation: command.generation,
    leaseId: command.leaseId,
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    eventCursor: transition.snapshot.eventCursor,
    snapshot: transition.snapshot,
    committedAt: context.committedAt,
    disposition: "committed",
  });
  return { result, events: transition.events };
}

export function applySessionRuntimeCompletion(
  rawDispatch: unknown,
  rawCompletion: unknown,
  context: SessionMutationContext,
  rawCurrentSnapshot?: unknown,
): SessionMutation {
  const dispatch = sessionRuntimeDispatchSchema.parse(rawDispatch);
  const completion = sessionRuntimeCompletionSchema.parse(rawCompletion);
  requireCompletionIdentity(dispatch, completion);
  const { command } = dispatch;
  const snapshot = sessionSnapshotSchema.parse(
    rawCurrentSnapshot ?? dispatch.snapshot,
  );
  if (
    snapshot.sessionId !== dispatch.snapshot.sessionId ||
    snapshot.generation !== dispatch.snapshot.generation ||
    snapshot.lease?.leaseId !== dispatch.snapshot.lease?.leaseId ||
    JSON.stringify(snapshot.identity) !== JSON.stringify(dispatch.snapshot.identity) ||
    snapshot.eventCursor < dispatch.snapshot.eventCursor ||
    (command.type !== "prompt" &&
      snapshot.eventCursor !== dispatch.snapshot.eventCursor) ||
    Date.parse(completion.completedAt) < Date.parse(snapshot.updatedAt)
  ) {
    throw new Error(
      "runtime completion current snapshot does not follow the exact dispatch lineage",
    );
  }
  const transition = (() => {
    switch (command.type) {
      case "prompt": {
        if (completion.type !== "prompt") {
          throw new Error("runtime prompt completion type drifted");
        }
        const result = applyPromptSessionTransition(
          snapshot,
          command,
          completion.material,
          context.committedAt,
        );
        return result;
      }
      case "checkpoint":
      case "hibernate": {
        if (
          completion.type !== "checkpoint" &&
          completion.type !== "hibernate"
        ) {
          throw new Error("runtime checkpoint completion type drifted");
        }
        return applyCheckpointSessionTransition(
          snapshot,
          command,
          completion.material,
          context.committedAt,
        );
      }
      case "resume": {
        if (completion.type !== "resume") {
          throw new Error("runtime resume completion type drifted");
        }
        const result = applyResumeSessionTransition(
          snapshot,
          command,
          completion.material,
          context.committedAt,
        );
        return { snapshot: result.snapshot, events: [result.event] };
      }
      case "fork": {
        if (completion.type !== "fork") {
          throw new Error("runtime fork completion type drifted");
        }
        const result = applyForkSessionTransition(
          snapshot,
          command,
          completion.material,
          context.committedAt,
        );
        return { snapshot: result.snapshot, events: [result.event] };
      }
    }
  })();
  return committedResult(command, transition, context);
}
