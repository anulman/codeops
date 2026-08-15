import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  grantLifecycleRelayAccess,
  grantModelProxyLedgerAccess,
  grantSessionRuntimeReceiptAccess,
  lifecycleRelayDatabaseCredentials,
  modelProxyDatabaseCredentials,
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
  databaseUrl,
);
const relayRoleFile = process.env.CODEOPS_LIFECYCLE_RELAY_DATABASE_ROLE_FILE?.trim();
const relayDatabaseUrlFile = process.env.CODEOPS_LIFECYCLE_RELAY_DATABASE_URL_FILE?.trim();
if (Boolean(relayRoleFile) !== Boolean(relayDatabaseUrlFile)) {
  throw new Error("lifecycle relay database role and URL files must be configured together");
}
const relayCredentials = relayRoleFile && relayDatabaseUrlFile
  ? lifecycleRelayDatabaseCredentials(
      (await readFile(relayDatabaseUrlFile, "utf8")).trim(),
      (await readFile(relayRoleFile, "utf8")).trim(),
      databaseUrl,
    )
  : null;
const modelProxyRoleFile = process.env.CODEOPS_MODEL_PROXY_DATABASE_ROLE_FILE?.trim();
const modelProxyDatabaseUrlFile = process.env.CODEOPS_MODEL_PROXY_DATABASE_URL_FILE?.trim();
if (Boolean(modelProxyRoleFile) !== Boolean(modelProxyDatabaseUrlFile)) {
  throw new Error("model proxy database role and URL files must be configured together");
}
const modelProxyCredentials = modelProxyRoleFile && modelProxyDatabaseUrlFile
  ? modelProxyDatabaseCredentials(
      (await readFile(modelProxyDatabaseUrlFile, "utf8")).trim(),
      (await readFile(modelProxyRoleFile, "utf8")).trim(),
      databaseUrl,
    )
  : null;

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
    if (relayCredentials) {
      await grantLifecycleRelayAccess(
        client,
        relayCredentials.role,
        relayCredentials.password,
      );
    }
    if (modelProxyCredentials) {
      await grantModelProxyLedgerAccess(
        client,
        modelProxyCredentials.role,
        modelProxyCredentials.password,
      );
    }
    process.stdout.write(`${JSON.stringify({
      event: "session_schema_migrated",
      results,
      runtimeGrants: "current",
      lifecycleRelayGrants: relayCredentials ? "current" : "disabled",
      modelProxyGrants: modelProxyCredentials ? "current" : "disabled",
    })}\n`);
  } finally {
    client.release();
  }
} finally {
  await database.end();
}
