BEGIN;

ALTER TABLE codeops.web_push_subscriptions
  DROP CONSTRAINT web_push_subscriptions_p256dh_check,
  ADD CONSTRAINT web_push_subscriptions_p256dh_check CHECK (
    char_length(p256dh) BETWEEN 40 AND 256
    AND p256dh ~ '^[A-Za-z0-9_-]+$'
  );

DELETE FROM codeops.schema_migrations
 WHERE migration_name = 'session-notification-key-constraint-v2';

COMMIT;
