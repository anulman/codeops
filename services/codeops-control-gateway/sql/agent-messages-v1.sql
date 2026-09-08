BEGIN;
-- Each immutable message is also its durable scoped delivery outbox entry.
-- No cascade: retiring a Session must not discard unanswered or ambiguous work.
CREATE TABLE codeops.agent_messages (
  message_id text PRIMARY KEY CHECK (message_id ~ '^sha256:[0-9a-f]{64}$'),
  thread_id text NOT NULL REFERENCES codeops.agent_messages(message_id),
  in_reply_to text UNIQUE REFERENCES codeops.agent_messages(message_id),
  session_id text NOT NULL REFERENCES codeops.sessions(session_id),
  generation bigint NOT NULL CHECK (generation > 0),
  dispatch_id uuid NOT NULL REFERENCES codeops.session_runtime_outbox(dispatch_id),
  sender text NOT NULL, recipient text NOT NULL,
  route_id text NOT NULL, route_version text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  message_json jsonb NOT NULL,
  delivered_at timestamptz, acknowledged_at timestamptz, answered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, generation, sender, idempotency_key),
  CHECK (message_json->>'messageId' IS NOT DISTINCT FROM message_id),
  CHECK (message_json->>'threadId' IS NOT DISTINCT FROM thread_id),
  CHECK (message_json->>'sessionId' IS NOT DISTINCT FROM session_id),
  CHECK ((message_json->>'generation')::bigint IS NOT DISTINCT FROM generation),
  CHECK (message_json->>'executionAuthority' IS NOT DISTINCT FROM 'false'),
  CHECK (message_json->>'version' IS NOT DISTINCT FROM 'codeops.agent-message/v1'),
  CHECK (message_json->>'sender' IS NOT DISTINCT FROM sender),
  CHECK (message_json->>'recipient' IS NOT DISTINCT FROM recipient),
  CHECK (message_json->>'routeId' IS NOT DISTINCT FROM route_id),
  CHECK (message_json->>'routeVersion' IS NOT DISTINCT FROM route_version),
  CHECK ((message_json->>'dispatchId')::uuid IS NOT DISTINCT FROM dispatch_id),
  CHECK (message_json->>'inReplyTo' IS NOT DISTINCT FROM in_reply_to),
  CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  CHECK ((in_reply_to IS NULL AND thread_id = message_id) OR
    (in_reply_to IS NOT NULL AND thread_id = in_reply_to)),
  CHECK (acknowledged_at IS NULL OR delivered_at IS NOT NULL),
  CHECK (answered_at IS NULL OR acknowledged_at IS NOT NULL)
);
CREATE INDEX agent_messages_inbox ON codeops.agent_messages(recipient, created_at, message_id)
  WHERE acknowledged_at IS NULL;
CREATE INDEX agent_messages_delivery ON codeops.agent_messages(available_at, message_id)
  WHERE delivered_at IS NULL AND attempt_count < 8;
CREATE UNIQUE INDEX agent_friction_report_identity ON codeops.agent_messages
  ((message_json#>>'{scope,projectId}'), (message_json#>>'{friction,reportId}'))
  WHERE message_json ? 'friction';
-- The register is a supervisor-owned projection. Reports never close entries.
CREATE TABLE codeops.agent_friction_register (
  repository text NOT NULL, project_id uuid NOT NULL, failure_class text NOT NULL,
  first_message_id text NOT NULL REFERENCES codeops.agent_messages(message_id),
  last_message_id text NOT NULL REFERENCES codeops.agent_messages(message_id),
  report_count integer NOT NULL CHECK (report_count > 0),
  state text NOT NULL DEFAULT 'open' CHECK (state = 'open'),
  PRIMARY KEY (repository, project_id, failure_class)
);
CREATE FUNCTION codeops.reject_agent_message_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent messages are retained';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['delivered_at','acknowledged_at','answered_at','attempt_count','available_at'])
      IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['delivered_at','acknowledged_at','answered_at','attempt_count','available_at'])
     OR (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at)
     OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
     OR (OLD.answered_at IS NOT NULL AND NEW.answered_at IS DISTINCT FROM OLD.answered_at)
     OR NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'agent message identity and progress are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_messages_immutable BEFORE UPDATE OR DELETE ON codeops.agent_messages
FOR EACH ROW EXECUTE FUNCTION codeops.reject_agent_message_rewrite();
COMMIT;
