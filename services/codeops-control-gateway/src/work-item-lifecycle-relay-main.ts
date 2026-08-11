import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { Pool } from "pg";

import { createJetStreamLifecyclePublisher } from "./jetstream-lifecycle-publisher.js";
import {
  acknowledgeWorkItemLifecyclePublication,
  claimWorkItemLifecyclePublication,
} from "./work-item-lifecycle-journal.js";
import { relayOneWorkItemLifecycleEvent } from "./work-item-lifecycle-relay.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function secretFile(name: string): Promise<string> {
  const value = (await readFile(required(name), "utf8")).trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

function milliseconds(name: string, minimum: number, maximum: number): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function boolean(name: string): boolean {
  const value = required(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} is invalid`);
}

const relayId = required("CODEOPS_LIFECYCLE_RELAY_ID");
const stream = required("CODEOPS_JETSTREAM_STREAM");
const subject = required("CODEOPS_JETSTREAM_SUBJECT");
const leaseMs = milliseconds("CODEOPS_LIFECYCLE_RELAY_LEASE_MS", 1_000, 900_000);
const idleMs = milliseconds("CODEOPS_LIFECYCLE_RELAY_IDLE_MS", 10, 60_000);
const manageStream = boolean("CODEOPS_JETSTREAM_MANAGE_STREAM");
const nats = await connect({
  servers: required("CODEOPS_NATS_URL"),
  name: relayId,
  token: await secretFile("CODEOPS_NATS_TOKEN_FILE"),
});
const manager = await jetstreamManager(nats);
let resolvedStream: string;
try {
  resolvedStream = await manager.streams.find(subject);
} catch (error) {
  if (!manageStream) throw error;
  await manager.streams.add({
    name: stream,
    subjects: [subject],
    duplicate_window: 120_000_000_000,
  });
  resolvedStream = await manager.streams.find(subject);
}
if (resolvedStream !== stream) {
  throw new Error("JetStream lifecycle subject resolves to the wrong stream");
}

const database = new Pool({
  connectionString: await secretFile("CODEOPS_LIFECYCLE_RELAY_DATABASE_URL_FILE"),
  max: 2,
});
const publish = createJetStreamLifecyclePublisher(jetstream(nats), {
  stream,
  subject,
});
const handshake = await database.connect();
try {
  await handshake.query("SELECT 1");
} finally {
  handshake.release();
}
await writeFile("/tmp/codeops-lifecycle-relay-ready", "ready\n", { mode: 0o600 });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { stopping = true; });
}

try {
  while (!stopping) {
    const result = await relayOneWorkItemLifecycleEvent({
      claim: async (input) => {
        const client = await database.connect();
        try {
          return await claimWorkItemLifecyclePublication(client, input);
        } finally {
          client.release();
        }
      },
      publish,
      acknowledge: async (input) => {
        const client = await database.connect();
        try {
          return await acknowledgeWorkItemLifecyclePublication(client, input);
        } finally {
          client.release();
        }
      },
    }, {
      relayId,
      leaseMs,
    });
    if (result.status === "idle") await delay(idleMs);
  }
} finally {
  await database.end();
  await nats.drain();
}
