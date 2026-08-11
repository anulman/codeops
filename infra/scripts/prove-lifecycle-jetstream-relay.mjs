import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const serviceRequire = createRequire(new URL("../../services/codeops-control-gateway/package.json", import.meta.url));
const importFromService = (name) => import(pathToFileURL(serviceRequire.resolve(name)).href);
const { jetstream, jetstreamManager } = await importFromService("@nats-io/jetstream");
const { connect } = await importFromService("@nats-io/transport-node");
const pg = await importFromService("pg");
const Pool = pg.Pool ?? pg.default?.Pool;
const {
  contractVersions,
  createEventId,
  createTransitionId,
} = await import("../../packages/codeops-contracts/dist/index.js");

import { createJetStreamLifecyclePublisher } from "../../services/codeops-control-gateway/dist/jetstream-lifecycle-publisher.js";
import {
  acknowledgeWorkItemLifecyclePublication,
  appendWorkItemLifecycleEvent,
  claimWorkItemLifecyclePublication,
} from "../../services/codeops-control-gateway/dist/work-item-lifecycle-journal.js";
import {
  grantLifecycleRelayAccess,
  migrateSessionBroker,
} from "../../services/codeops-control-gateway/dist/session-broker-migration.js";

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const postgresContainer = `codeops-relay-postgres-${suffix}`;
const natsContainer = `codeops-relay-nats-${suffix}`;
const databasePassword = `qualification_${suffix}_password_0123456789`;
const relayPassword = `relay_${suffix}_password_0123456789abcdef`;
const natsToken = `qualification_${suffix}_token_0123456789`;

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function publishedPort(container, port) {
  const value = docker("port", container, port);
  const match = value.match(/:(\d+)$/);
  if (!match) throw new Error(`Docker did not publish ${port}`);
  return Number(match[1]);
}

async function retry(operation, message) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(message, { cause: lastError });
}

function lifecycleEvent(occurredAt) {
  const workflowId = `workflow-${suffix}`;
  const transitionId = createTransitionId({
    version: contractVersions.workItemLifecycleEvent,
    workflowId,
    transitionKey: "lifecycle-ready",
  });
  return {
    version: contractVersions.workItemLifecycleEvent,
    eventId: createEventId({
      version: contractVersions.workItemLifecycleEvent,
      workflowId,
      transitionId,
    }),
    transitionId,
    transitionKey: "lifecycle-ready",
    command: "register",
    repository: { owner: "anulman", name: "codeops" },
    provider: { kind: "plane", workspaceId: "workspace_123", projectId: "project_456" },
    workItemId: `work-item-${suffix}`,
    workflowId,
    runId: `run-${suffix}`,
    sequence: 1,
    previousState: null,
    state: { phase: "ready", attention: "clear" },
    sourceSha: "6092e78000000000000000000000000000000000",
    occurredAt,
    summary: "The lifecycle event is ready for the JetStream relay proof.",
    evidence: [],
  };
}

