BEGIN;

CREATE TABLE codeops.web_push_subscriptions (
  subscription_id text PRIMARY KEY
    CHECK (subscription_id ~ '^sha256:[0-9a-f]{64}$'),
  principal_id text NOT NULL
    CHECK (principal_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  device_id uuid NOT NULL,
  endpoint_digest text NOT NULL UNIQUE
    CHECK (endpoint_digest ~ '^sha256:[0-9a-f]{64}$'),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  expiration_time_ms bigint CHECK (expiration_time_ms IS NULL OR expiration_time_ms >= 0),
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{40,256}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,64}$'),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (principal_id, device_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE codeops.session_notification_projections (
  session_id text PRIMARY KEY REFERENCES codeops.sessions(session_id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0),
  event_cursor bigint NOT NULL CHECK (event_cursor >= 0),
  state text NOT NULL CHECK (state IN (
    'queued', 'running', 'waiting_permission', 'checkpointing', 'hibernated',
    'completed', 'failed', 'cancelled', 'archived'
  )),
  exhausted_limit text CHECK (exhausted_limit IS NULL OR exhausted_limit IN (
    'elapsed_time', 'total_tokens', 'model_requests', 'active_children'
  )),
  projected_at timestamptz NOT NULL
);

CREATE TABLE codeops.session_notification_outbox (
  notification_id text PRIMARY KEY
    CHECK (notification_id ~ '^sha256:[0-9a-f]{64}$'),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0),
  event_cursor bigint NOT NULL CHECK (event_cursor > 0),
  notification_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (notification_json->>'version' = 'codeops.session-push-notification/v1'),
  CHECK (notification_json->>'key' = notification_id),
  CHECK (notification_json->>'sessionId' = session_id),
  CHECK ((notification_json->>'generation')::bigint = generation),
  CHECK ((notification_json->>'eventCursor')::bigint = event_cursor)
);

CREATE TABLE codeops.session_notification_deliveries (
  notification_id text NOT NULL
    REFERENCES codeops.session_notification_outbox(notification_id) ON DELETE CASCADE,
  subscription_id text NOT NULL
    REFERENCES codeops.web_push_subscriptions(subscription_id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'claimed', 'delivered', 'failed', 'exhausted', 'revoked')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  available_at timestamptz NOT NULL,
  claim_token uuid,
  claimed_by text
    CHECK (claimed_by IS NULL OR claimed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$'),
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  last_status_code integer CHECK (last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599),
  PRIMARY KEY (notification_id, subscription_id),
  CHECK (attempt_count > 0 OR status = 'pending'),
  CHECK ((status = 'claimed') =
    (claim_token IS NOT NULL AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

CREATE INDEX session_notification_deliveries_available_idx
  ON codeops.session_notification_deliveries (available_at, notification_id, subscription_id)
  WHERE status IN ('pending', 'failed');

COMMIT;
