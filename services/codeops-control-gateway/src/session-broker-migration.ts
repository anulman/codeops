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
    name: "session-job-initialization-v1",
    url: new URL("../sql/session-job-initialization.sql", import.meta.url),
  },
  {
    name: "session-runtime-permission-relay-v1",
    url: new URL("../sql/session-runtime-permission-relay.sql", import.meta.url),
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
