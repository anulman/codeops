BEGIN;
DROP TABLE IF EXISTS codeops.session_notification_deliveries;
DROP TABLE IF EXISTS codeops.session_notification_outbox;
DROP TABLE IF EXISTS codeops.session_notification_projections;
DROP TABLE IF EXISTS codeops.web_push_subscriptions;
COMMIT;
