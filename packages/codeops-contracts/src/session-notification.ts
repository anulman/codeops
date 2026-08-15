import { z } from "zod";

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const supportedPushServices = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

export const webPushSubscriptionSchema = z
  .object({
    version: z.literal("codeops.web-push-subscription/v1"),
    deviceId: z.string().uuid(),
    endpoint: z.string().url().max(2_048),
    expirationTime: z.number().int().nonnegative().nullable(),
    keys: z
      .object({
        auth: base64Url.min(16).max(64),
        p256dh: base64Url.min(40).max(256),
      })
      .strict(),
  })
  .strict()
  .superRefine((subscription, context) => {
    const endpoint = new URL(subscription.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.hash !== ""
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint"],
        message: "Web Push endpoint must be one credential-free HTTPS URL",
      });
    }
    if (!supportedPushServices.has(endpoint.hostname)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint"],
        message: "Web Push endpoint must use an approved browser push service",
      });
    }
  });

export const webPushConfigurationSchema = z
  .object({
    version: z.literal("codeops.web-push-configuration/v1"),
    enabled: z.boolean(),
    publicKey: base64Url.min(80).max(128).nullable(),
  })
  .strict()
  .superRefine((configuration, context) => {
    if (configuration.enabled !== (configuration.publicKey !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publicKey"],
        message: "enabled Web Push configuration requires one public key",
      });
    }
  });

export const webPushSubscriptionResultSchema = z
  .object({
    version: z.literal("codeops.web-push-subscription-result/v1"),
    subscriptionId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    deviceId: z.string().uuid(),
    status: z.enum(["active", "revoked"]),
  })
  .strict();

export const sessionNotificationKindSchema = z.enum([
  "permission-needed",
  "validation-failed",
  "draft-pr-ready",
  "budget-exhausted",
  "session-failed",
  "session-idle",
  "session-complete",
]);

export const sessionPushNotificationSchema = z
  .object({
    version: z.literal("codeops.session-push-notification/v1"),
    key: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    kind: sessionNotificationKindSchema,
    sessionId: identifier,
    generation: z.number().int().positive(),
    eventCursor: z.number().int().positive(),
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(160),
    url: z.string().min(1).max(256),
  })
  .strict()
  .superRefine((notification, context) => {
    const expected = `/sessions/${encodeURIComponent(notification.sessionId)}`;
    if (notification.url !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "notification route must bind the exact session identity",
      });
    }
  });

export type WebPushSubscription = z.infer<typeof webPushSubscriptionSchema>;
export type WebPushConfiguration = z.infer<typeof webPushConfigurationSchema>;
export type WebPushSubscriptionResult = z.infer<typeof webPushSubscriptionResultSchema>;
export type SessionNotificationKind = z.infer<typeof sessionNotificationKindSchema>;
export type SessionPushNotification = z.infer<typeof sessionPushNotificationSchema>;
