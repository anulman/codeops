import { z } from "zod";
import {
  SESSION_BROKER_VERSION,
  sessionCommandResultSchema,
  sessionCommandSchema,
  sessionSnapshotSchema,
  type SessionCommand,
  type SessionCommandResult,
  type SessionSnapshot,
} from "@renoconcierge/codeops-contracts";
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

const uuid = z.string().uuid();
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const workflowRunIdentifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoDateTime = z.string().datetime({ offset: true });
const principal = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/);

const runtimeTypes = [
  "prompt",
  "checkpoint",
  "hibernate",
  "resume",
  "fork",
] as const;
export type RuntimeSessionCommand = Extract<
  SessionCommand,
  { readonly type: (typeof runtimeTypes)[number] }
>;

const runtimeCommandSchema = sessionCommandSchema.refine(
  (command): command is RuntimeSessionCommand =>
    runtimeTypes.includes(command.type as RuntimeSessionCommand["type"]),
  "session command does not require the ACP runtime",
);

export const sessionRuntimeDispatchSchema = z
  .object({
    version: z.literal("codeops.session-runtime-dispatch/v1"),
    dispatchId: uuid,
    principalId: principal,
    command: runtimeCommandSchema,
    snapshot: sessionSnapshotSchema,
    dispatchedAt: isoDateTime,
  })
  .strict()
  .superRefine((dispatch, context) => {
    const { command, snapshot } = dispatch;
    if (
      command.sessionId !== snapshot.sessionId ||
      command.generation !== snapshot.generation ||
      command.leaseId !== snapshot.lease?.leaseId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime dispatch must bind the exact session generation and lease",
        path: ["command"],
      });
    }
    const capability = snapshot.capabilities.find(
      ({ action }) => action === command.type,
    );
    if (capability?.availability !== "enabled") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime dispatch requires an enabled session capability",
        path: ["snapshot", "capabilities"],
      });
    }
  });

const completionBase = z.object({
  version: z.literal("codeops.session-runtime-completion/v1"),
  dispatchId: uuid,
  sessionId: identifier,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseId: uuid,
  idempotencyKey: uuid,
  observedEventCursor: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  completedAt: isoDateTime,
});

const checkpointMaterial = z
  .object({
    checkpointId: uuid,
    patchDigest: sha256Digest,
    acpSessionId: z.string().min(1).max(500),
    evidenceReferences: z.array(identifier).max(100),
  })
  .strict();

const leaseMaterialFields = {
  leaseId: uuid,
  holderId: identifier,
  acquiredAt: isoDateTime,
  expiresAt: isoDateTime,
} as const;

const leaseMaterial = z
  .object(leaseMaterialFields)
  .strict()
  .refine(
    (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
    "runtime lease must expire after it is acquired",
  );

const forkMaterial = z
  .object({
    ...leaseMaterialFields,
    sessionId: identifier,
    branch: z.string().min(1).max(200),
    workflowId: workflowRunIdentifier,
    runId: workflowRunIdentifier,
  })
  .strict()
  .refine(
    (lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
    "runtime lease must expire after it is acquired",
  );

export const sessionRuntimeCompletionSchema = z.discriminatedUnion("type", [
  completionBase.extend({ type: z.literal("prompt") }).strict(),
  completionBase
    .extend({ type: z.literal("checkpoint"), material: checkpointMaterial })
    .strict(),
  completionBase
    .extend({ type: z.literal("hibernate"), material: checkpointMaterial })
    .strict(),
  completionBase
    .extend({ type: z.literal("resume"), material: leaseMaterial })
    .strict(),
  completionBase
    .extend({ type: z.literal("fork"), material: forkMaterial })
    .strict(),
]);

export type SessionRuntimeDispatch = z.infer<
  typeof sessionRuntimeDispatchSchema
>;
export type SessionRuntimeCompletion = z.infer<
  typeof sessionRuntimeCompletionSchema
>;

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
  command: RuntimeSessionCommand,
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
): SessionMutation {
  const dispatch = sessionRuntimeDispatchSchema.parse(rawDispatch);
  const completion = sessionRuntimeCompletionSchema.parse(rawCompletion);
  requireCompletionIdentity(dispatch, completion);
  const { command, snapshot } = dispatch;
  const transition = (() => {
    switch (command.type) {
      case "prompt": {
        const result = applyPromptSessionTransition(
          snapshot,
          command,
          context.committedAt,
        );
        return { snapshot: result.snapshot, events: [result.event] };
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
          completion.material,
          context.committedAt,
          command.type === "hibernate",
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
