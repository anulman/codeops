import { randomUUID } from "node:crypto";
import * as webPush from "web-push";
import {
  sessionPushNotificationSchema,
  type SessionPushNotification,
} from "@codeops/codeops-contracts/session-notification";
import type { TransactionClient } from "./session-broker-repository.js";

const workerIdentity = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

interface ClaimRow extends Record<string, unknown> {
  readonly notification_id: unknown;
  readonly subscription_id: unknown;
  readonly endpoint: unknown;
  readonly p256dh: unknown;
  readonly auth: unknown;
  readonly notification_json: unknown;
  readonly attempt_count: unknown;
}

interface AckRow extends Record<string, unknown> {
  readonly status: unknown;
  readonly claim_token: unknown;
  readonly claimed_by: unknown;
  readonly claim_expires_at: unknown;
  readonly attempt_count: unknown;
}

export interface WebPushDeliveryClaim {
  readonly notificationId: string;
  readonly subscriptionId: string;
  readonly claimToken: string;
  readonly workerId: string;
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly notification: SessionPushNotification;
  readonly attemptCount: number;
}

export class WebPushDeliveryClaimConflictError extends Error {}

function requireWorker(value: string): string {
  if (!workerIdentity.test(value)) throw new Error("Web Push worker identity is invalid");
  return value;
}

export async function claimWebPushDelivery(input: {
  readonly database: TransactionClient;
  readonly workerId: string;
  readonly now?: Date;
  readonly leaseSeconds?: number;
  readonly claimToken?: () => string;
}): Promise<WebPushDeliveryClaim | null> {
  const workerId = requireWorker(input.workerId);
  const now = input.now ?? new Date();
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) {
    throw new Error("Web Push claim lease is invalid");
  }
  const claimToken = (input.claimToken ?? randomUUID)();
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1_000).toISOString();
  const result = await input.database.query<ClaimRow>(
    `WITH candidate AS (
       SELECT d.notification_id, d.subscription_id
         FROM codeops.session_notification_deliveries d
         JOIN codeops.web_push_subscriptions s
           ON s.subscription_id = d.subscription_id AND s.status = 'active'
        WHERE d.attempt_count < 8
          AND ((d.status IN ('pending', 'failed') AND d.available_at <= $1::timestamptz)
            OR (d.status = 'claimed' AND d.claim_expires_at <= $1::timestamptz))
        ORDER BY d.available_at, d.notification_id, d.subscription_id
        LIMIT 1
        FOR UPDATE OF d SKIP LOCKED
     )
     UPDATE codeops.session_notification_deliveries d
        SET status = 'claimed', attempt_count = d.attempt_count + 1,
            claim_token = $2::uuid, claimed_by = $3,
            claim_expires_at = $4::timestamptz
       FROM candidate c,
            codeops.session_notification_outbox o,
            codeops.web_push_subscriptions s
      WHERE d.notification_id = c.notification_id
        AND d.subscription_id = c.subscription_id
        AND o.notification_id = d.notification_id
        AND s.subscription_id = d.subscription_id
      RETURNING d.notification_id, d.subscription_id, d.attempt_count,
                s.endpoint, s.p256dh, s.auth, o.notification_json`,
    [now.toISOString(), claimToken, workerId, expiresAt],
  );
  const row = result.rows[0];
  if (!row) return null;
  const attemptCount = Number(row.attempt_count);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1 || attemptCount > 8) {
    throw new Error("stored Web Push attempt count is invalid");
  }
  const notification = sessionPushNotificationSchema.parse(row.notification_json);
  if (notification.key !== row.notification_id) {
    throw new Error("Web Push delivery notification identity drifted");
  }
  return {
    notificationId: String(row.notification_id),
    subscriptionId: String(row.subscription_id),
    claimToken,
    workerId,
    endpoint: String(row.endpoint),
    keys: { p256dh: String(row.p256dh), auth: String(row.auth) },
    notification,
    attemptCount,
  };
}

