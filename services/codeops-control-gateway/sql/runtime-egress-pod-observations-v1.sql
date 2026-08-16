BEGIN;

CREATE TABLE codeops.runtime_egress_pod_observations (
  session_id text NOT NULL
    REFERENCES codeops.sessions(session_id)
    CHECK (session_id ~ '^ses_[0-9a-f]{24}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  pod_uid text NOT NULL CHECK (
    length(pod_uid) BETWEEN 1 AND 128 AND
    pod_uid ~ '^[A-Za-z0-9._:-]+$'
  ),
  pod_ip inet NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, generation, pod_uid, pod_ip)
);

CREATE INDEX runtime_egress_pod_observation_lookup_idx
  ON codeops.runtime_egress_pod_observations (pod_ip, observed_at);

COMMIT;
