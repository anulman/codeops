import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  grantLifecycleRelayAccess,
  grantApplicationDatabaseAccess,
  grantModelProxyLedgerAccess,
  grantSessionRuntimeReceiptAccess,
  lifecycleRelayDatabaseCredentials,
  modelProxyDatabaseCredentials,
  migrateSessionBroker,
  sessionRuntimeDatabaseCredentials,
} from "./session-broker-migration.js";
import { quiesceInClusterMigrationWriters } from "./migration-writer-quiescence.js";

const quiesceWriters = process.env.CODEOPS_MIGRATION_QUIESCE_WRITERS?.trim();
if (quiesceWriters !== undefined && quiesceWriters !== "true") {
  throw new Error("CODEOPS_MIGRATION_QUIESCE_WRITERS must be true when configured");
}

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

const appFile = process.env.CODEOPS_APPLICATION_DATABASE_URL_FILE?.trim();
if (!appFile) throw new Error("CODEOPS_APPLICATION_DATABASE_URL_FILE is required");
const appUrl = new URL((await readFile(appFile, "utf8")).trim());
const ownerUrl = new URL(databaseUrl);
if (!["postgres:", "postgresql:"].includes(appUrl.protocol) ||
    appUrl.protocol !== ownerUrl.protocol || appUrl.username !== "codeops_app" || appUrl.host !== ownerUrl.host ||
    appUrl.pathname !== ownerUrl.pathname || appUrl.search !== ownerUrl.search ||
    appUrl.username === ownerUrl.username) {
  throw new Error("Application and deployment database identities must be separate on the same target");
}

const appPassword = decodeURIComponent(appUrl.password);
if (!/^[A-Za-z0-9._~-]{32,256}$/.test(appPassword)) {
  throw new Error("Application database credentials are invalid");
}
// Validate all mounted identities before deployment quiescence changes a writer.
if (quiesceWriters === "true") {
  const namespace = process.env.CODEOPS_NAMESPACE?.trim();
  const rawNames = process.env.CODEOPS_MIGRATION_WRITER_DEPLOYMENTS?.trim();
  if (!namespace || !rawNames) {
    throw new Error("migration writer quiescence identity is required");
  }
  let deploymentNames: unknown;
  try { deploymentNames = JSON.parse(rawNames); } catch {
    throw new Error("CODEOPS_MIGRATION_WRITER_DEPLOYMENTS must be JSON");
  }
  if (!Array.isArray(deploymentNames) ||
      deploymentNames.some((name) => typeof name !== "string")) {
    throw new Error("CODEOPS_MIGRATION_WRITER_DEPLOYMENTS must be a string array");
  }
  await quiesceInClusterMigrationWriters({ namespace, deploymentNames });
}


const database = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const client = await database.connect();
  try {
    const results = await migrateSessionBroker(client, {
      legacySessionOwnerPrincipalId:
        process.env.CODEOPS_LEGACY_SESSION_OWNER_PRINCIPAL_ID?.trim() || undefined,
    });
    await grantApplicationDatabaseAccess(client, appUrl.username, appPassword);
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
