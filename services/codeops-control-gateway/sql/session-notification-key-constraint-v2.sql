BEGIN;

ALTER TABLE codeops.web_push_subscriptions
  DROP CONSTRAINT web_push_subscriptions_p256dh_check,
  ADD CONSTRAINT web_push_subscriptions_p256dh_check CHECK (
    char_length(p256dh) BETWEEN 40 AND 256
    AND p256dh ~ '^[A-Za-z0-9_-]+$'
  );

CREATE TEMPORARY TABLE web_push_subscription_constraint_probe
  (LIKE codeops.web_push_subscriptions INCLUDING CONSTRAINTS)
  ON COMMIT DROP;

INSERT INTO web_push_subscription_constraint_probe
  (subscription_id, principal_id, device_id, endpoint_digest, endpoint,
   expiration_time_ms, p256dh, auth, status, created_at, updated_at,
   revoked_at)
VALUES
  ('sha256:0000000000000000000000000000000000000000000000000000000000000000',
   'codeops:migration:session-notification-key-constraint-v2',
   '00000000-0000-4000-8000-000000000000',
   'sha256:1111111111111111111111111111111111111111111111111111111111111111',
   'https://example.invalid/web-push-constraint-probe', NULL,
   repeat('A', 256), repeat('B', 16), 'active', now(), now(), NULL);

COMMIT;
