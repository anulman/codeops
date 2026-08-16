import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { TransactionClient } from "./session-broker-repository.js";

const migrations = [
  {
    name: "session-broker-v1",
    url: new URL("../sql/session-broker.sql", import.meta.url),
  },
  {
    name: "session-broker-runtime-outbox-v1",
    url: new URL("../sql/session-broker-runtime-outbox.sql", import.meta.url),
  },
  {
    name: "session-runtime-execution-receipts-v1",
    url: new URL(
      "../sql/session-runtime-execution-receipts.sql",
      import.meta.url,
    ),
  },
  {
    name: "workspace-checkpoint-artifacts-v1",
    url: new URL("../sql/workspace-checkpoint-artifacts.sql", import.meta.url),
  },
  {
    name: "session-job-initialization-v1",
    url: new URL("../sql/session-job-initialization.sql", import.meta.url),
  },
  {
    name: "session-runtime-permission-relay-v1",
    url: new URL("../sql/session-runtime-permission-relay.sql", import.meta.url),
  },
  {
    name: "session-runtime-github-mutations-v1",
    url: new URL(
      "../sql/session-runtime-github-mutations.sql",
      import.meta.url,
    ),
  },
  {
    name: "session-runtime-github-mutations-request-scoped-v2",
    url: new URL(
      "../sql/session-runtime-github-mutations-request-scoped-v2.sql",
      import.meta.url,
    ),
  },
  {
    name: "work-item-lifecycle-journal-v1",
    url: new URL("../sql/work-item-lifecycle-journal.sql", import.meta.url),
  },
  {
    name: "workspace-launch-v1",
    url: new URL("../sql/workspace-launch.sql", import.meta.url),
  },
  {
    name: "runtime-egress-pod-observations-v1",
    url: new URL(
      "../sql/runtime-egress-pod-observations-v1.sql",
      import.meta.url,
    ),
  },
  {
    name: "session-notifications-v1",
    url: new URL("../sql/session-notifications.sql", import.meta.url),
  },
  {
    name: "session-model-budget-ledger-v2",
    url: new URL("../sql/session-model-budget-ledger-v2.sql", import.meta.url),
  },
  {
    name: "session-model-budget-ledger-functions-v1",
    url: new URL(
      "../sql/session-model-budget-ledger-functions-v1.sql",
      import.meta.url,
    ),
  },
  {
    name: "session-model-budget-recovery-v1",
    url: new URL(
      "../sql/session-model-budget-recovery-v1.sql",
      import.meta.url,
    ),
  },
] as const;

