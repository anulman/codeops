import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  grantSessionRuntimeReceiptAccess,
  migrateSessionBroker,
  sessionRuntimeDatabaseCredentials,
} from "./session-broker-migration.js";

const databaseUrlFile = process.env.CODEOPS_DATABASE_URL_FILE?.trim();
if (!databaseUrlFile) throw new Error("CODEOPS_DATABASE_URL_FILE is required");
const databaseUrl = (await readFile(databaseUrlFile, "utf8")).trim();
if (!databaseUrl) throw new Error("CODEOPS_DATABASE_URL_FILE is empty");
const runtimeRoleFile = process.env.CODEOPS_RUNTIME_DATABASE_ROLE_FILE?.trim();
if (!runtimeRoleFile) throw new Error("CODEOPS_RUNTIME_DATABASE_ROLE_FILE is required");
const runtimeRole = (await readFile(runtimeRoleFile, "utf8")).trim();
const runtimeDatabaseUrlFile = process.env.CODEOPS_RUNTIME_DATABASE_URL_FILE?.trim();
if (!runtimeDatabaseUrlFile) throw new Error("CODEOPS_RUNTIME_DATABASE_URL_FILE is required");
const runtimeDatabaseUrl = (await readFile(runtimeDatabaseUrlFile, "utf8")).trim();
const runtimeCredentials = sessionRuntimeDatabaseCredentials(
  runtimeDatabaseUrl,
  runtimeRole,
);

const database = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await database.connect();
  try {
    const results = await migrateSessionBroker(client);
    await grantSessionRuntimeReceiptAccess(
      client,
      runtimeCredentials.role,
      runtimeCredentials.password,
    );
    process.stdout.write(`${JSON.stringify({ event: "session_schema_migrated", results, runtimeGrants: "current" })}\n`);
  } finally {
    client.release();
  }
} finally {
  await database.end();
}
