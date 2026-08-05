import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  createAcpPermissionRelay,
  SocketAcpWorkspaceLifecycle,
} from "./acp-workspace.js";
import { createSessionRuntimeLifecycleExecutor } from "./lifecycle.js";
import { PostgresRuntimeExecutionReceiptStore } from "./postgres-receipts.js";
import { runSessionRuntimeWorker } from "./runner.js";
import { SessionRuntimeTransport } from "./transport.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function secretFile(name: string, maximumBytes: number): Promise<string> {
  const contents = await readFile(required(name));
  if (contents.byteLength < 1 || contents.byteLength > maximumBytes) {
    throw new Error(`${name} must contain 1 to ${maximumBytes} bytes`);
  }
  const value = contents.toString("utf8").trim();
  if (!value) throw new Error(`${name} is empty`);
  return value;
}

const gatewayOrigin = required("CODEOPS_SESSION_RUNTIME_GATEWAY_ORIGIN");
const workerToken = await secretFile(
  "CODEOPS_SESSION_RUNTIME_WORKER_TOKEN_FILE",
  4_096,
);
const databaseUrl = await secretFile("CODEOPS_DATABASE_URL_FILE", 4_096);
const socketPath = required("CODEOPS_SESSION_RUNTIME_ACP_SOCKET_PATH");
const workspace = required("CODEOPS_SESSION_RUNTIME_WORKSPACE");
const statePath = required("CODEOPS_SESSION_RUNTIME_ACP_STATE_PATH");
const claimLeaseMs = boundedInteger(
  "CODEOPS_SESSION_RUNTIME_CLAIM_LEASE_MS",
  15 * 60_000,
  1_000,
  15 * 60_000,
);
const idlePollMs = boundedInteger(
  "CODEOPS_SESSION_RUNTIME_IDLE_POLL_MS",
  1_000,
  100,
  30_000,
);
const requestTimeoutMs = boundedInteger(
  "CODEOPS_SESSION_RUNTIME_REQUEST_TIMEOUT_MS",
  10_000,
  1_000,
  30_000,
);
const socketTimeoutMs = boundedInteger(
  "CODEOPS_SESSION_RUNTIME_ACP_SOCKET_TIMEOUT_MS",
  30_000,
  1_000,
  60_000,
);

const database = new Pool({ connectionString: databaseUrl, max: 1 });
const receipts = new PostgresRuntimeExecutionReceiptStore(database);
const transport = new SessionRuntimeTransport({
  gatewayOrigin,
  token: workerToken,
  requestTimeoutMs,
});
const cancellation = new AbortController();
const shutdown = () => cancellation.abort();
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  await runSessionRuntimeWorker({
    transport,
    leaseMs: claimLeaseMs,
    idlePollMs,
    signal: cancellation.signal,
    execute: async (dispatch, context) => {
      const lifecycle = new SocketAcpWorkspaceLifecycle({
        socketPath,
        workspace,
        statePath,
        socketTimeoutMs,
        permissions: createAcpPermissionRelay({ context }),
      });
      return createSessionRuntimeLifecycleExecutor({
        lifecycle,
        receipts,
      })(dispatch, context);
    },
    onCompleted: (result) => {
      process.stdout.write(`${JSON.stringify({
        event: "session_runtime_completed",
        sessionId: result.sessionId,
        generation: result.generation,
        type: result.type,
        eventCursor: result.eventCursor,
      })}\n`);
    },
  });
} finally {
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
  await database.end();
}
