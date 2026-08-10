import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { sessionJobInitializationRequestSchema } from "@renoconcierge/codeops-contracts";
import {
  createAcpPermissionRelay,
  SocketAcpWorkspaceLifecycle,
  waitForAcpSocket,
} from "./acp-workspace.js";
import { createSessionRuntimeLifecycleExecutor } from "./lifecycle.js";
import { SessionJobInitializer } from "./initialization.js";
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
const initializationToken = await secretFile(
  "CODEOPS_SESSION_JOB_INITIALIZATION_TOKEN_FILE",
  4_096,
);
if (initializationToken === workerToken) {
  throw new Error("session Job initialization and worker tokens must be distinct");
}
const databaseUrl = await secretFile("CODEOPS_DATABASE_URL_FILE", 4_096);
const socketPath = required("CODEOPS_SESSION_RUNTIME_ACP_SOCKET_PATH");
const readyPath = path.join(path.dirname(socketPath), "ready");
const modelProxyTokenPath = path.join(
  path.dirname(socketPath),
  "model-proxy-token",
);
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
const initializer = new SessionJobInitializer({
  gatewayOrigin,
  token: initializationToken,
  requestTimeoutMs,
});
const cancellation = new AbortController();
const shutdown = () => cancellation.abort();
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  const initialization = await initializer.initialize(sessionJobInitializationRequestSchema.parse({
    version: "codeops.session-job-initialization/v1",
    sessionId: required("CODEOPS_SESSION_ID"),
    identity: {
      repository: required("CODEOPS_SESSION_REPOSITORY"),
      branch: required("CODEOPS_SESSION_BRANCH"),
      baseSha: required("CODEOPS_SESSION_BASE_SHA"),
      workflowId: required("CODEOPS_SESSION_WORKFLOW_ID"),
      runId: required("CODEOPS_SESSION_RUN_ID"),
      parentSessionId: null,
      forkedAtCursor: null,
    },
    leaseId: required("CODEOPS_SESSION_LEASE_ID"),
    holderId: required("CODEOPS_SESSION_HOLDER_ID"),
  }));
  if (initialization.snapshot.lease?.status !== "active") {
    throw new Error("session runtime requires an active server-confirmed lease");
  }
  if (initialization.modelProxyToken === undefined) {
    throw new Error("session runtime requires a short-lived model proxy token");
  }
  await writeFile(modelProxyTokenPath, initialization.modelProxyToken, {
    mode: 0o600,
    flag: "wx",
  });
  const transport = new SessionRuntimeTransport({
    gatewayOrigin,
    token: workerToken,
    requestTimeoutMs,
    authority: {
      sessionId: initialization.snapshot.sessionId,
      generation: initialization.snapshot.generation,
      leaseId: initialization.snapshot.lease.leaseId,
      identity: initialization.snapshot.identity,
    },
  });
  await waitForAcpSocket(socketPath, socketTimeoutMs);
  await writeFile(readyPath, "", { mode: 0o600, flag: "wx" });
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
  await rm(readyPath, { force: true }).catch(() => {});
  await rm(modelProxyTokenPath, { force: true }).catch(() => {});
  await writeFile(path.join(path.dirname(socketPath), "done"), "", {
    mode: 0o600,
  }).catch(() => {});
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
  await database.end();
}
