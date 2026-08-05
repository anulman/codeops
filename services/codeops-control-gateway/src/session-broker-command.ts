import type { IncomingHttpHeaders } from "node:http";
import {
  SESSION_BROKER_VERSION,
  sessionCommandAcceptedSchema,
  sessionCommandResultSchema,
  sessionCommandSchema,
  type SessionCommand,
  type SessionCommandResult,
  type SessionSnapshot,
  type SessionRuntimeDispatch,
} from "@renoconcierge/codeops-contracts";
import { authenticateBearer } from "./bearer-auth.js";
import {
  executeSessionCommandTransaction,
  type SessionMutation,
  type SessionMutationContext,
  type TransactionClient,
} from "./session-broker-repository.js";
import {
  applyLocalSessionTransition,
  applyPermissionSessionTransition,
} from "./session-broker-transitions.js";

const commandPath =
  /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/commands$/;
const localCommandTypes = new Set<SessionCommand["type"]>([
  "respond_permission",
  "cancel",
  "archive",
  "delete",
]);
const principalPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

function header(
  headers: IncomingHttpHeaders,
  name: "authorization" | "content-type" | "x-codeops-principal",
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

export class InvalidSessionCommandRequestError extends Error {}

export interface SessionBrokerCommandResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export function applyLocalSessionCommandMutation(
  snapshot: SessionSnapshot,
  command: SessionCommand,
  context: SessionMutationContext,
): SessionMutation {
  const transition = (() => {
    switch (command.type) {
      case "respond_permission":
        return applyPermissionSessionTransition(
          snapshot,
          command,
          context.committedAt,
        );
      case "cancel":
      case "archive":
      case "delete":
        return applyLocalSessionTransition(
          snapshot,
          command,
          context.committedAt,
        );
      default:
        throw new InvalidSessionCommandRequestError(
          `session command ${command.type} requires the ACP runtime`,
        );
    }
  })();
  const result = sessionCommandResultSchema.parse({
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
  return { result, events: [transition.event] };
}

export async function executeLocalSessionCommandTransaction(
  client: TransactionClient,
  input: {
    readonly command: unknown;
    readonly principalId: string;
  },
): Promise<SessionCommandResult> {
  return executeSessionCommandTransaction(client, {
    ...input,
    mutate: applyLocalSessionCommandMutation,
  });
}

export async function serveSessionBrokerCommand(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly execute: (input: {
    readonly command: unknown;
    readonly principalId: string;
  }) => Promise<SessionCommandResult>;
  readonly enqueueRuntime: (input: {
    readonly command: unknown;
    readonly principalId: string;
  }) => Promise<SessionRuntimeDispatch>;
}): Promise<SessionBrokerCommandResult | null> {
  if (input.method !== "POST" || input.url === undefined) return null;
  const url = new URL(input.url, "http://codeops.internal");
  const match = url.pathname.match(commandPath);
  if (match === null) return null;
  if ([...url.searchParams].length !== 0) {
    throw new InvalidSessionCommandRequestError(
      "session command route does not accept query parameters",
    );
  }
  if (!authenticateBearer(header(input.headers, "authorization"), input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      header(input.headers, "content-type") ?? "",
    )
  ) {
    throw new InvalidSessionCommandRequestError(
      "session command content type must be application/json",
    );
  }
  const principalId = header(input.headers, "x-codeops-principal") ?? "";
  if (!principalPattern.test(principalId)) {
    throw new InvalidSessionCommandRequestError(
      "session command principal is missing or invalid",
    );
  }
  let command: SessionCommand;
  try {
    command = sessionCommandSchema.parse(await input.readBody());
  } catch {
    throw new InvalidSessionCommandRequestError(
      "session command body is invalid",
    );
  }
  if (command.sessionId !== match[1]) {
    throw new InvalidSessionCommandRequestError(
      "session command path and body identities do not match",
    );
  }
  if (!localCommandTypes.has(command.type)) {
    const dispatch = await input.enqueueRuntime({ command, principalId });
    return {
      status: 200,
      body: sessionCommandAcceptedSchema.parse({
        version: "codeops.session-command-accepted/v1",
        disposition: "accepted",
        dispatchId: dispatch.dispatchId,
        sessionId: command.sessionId,
        generation: command.generation,
        leaseId: command.leaseId,
        idempotencyKey: command.idempotencyKey,
        type: command.type,
      }),
    };
  }
  return {
    status: 200,
    body: await input.execute({ command, principalId }),
  };
}