export async function acknowledgeWebPushDelivery(input: {
  readonly database: TransactionClient;
  readonly claim: WebPushDeliveryClaim;
  readonly outcome: { readonly status: "delivered"; readonly statusCode: number }
    | { readonly status: "failed"; readonly statusCode?: number };
  readonly now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  requireWorker(input.claim.workerId);
  await input.database.query("BEGIN");
  try {
    const selected = await input.database.query<AckRow>(
      `SELECT status, claim_token, claimed_by, claim_expires_at, attempt_count
         FROM codeops.session_notification_deliveries
        WHERE notification_id = $1 AND subscription_id = $2
        FOR UPDATE`,
      [input.claim.notificationId, input.claim.subscriptionId],
    );
    const row = selected.rows[0];
    if (
      !row || row.status !== "claimed" ||
      row.claim_token !== input.claim.claimToken ||
      row.claimed_by !== input.claim.workerId ||
      Date.parse(String(row.claim_expires_at)) <= now.getTime() ||
      Number(row.attempt_count) !== input.claim.attemptCount
    ) {
      throw new WebPushDeliveryClaimConflictError("Web Push delivery claim is stale");
    }
    const statusCode = input.outcome.statusCode;
    if (statusCode !== undefined &&
      (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) {
      throw new Error("Web Push response status is invalid");
    }
    if (input.outcome.status === "delivered") {
      const deliveredStatusCode = input.outcome.statusCode;
      if (deliveredStatusCode < 200 || deliveredStatusCode > 299) {
        throw new Error("delivered Web Push response must be successful");
      }
      const updated = await input.database.query(
        `UPDATE codeops.session_notification_deliveries
            SET status = 'delivered', delivered_at = $5::timestamptz,
                last_status_code = $6, claim_token = NULL,
                claimed_by = NULL, claim_expires_at = NULL
          WHERE notification_id = $1 AND subscription_id = $2
            AND status = 'claimed' AND claim_token = $3::uuid AND claimed_by = $4`,
        [input.claim.notificationId, input.claim.subscriptionId, input.claim.claimToken,
          input.claim.workerId, now.toISOString(), deliveredStatusCode],
      );
      if (updated.rowCount !== 1) {
        throw new WebPushDeliveryClaimConflictError("Web Push delivery acknowledgment lost its claim");
      }
    } else if (statusCode === 404 || statusCode === 410) {
      const revoked = await input.database.query(
        `UPDATE codeops.web_push_subscriptions
            SET status = 'revoked', revoked_at = $2::timestamptz,
                updated_at = $2::timestamptz
          WHERE subscription_id = $1 AND status = 'active'`,
        [input.claim.subscriptionId, now.toISOString()],
      );
      if (revoked.rowCount === 0) {
        throw new WebPushDeliveryClaimConflictError("Web Push endpoint revocation lost its claim");
      }
      const updated = await input.database.query(
        `UPDATE codeops.session_notification_deliveries
            SET status = 'revoked', last_status_code = $5,
                claim_token = NULL, claimed_by = NULL, claim_expires_at = NULL
          WHERE subscription_id = $1
            AND (status IN ('pending', 'failed') OR
              (notification_id = $2 AND status = 'claimed'
                AND claim_token = $3::uuid AND claimed_by = $4))`,
        [input.claim.subscriptionId, input.claim.notificationId,
          input.claim.claimToken, input.claim.workerId, statusCode],
      );
      if (updated.rowCount === 0) {
        throw new WebPushDeliveryClaimConflictError("Web Push endpoint revocation lost its delivery claim");
      }
    } else {
      const exhausted = input.claim.attemptCount >= 8;
      const retryAt = new Date(now.getTime() + Math.min(
        300_000,
        5_000 * 2 ** Math.max(0, input.claim.attemptCount - 1),
      )).toISOString();
      const updated = await input.database.query(
        `UPDATE codeops.session_notification_deliveries
            SET status = $5, available_at = $6::timestamptz,
                last_status_code = $7, claim_token = NULL,
                claimed_by = NULL, claim_expires_at = NULL
          WHERE notification_id = $1 AND subscription_id = $2
            AND status = 'claimed' AND claim_token = $3::uuid AND claimed_by = $4`,
        [input.claim.notificationId, input.claim.subscriptionId, input.claim.claimToken,
          input.claim.workerId, exhausted ? "exhausted" : "failed", retryAt,
          statusCode ?? null],
      );
      if (updated.rowCount !== 1) {
        throw new WebPushDeliveryClaimConflictError("Web Push retry acknowledgment lost its claim");
      }
    }
    await input.database.query("COMMIT");
  } catch (error) {
    await input.database.query("ROLLBACK");
    throw error;
  }
}

export async function sendClaimedWebPush(input: {
  readonly claim: WebPushDeliveryClaim;
  readonly vapid: {
    readonly subject: string;
    readonly publicKey: string;
    readonly privateKey: string;
  };
  readonly send?: typeof webPush.sendNotification;
}): Promise<{ readonly status: "delivered"; readonly statusCode: number }
  | { readonly status: "failed"; readonly statusCode?: number }> {
  try {
    const response = await (input.send ?? webPush.sendNotification)(
      {
        endpoint: input.claim.endpoint,
        keys: input.claim.keys,
      },
      JSON.stringify(input.claim.notification),
      {
        TTL: 300,
        timeout: 10_000,
        urgency: "high",
        vapidDetails: input.vapid,
      },
    );
    return response.statusCode >= 200 && response.statusCode <= 299
      ? { status: "delivered", statusCode: response.statusCode }
      : { status: "failed", statusCode: response.statusCode };
  } catch (error) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    return Number.isInteger(statusCode) && Number(statusCode) >= 100 && Number(statusCode) <= 599
      ? { status: "failed", statusCode: Number(statusCode) }
      : { status: "failed" };
  }
}
