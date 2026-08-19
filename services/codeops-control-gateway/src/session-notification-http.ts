import type { IncomingHttpHeaders } from "node:http";
import {
  webPushConfigurationSchema,
  webPushSubscriptionResultSchema,
  webPushSubscriptionSchema,
  type WebPushConfiguration,
  type WebPushSubscription,
  type WebPushSubscriptionResult,
} from "@codeops/codeops-contracts/session-notification";
import { ZodError } from "zod";
import { authenticateBearer } from "./bearer-auth.js";
import { WebPushSubscriptionConflictError } from "./session-notification-store.js";

const path = "/v1/session-notifications/subscriptions";

function bearer(headers: IncomingHttpHeaders): string | undefined {
  return typeof headers.authorization === "string" ? headers.authorization : undefined;
}

function principal(headers: IncomingHttpHeaders): string {
  const value = headers["x-codeops-principal"];
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)
  ) {
    throw new InvalidSessionNotificationRequestError(
      "session notification principal is invalid",
    );
  }
  return value;
}

export class InvalidSessionNotificationRequestError extends Error {}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,128}$/.test(value)
    ? value
    : undefined;
}

export function sessionNotificationFailureEvidence(error: unknown): Readonly<{
  event: "session_notification_request_failed";
  errorType: string;
  databaseCode?: string;
  constraint?: string;
}> {
  const record = error !== null && typeof error === "object"
    ? error as { readonly name?: unknown; readonly code?: unknown; readonly constraint?: unknown }
    : {};
  return {
    event: "session_notification_request_failed",
    errorType: boundedIdentifier(record.name) ?? "UnknownError",
    ...(typeof record.code === "string" && /^[0-9A-Z]{5}$/.test(record.code)
      ? { databaseCode: record.code }
      : {}),
    ...(boundedIdentifier(record.constraint) === undefined
      ? {}
      : { constraint: boundedIdentifier(record.constraint)! }),
  };
}

export async function serveSessionNotifications(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly readToken: string;
  readonly writeToken: string;
  readonly configuration: WebPushConfiguration;
  readonly readBody: () => Promise<unknown>;
  readonly register: (
    subscription: WebPushSubscription,
    principalId: string,
  ) => Promise<WebPushSubscriptionResult>;
  readonly revoke: (
    subscription: WebPushSubscription,
    principalId: string,
  ) => Promise<WebPushSubscriptionResult>;
}): Promise<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> } | null> {
  const isConfiguration =
    input.method === "GET" && input.url === "/v1/session-notifications/config";
  const isMutation =
    (input.method === "POST" || input.method === "DELETE") && input.url === path;
  if (!isConfiguration && !isMutation) return null;

  const token = isConfiguration ? input.readToken : input.writeToken;
  if (!authenticateBearer(bearer(input.headers), token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (isConfiguration) {
    return { status: 200, body: webPushConfigurationSchema.parse(input.configuration) };
  }
  if (!input.configuration.enabled) {
    return { status: 503, body: { status: "notifications-disabled" } };
  }
  if (!input.headers["content-type"]?.startsWith("application/json")) {
    return { status: 415, body: { status: "unsupported-media-type" } };
  }
  const principalId = principal(input.headers);
  try {
    const subscription = webPushSubscriptionSchema.parse(await input.readBody());
    const result = input.method === "POST"
      ? await input.register(subscription, principalId)
      : await input.revoke(subscription, principalId);
    return { status: 200, body: webPushSubscriptionResultSchema.parse(result) };
  } catch (error) {
    if (error instanceof WebPushSubscriptionConflictError) {
      return { status: 409, body: { status: "subscription-conflict" } };
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new InvalidSessionNotificationRequestError(
        "session notification request is invalid",
        { cause: error },
      );
    }
    throw error;
  }
}
