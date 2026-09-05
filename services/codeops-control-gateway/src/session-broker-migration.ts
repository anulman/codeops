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
    name: "provider-effect-receipts-v1",
    url: new URL("../sql/provider-effect-receipts-v1.sql", import.meta.url),
  },
  {
    name: "provider-effect-publication-operations-v2",
    url: new URL(
      "../sql/provider-effect-publication-operations-v2.sql",
      import.meta.url,
    ),
  },
  {
    name: "github-branch-publish-candidates-v1",
    url: new URL(
      "../sql/github-branch-publish-candidates-v1.sql",
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
    name: "session-notification-key-constraint-v2",
    url: new URL(
      "../sql/session-notification-key-constraint-v2.sql",
      import.meta.url,
    ),
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
    name: "session-dispatch-model-authority-v1",
    url: new URL(
      "../sql/session-dispatch-model-authority-v1.sql",
      import.meta.url,
    ),
  },
  {
    name: "session-dispatch-model-authority-v2",
    url: new URL(
      "../sql/session-dispatch-model-authority-v2.sql",
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
  {
    name: "session-owner-v1",
    url: new URL("../sql/session-owner-v1.sql", import.meta.url),
  },
  {
    name: "session-agent-terminal-progress-v1",
    url: new URL(
      "../sql/session-agent-terminal-progress-v1.sql",
      import.meta.url,
    ),
  },
  {
    name: "session-runtime-terminal-reconciliation-v1",
    url: new URL(
      "../sql/session-runtime-terminal-reconciliation-v1.sql",
      import.meta.url,
    ),
  },
  {
    name: "work-item-admission-v1",
    url: new URL("../sql/work-item-admission-v1.sql", import.meta.url),
  },
  {
    name: "runtime-compatible-substitution-v1",
    url: new URL("../sql/runtime-compatible-substitution-v1.sql", import.meta.url),
  },
  {
    name: "runtime-permission-consumption-v1",
    url: new URL(
      "../sql/runtime-permission-consumption-v1.sql",
      import.meta.url,
    ),
  },
  {
    name: "admitted-child-materializations-v1",
    url: new URL(
      "../sql/admitted-child-materializations-v1.sql",
      import.meta.url,
    ),
  },
  {
    name: "work-item-retry-v1",
    url: new URL("../sql/work-item-retry-v1.sql", import.meta.url),
  },
] as const;

const ownerPrincipalPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const kubernetesUidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface MigrationSettings {
  readonly legacySessionOwnerPrincipalId?: string;
  readonly retainedRuntimeJobUids?: readonly string[];
}

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
  settings: MigrationSettings = {},
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

    if (settings.legacySessionOwnerPrincipalId !== undefined) {
      if (!ownerPrincipalPattern.test(settings.legacySessionOwnerPrincipalId)) {
        throw new Error("legacy session owner principal is invalid");
      }
      await client.query(
        "SELECT pg_catalog.set_config('codeops.legacy_session_owner_principal_id', $1, true)",
        [settings.legacySessionOwnerPrincipalId],
      );
    }
    if (settings.retainedRuntimeJobUids !== undefined) {
      const uids = settings.retainedRuntimeJobUids;
      if (
        uids.some((uid) => !kubernetesUidPattern.test(uid)) ||
        new Set(uids).size !== uids.length ||
        uids.some((uid, index) => index > 0 && uids[index - 1]! >= uid)
      ) {
        throw new Error(
          "retained runtime Job UID allowlist must be unique and sorted",
        );
      }
      await client.query(
        "SELECT pg_catalog.set_config('codeops.retained_runtime_job_uids', $1, true)",
        [JSON.stringify(uids)],
      );
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
  input: MigrationSettings = {},
): Promise<readonly ("applied" | "current")[]> {
  const results: ("applied" | "current")[] = [];
  for (const migration of migrations) {
    results.push(
      await applySessionBrokerMigration(
        client,
        await readFile(migration.url, "utf8"),
        migration.name,
        migration.name === "session-owner-v1"
          ? { legacySessionOwnerPrincipalId: input.legacySessionOwnerPrincipalId }
          : migration.name === "session-runtime-terminal-reconciliation-v1"
            ? { retainedRuntimeJobUids: input.retainedRuntimeJobUids ?? [] }
            : {},
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
      `${verb} ROLE ${identifier} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await requireUnownedDatabaseRole(client, role);
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
    await client.query(`${verb} ROLE ${identifier} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await requireUnownedDatabaseRole(client, role);
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
      `${verb} ROLE ${identifier} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await requireUnownedDatabaseRole(client, role);
    await client.query(`REVOKE ALL ON SCHEMA codeops FROM ${identifier}`);
    await client.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM ${identifier}`,
    );
    await client.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM ${identifier}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA codeops TO ${identifier}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION codeops.reserve_session_dispatch_model_budget(uuid, text, text, text, bigint, uuid, uuid, bigint, text, text, text, bigint, bigint) TO ${identifier}`,
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

/** Read-only startup check. Runtime must never migrate or own database objects. */
export async function requireApplicationDatabaseAuthority(client: TransactionClient): Promise<void> {
  const unsafe = await client.query(`SELECT r.rolname FROM pg_roles r
    WHERE pg_has_role(current_user, r.oid, 'MEMBER') AND (
      r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR r.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
      OR r.oid IN (SELECT nspowner FROM pg_namespace WHERE nspname = 'codeops')
      OR r.oid IN (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='codeops')
      OR r.oid IN (SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='codeops')
    )`);
  if (unsafe.rows.length) throw new Error('Application database authority permits ownership or administration');
  const privilege = await client.query<{ unsafe: boolean }>(`SELECT
    has_schema_privilege(current_user, 'codeops', 'CREATE') OR
    has_database_privilege(current_user, current_database(), 'CREATE') AS unsafe`);
  if (privilege.rows[0]?.unsafe !== false) throw new Error('Application database authority permits schema creation');
  const applied = await client.query<{ migration_name: string; sha256: string }>(
    'SELECT migration_name, sha256 FROM codeops.schema_migrations');
  for (const migration of migrations) {
    const row = applied.rows.find(row => row.migration_name === migration.name);
    if (!row || row.sha256 !== migrationDigest(await readFile(migration.url, 'utf8'))) {
      throw new Error('Deployment migration is required before application startup');
    }
  }
}

/** Deployment-only provisioning. Never grant role membership to runtime identities. */
export async function grantApplicationDatabaseAccess(
  client: TransactionClient, role: string, password: string,
): Promise<void> {
  if (role !== 'codeops_app' || !/^[A-Za-z0-9._~-]{32,256}$/.test(password)) {
    throw new Error('Application database credentials are invalid');
  }
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('codeops.application-role', 0))");
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (!existing.rows.length) await client.query('CREATE ROLE codeops_app LOGIN');
    await client.query(`ALTER ROLE codeops_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await requireUnownedDatabaseRole(client, 'codeops_app');
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query('REVOKE ALL ON SCHEMA codeops FROM PUBLIC');
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM PUBLIC');
    await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM PUBLIC');
    await client.query('REVOKE ALL ON SCHEMA codeops FROM codeops_app');
    await client.query('GRANT USAGE ON SCHEMA codeops TO codeops_app');
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM codeops_app');
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA codeops TO codeops_app');
    await client.query('REVOKE INSERT, UPDATE, DELETE ON codeops.schema_migrations FROM codeops_app');
    await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA codeops TO codeops_app');
    await client.query('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA codeops FROM PUBLIC');
    const inspector = await client.query("SELECT 1 FROM pg_roles WHERE rolname='codeops_inspector'");
    if (!inspector.rows.length) await client.query('CREATE ROLE codeops_inspector NOLOGIN');
    await requireUnownedDatabaseRole(client, 'codeops_inspector');
    await client.query('ALTER ROLE codeops_inspector NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await client.query('REVOKE ALL ON SCHEMA codeops FROM codeops_inspector');
    await client.query('GRANT USAGE ON SCHEMA codeops TO codeops_inspector');
    await client.query('REVOKE ALL ON ALL TABLES IN SCHEMA codeops FROM codeops_inspector');
    await client.query('GRANT SELECT ON ALL TABLES IN SCHEMA codeops TO codeops_inspector');
    await client.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA codeops FROM codeops_inspector');
    await client.query('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA codeops FROM codeops_inspector');
    await client.query('ALTER ROLE codeops_inspector SET default_transaction_read_only = on');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function requireUnownedDatabaseRole(client: TransactionClient, role: string): Promise<void> {
  const unsafe = await client.query(`SELECT r.oid FROM pg_roles r WHERE r.rolname=$1 AND (
    EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) OR
    EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) OR
    EXISTS (SELECT 1 FROM pg_class WHERE relowner=r.oid) OR
    EXISTS (SELECT 1 FROM pg_proc WHERE proowner=r.oid) OR
    EXISTS (SELECT 1 FROM pg_database WHERE datdba=r.oid))`, [role]);
  if (unsafe.rows.length) throw new Error('Runtime database role must have no ownership or memberships');
}