let database;
let relayDatabase;
let nats;
try {
  docker(
    "run", "--detach", "--name", postgresContainer,
    "--env", `POSTGRES_PASSWORD=${databasePassword}`,
    "--publish", "127.0.0.1::5432",
    "postgres:18-alpine",
  );
  docker(
    "run", "--detach", "--name", natsContainer,
    "--publish", "127.0.0.1::4222",
    "nats:2.12.3-alpine", "--jetstream", "--auth", natsToken,
  );
  const databasePort = publishedPort(postgresContainer, "5432/tcp");
  const natsPort = publishedPort(natsContainer, "4222/tcp");
  database = new Pool({
    connectionString: `postgresql://postgres:${databasePassword}@127.0.0.1:${databasePort}/postgres`,
    max: 2,
  });
  await retry(async () => {
    const client = await database.connect();
    client.release();
  }, "PostgreSQL did not become ready");
  nats = await retry(
    () => connect({ servers: `nats://127.0.0.1:${natsPort}`, token: natsToken }),
    "NATS did not become ready",
  );

  const migrationClient = await database.connect();
  try {
    await migrateSessionBroker(migrationClient);
    await grantLifecycleRelayAccess(
      migrationClient,
      "codeops_lifecycle_relay",
      relayPassword,
    );
  } finally {
    migrationClient.release();
  }
  relayDatabase = new Pool({
    connectionString: `postgresql://codeops_lifecycle_relay:${relayPassword}@127.0.0.1:${databasePort}/postgres`,
    max: 1,
  });
  const manager = await jetstreamManager(nats);
  await manager.streams.add({
    name: "CODEOPS_LIFECYCLE",
    subjects: ["codeops.lifecycle.v1.events"],
    duplicate_window: 120_000_000_000,
  });
  const publish = createJetStreamLifecyclePublisher(jetstream(nats), {
    stream: "CODEOPS_LIFECYCLE",
    subject: "codeops.lifecycle.v1.events",
  });
  const occurredAt = new Date(Date.now() - 10_000).toISOString();
  const event = lifecycleEvent(occurredAt);
  const appendClient = await database.connect();
  try {
    assert.equal(await appendWorkItemLifecycleEvent(appendClient, event), "appended");
  } finally {
    appendClient.release();
  }
  const firstClaimClient = await relayDatabase.connect();
  const firstClaim = await claimWorkItemLifecyclePublication(firstClaimClient, {
    claimedBy: "relay-proof-1",
    now: occurredAt,
    leaseMs: 1_000,
  });
  firstClaimClient.release();
  assert.ok(firstClaim);
  const firstPublish = await publish({
    route: "codeops.lifecycle.v1.events",
    payload: new TextEncoder().encode(JSON.stringify(event)),
    messageId: event.eventId,
  });
  assert.equal(firstPublish.receipt.metadata.duplicate, false);

  const recoveryClient = await relayDatabase.connect();
  const recoveredClaim = await claimWorkItemLifecyclePublication(recoveryClient, {
    claimedBy: "relay-proof-2",
    now: new Date(new Date(occurredAt).valueOf() + 1_001).toISOString(),
    leaseMs: 1_000,
  });
  recoveryClient.release();
  assert.ok(recoveredClaim);
  const recoveredPublish = await publish({
    route: "codeops.lifecycle.v1.events",
    payload: new TextEncoder().encode(JSON.stringify(event)),
    messageId: event.eventId,
  });
  assert.equal(recoveredPublish.receipt.metadata.duplicate, true);
  assert.equal(recoveredPublish.receipt.position, firstPublish.receipt.position);
  const acknowledgeClient = await relayDatabase.connect();
  try {
    assert.equal(await acknowledgeWorkItemLifecyclePublication(acknowledgeClient, {
      eventId: event.eventId,
      claimToken: recoveredClaim.claimToken,
      receipt: recoveredPublish.receipt,
      publishedAt: new Date().toISOString(),
    }), "published");
  } finally {
    acknowledgeClient.release();
  }
  const evidence = await database.query(
    `SELECT status, delivery_driver, delivery_destination, delivery_position,
            delivery_receipt_json
       FROM codeops.work_item_lifecycle_publications
      WHERE event_id = $1`,
    [event.eventId],
  );
  assert.equal(evidence.rows[0].status, "published");
  assert.equal(evidence.rows[0].delivery_driver, "jetstream");
  assert.equal(evidence.rows[0].delivery_destination, "CODEOPS_LIFECYCLE");
  assert.equal(evidence.rows[0].delivery_position, firstPublish.receipt.position);
  assert.equal(evidence.rows[0].delivery_receipt_json.metadata.duplicate, true);
  process.stdout.write(`${JSON.stringify({ status: "passed", stream: "CODEOPS_LIFECYCLE", sequence: evidence.rows[0].delivery_position, duplicateRecovery: true })}\n`);
} finally {
  if (database) await database.end().catch(() => undefined);
  if (relayDatabase) await relayDatabase.end().catch(() => undefined);
  if (nats) await nats.drain().catch(() => undefined);
  for (const container of [natsContainer, postgresContainer]) {
    try { docker("rm", "--force", container); } catch {}
  }
}