function migrationDigest(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function stripTransactionEnvelope(sql: string): string {
  const match = sql.match(/^BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/);
  if (!match?.[1]) {
    throw new Error(
      "session broker migration must have one BEGIN/COMMIT envelope",
    );
  }
  return match[1];
}

export async function applySessionBrokerMigration(
  client: TransactionClient,
  sql: string,
  migrationName = "session-broker-v1",
): Promise<"applied" | "current"> {
  const sha256 = migrationDigest(sql);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('codeops.session-broker-migrations', 0))",
    );
    await client.query("CREATE SCHEMA IF NOT EXISTS codeops");
    await client.query(`CREATE TABLE IF NOT EXISTS codeops.schema_migrations (
      migration_name text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    const existing = await client.query<{ readonly sha256: unknown }>(
      `SELECT sha256
         FROM codeops.schema_migrations
        WHERE migration_name = $1
        FOR UPDATE`,
      [migrationName],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].sha256 !== sha256) {
        throw new Error(
          `session broker migration digest drift: stored ${String(existing.rows[0].sha256)}, runtime ${sha256}`,
        );
      }
      await client.query("COMMIT");
      return "current";
    }

    await client.query(stripTransactionEnvelope(sql));
    await client.query(
      `INSERT INTO codeops.schema_migrations (migration_name, sha256)
       VALUES ($1, $2)`,
      [migrationName, sha256],
    );
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrateSessionBroker(
  client: TransactionClient,
): Promise<readonly ("applied" | "current")[]> {
  const results: ("applied" | "current")[] = [];
  for (const migration of migrations) {
    results.push(
      await applySessionBrokerMigration(
        client,
        await readFile(migration.url, "utf8"),
        migration.name,
      ),
    );
  }
  return results;
}

export async function grantSessionRuntimeReceiptAccess(
  client: TransactionClient,
  role: string,
  password: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error("session runtime database role is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(password)) {
    throw new Error("session runtime database password is invalid");
  }
  const identifier = `"${role}"`;
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('codeops.session-runtime-role', 0))",
    );
    const existing = await client.query(
      "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
      [role],
    );
    const verb = existing.rows[0] ? "ALTER" : "CREATE";
    await client.query(
      `${verb} ROLE ${identifier} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );
    await client.query(`REVOKE ALL ON SCHEMA codeops FROM ${identifier}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM ${identifier}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM ${identifier}`);
    await client.query(`GRANT USAGE ON SCHEMA codeops TO ${identifier}`);
    await client.query(`GRANT SELECT (dispatch_id, dispatch_digest, status, result_json) ON codeops.session_runtime_execution_receipts TO ${identifier}`);
    await client.query(`GRANT INSERT (dispatch_id, dispatch_digest, status) ON codeops.session_runtime_execution_receipts TO ${identifier}`);
    await client.query(`GRANT UPDATE (status, result_json, completed_at) ON codeops.session_runtime_execution_receipts TO ${identifier}`);
    await client.query(`GRANT SELECT (artifact_id, session_id, generation, checkpoint_id, artifact_kind, catalog_key, artifact_digest, artifact_bytes) ON codeops.workspace_checkpoint_artifacts TO ${identifier}`);
    await client.query(`GRANT INSERT (artifact_id, session_id, generation, checkpoint_id, artifact_kind, catalog_key, artifact_digest, artifact_bytes, artifact_content) ON codeops.workspace_checkpoint_artifacts TO ${identifier}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function grantLifecycleRelayAccess(
  client: TransactionClient,
  role: string,
  password: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error("lifecycle relay database role is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(password)) {
    throw new Error("lifecycle relay database password is invalid");
  }
  const identifier = `"${role}"`;
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('codeops.lifecycle-relay-role', 0))",
    );
    const existing = await client.query(
      "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
      [role],
    );
    const verb = existing.rows[0] ? "ALTER" : "CREATE";
    await client.query(`${verb} ROLE ${identifier} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    await client.query(`REVOKE ALL ON SCHEMA codeops FROM ${identifier}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM ${identifier}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM ${identifier}`);
    await client.query(`GRANT USAGE ON SCHEMA codeops TO ${identifier}`);
    await client.query(
      `GRANT SELECT (event_id, event_json) ON codeops.work_item_lifecycle_events TO ${identifier}`,
    );
    await client.query(
      `GRANT SELECT (event_id, status, available_at, claim_token, claim_expires_at, claim_count, delivery_receipt_digest, delivery_receipt_json) ON codeops.work_item_lifecycle_publications TO ${identifier}`,
    );
    await client.query(
      `GRANT UPDATE (status, claim_token, claimed_by, claimed_at, claim_expires_at, claim_count, delivery_driver, delivery_destination, delivery_position, delivery_receipt_digest, delivery_receipt_json, published_at) ON codeops.work_item_lifecycle_publications TO ${identifier}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function grantModelProxyLedgerAccess(
  client: TransactionClient,
  role: string,
  password: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error("model proxy database role is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(password)) {
    throw new Error("model proxy database password is invalid");
  }
  const identifier = `"${role}"`;
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('codeops.model-proxy-role', 0))",
    );
    const existing = await client.query(
      "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
      [role],
    );
    const verb = existing.rows[0] ? "ALTER" : "CREATE";
    await client.query(
      `${verb} ROLE ${identifier} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );
    await client.query(`REVOKE ALL ON SCHEMA codeops FROM ${identifier}`);
    await client.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM ${identifier}`,
    );
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM ${identifier}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA codeops TO ${identifier}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION codeops.reserve_session_model_budget(uuid, text, text, text, bigint, text, text, text, bigint, bigint) TO ${identifier}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION codeops.settle_session_model_budget(uuid, text, text, bigint, bigint, bigint, text) TO ${identifier}`,
    );
    await client.query(
      `GRANT EXECUTE ON FUNCTION codeops.charge_stale_session_model_budget_reservations() TO ${identifier}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function sessionRuntimeDatabaseCredentials(
  databaseUrl: string,
  role: string,
  controlPlaneDatabaseUrl: string,
): { readonly role: string; readonly password: string } {
  let parsed: URL;
  let controlPlane: URL;
  try {
    parsed = new URL(databaseUrl);
    controlPlane = new URL(controlPlaneDatabaseUrl);
  } catch {
    throw new Error("session runtime database URL is invalid");
  }
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new Error("session runtime database credentials are invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["postgres:", "postgresql:"].includes(controlPlane.protocol) ||
    parsed.hostname === "" ||
    parsed.hostname !== controlPlane.hostname ||
    (parsed.port || "5432") !== (controlPlane.port || "5432") ||
    parsed.pathname !== controlPlane.pathname ||
    parsed.pathname === "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    username !== role
  ) {
    throw new Error("session runtime database URL is outside the receipt-only boundary");
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error("session runtime database role is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(password)) {
    throw new Error("session runtime database password is invalid");
  }
  return { role, password };
}

export function lifecycleRelayDatabaseCredentials(
  databaseUrl: string,
  role: string,
  controlPlaneDatabaseUrl: string,
): { readonly role: string; readonly password: string } {
  try {
    return sessionRuntimeDatabaseCredentials(
      databaseUrl,
      role,
      controlPlaneDatabaseUrl,
    );
  } catch (error) {
    throw new Error(
      "lifecycle relay database URL is outside the relay-only boundary",
      { cause: error },
    );
  }
}

export function modelProxyDatabaseCredentials(
  databaseUrl: string,
  role: string,
  controlPlaneDatabaseUrl: string,
): { readonly role: string; readonly password: string } {
  try {
    return sessionRuntimeDatabaseCredentials(
      databaseUrl,
      role,
      controlPlaneDatabaseUrl,
    );
  } catch (error) {
    throw new Error(
      "model proxy database URL is outside the ledger-only boundary",
      { cause: error },
    );
  }
}
