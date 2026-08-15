import { createHash } from "node:crypto";
import {
  webPushSubscriptionResultSchema,
  webPushSubscriptionSchema,
  type WebPushSubscription,
  type WebPushSubscriptionResult,
} from "@codeops/codeops-contracts/session-notification";
import type { TransactionClient } from "./session-broker-repository.js";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function subscriptionId(principal: string, deviceId: string): string {
  return digest(`${principal}\0${deviceId}`);
}

function principalId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)) {
    throw new InvalidWebPushSubscriptionError("Web Push principal is invalid");
  }
  return value;
}

export class InvalidWebPushSubscriptionError extends Error {}
export class WebPushSubscriptionConflictError extends Error {}

export async function registerWebPushSubscription(input: {
  readonly database: TransactionClient;
  readonly principalId: string;
  readonly subscription: WebPushSubscription;
  readonly now?: string;
}): Promise<WebPushSubscriptionResult> {
  const subscription = webPushSubscriptionSchema.parse(input.subscription);
  const principal = principalId(input.principalId);
  const id = subscriptionId(principal, subscription.deviceId);
  const endpointDigest = digest(subscription.endpoint);
  const now = input.now ?? new Date().toISOString();
  try {
    const result = await input.database.query(
      `INSERT INTO codeops.web_push_subscriptions
         (subscription_id, principal_id, device_id, endpoint_digest, endpoint,
          expiration_time_ms, p256dh, auth, status, created_at, updated_at,
          revoked_at)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, 'active',
               $9::timestamptz, $9::timestamptz, NULL)
       ON CONFLICT (subscription_id) DO UPDATE
         SET endpoint_digest = EXCLUDED.endpoint_digest,
             endpoint = EXCLUDED.endpoint,
             expiration_time_ms = EXCLUDED.expiration_time_ms,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             status = 'active',
             updated_at = EXCLUDED.updated_at,
             revoked_at = NULL
       RETURNING subscription_id`,
      [
        id,
        principal,
        subscription.deviceId,
        endpointDigest,
        subscription.endpoint,
        subscription.expirationTime,
        subscription.keys.p256dh,
        subscription.keys.auth,
        now,
      ],
    );
    if (result.rowCount !== 1 || result.rows[0]?.subscription_id !== id) {
      throw new Error("Web Push subscription persistence returned the wrong identity");
    }
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "23505") {
      throw new WebPushSubscriptionConflictError(
        "Web Push endpoint is already bound to another principal or device",
        { cause: error },
      );
    }
    throw error;
  }
  return webPushSubscriptionResultSchema.parse({
    version: "codeops.web-push-subscription-result/v1",
    subscriptionId: id,
    deviceId: subscription.deviceId,
    status: "active",
  });
}

export async function revokeWebPushSubscription(input: {
  readonly database: TransactionClient;
  readonly principalId: string;
  readonly subscription: WebPushSubscription;
  readonly now?: string;
}): Promise<WebPushSubscriptionResult> {
  const subscription = webPushSubscriptionSchema.parse(input.subscription);
  const principal = principalId(input.principalId);
  const id = subscriptionId(principal, subscription.deviceId);
  const endpointDigest = digest(subscription.endpoint);
  const result = await input.database.query(
    `UPDATE codeops.web_push_subscriptions
        SET status = 'revoked', revoked_at = $4::timestamptz,
            updated_at = $4::timestamptz
      WHERE subscription_id = $1 AND principal_id = $2
        AND device_id = $3::uuid AND endpoint_digest = $5
      RETURNING subscription_id`,
    [id, principal, subscription.deviceId, input.now ?? new Date().toISOString(), endpointDigest],
  );
  if (result.rowCount !== 1 || result.rows[0]?.subscription_id !== id) {
    throw new WebPushSubscriptionConflictError(
      "Web Push subscription is not bound to this principal and device",
    );
  }
  return webPushSubscriptionResultSchema.parse({
    version: "codeops.web-push-subscription-result/v1",
    subscriptionId: id,
    deviceId: subscription.deviceId,
    status: "revoked",
  });
}
