import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { sessionJobInitializationRequestSchema } from "@codeops/codeops-contracts";
import {
  createAcpPermissionRelay,
  SocketAcpWorkspaceLifecycle,
  waitForAcpSocket,
} from "./acp-workspace.js";
import { createSessionRuntimeLifecycleExecutor } from "./lifecycle.js";
import {
  admittedChildInitialDispatchExecutor,
  SessionJobInitializer,
} from "./initialization.js";
import { PostgresRuntimeExecutionReceiptStore } from "./postgres-receipts.js";
import { PostgresWorkspaceCheckpointArtifactStore } from "./workspace-artifacts.js";
import { runSessionRuntimeWorker } from "./runner.js";
import { SessionRuntimeTransport } from "./transport.js";
import type { RuntimeExecutor } from "./transport.js";
import { loadRuntimeSessionIdentity } from "./session-identity.js";
import { WorkItemsBroker } from "./work-items-broker.js";
import { GitHubReadsBroker } from "./github-reads-broker.js";
import { GitHubMutationsBroker } from "./github-mutations-broker.js";
import { publishModelProxyToken } from "./model-proxy-token.js";

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
const workItemsBrokerPort = boundedInteger(
  "CODEOPS_WORK_ITEMS_BROKER_PORT",
  8091,
  1,
  65_535,
);
const githubReadsBrokerPort = boundedInteger(
  "CODEOPS_GITHUB_READS_BROKER_PORT",
  8092,
  1,
  65_535,
);
const githubMutationsBrokerPort = boundedInteger(
  "CODEOPS_GITHUB_MUTATIONS_BROKER_PORT",
  8093,
  1,
  65_535,
);

const database = new Pool({ connectionString: databaseUrl, max: 1 });
const receipts = new PostgresRuntimeExecutionReceiptStore(database);
const workspaceArtifacts = new PostgresWorkspaceCheckpointArtifactStore(database);
const initializer = new SessionJobInitializer({
  gatewayOrigin,
  token: initializationToken,
  requestTimeoutMs,
});
const cancellation = new AbortController();
const workItemsBroker = new WorkItemsBroker();
const githubReadsBroker = new GitHubReadsBroker();
const githubMutationsBroker = new GitHubMutationsBroker();
const shutdown = () => cancellation.abort();
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

try {
  const identity = await loadRuntimeSessionIdentity({ env: process.env });
  const admittedChildJson = process.env.CODEOPS_ADMITTED_CHILD_INITIALIZATION_JSON?.trim();
  const admittedChild = admittedChildJson === undefined ? undefined : JSON.parse(admittedChildJson);
  const initialization = await initializer.initialize(sessionJobInitializationRequestSchema.parse({
    version: admittedChild === undefined ? "codeops.session-job-initialization/v1" :
      "codeops.session-job-initialization/v3",
    ...(admittedChild ?? {}),
    sessionId: required("CODEOPS_SESSION_ID"),
    identity,
    leaseId: required("CODEOPS_SESSION_LEASE_ID"),
    holderId: required("CODEOPS_SESSION_HOLDER_ID"),
    ownerPrincipalId: required("CODEOPS_SESSION_OWNER_PRINCIPAL_ID"),
  }));
  if (initialization.snapshot.lease?.status !== "active") {
    throw new Error("session runtime requires an active server-confirmed lease");
  }
  if (initialization.modelProxyToken === undefined) {
    throw new Error("session runtime requires a short-lived model proxy token");
  }
  await publishModelProxyToken(
    modelProxyTokenPath,
    initialization.modelProxyToken,
  );
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
  await workItemsBroker.listen(workItemsBrokerPort);
  await githubReadsBroker.listen(githubReadsBrokerPort);
  await githubMutationsBroker.listen(githubMutationsBrokerPort);
  await waitForAcpSocket(socketPath, socketTimeoutMs);
  await writeFile(readyPath, "", { mode: 0o600, flag: "wx" });
  const execute: RuntimeExecutor = async (dispatch, context) => {
    const lifecycle = new SocketAcpWorkspaceLifecycle({
      socketPath,
      workspace,
      statePath,
      socketTimeoutMs,
      permissions: createAcpPermissionRelay({ context }),
      artifacts: workspaceArtifacts,
    });
    return workItemsBroker.run(dispatch, context, () =>
      githubReadsBroker.run(dispatch, context, () =>
        githubMutationsBroker.run(dispatch, context, () =>
          createSessionRuntimeLifecycleExecutor({ lifecycle, receipts })(dispatch, context),
        ),
      ),
    );
  };
  const admittedExecute = admittedChild === undefined ? execute :
    admittedChildInitialDispatchExecutor({
      initialDispatchDigest: initialization.initialDispatchDigest!,
      contextAttachments: initialization.contextAttachments!,
      execute,
    });
  await runSessionRuntimeWorker({
    transport,
    leaseMs: claimLeaseMs,
    idlePollMs,
    signal: cancellation.signal,
    execute: admittedExecute,
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
  await workItemsBroker.close().catch(() => {});
  await githubReadsBroker.close().catch(() => {});
  await githubMutationsBroker.close().catch(() => {});
  await rm(readyPath, { force: true }).catch(() => {});
  await rm(modelProxyTokenPath, { force: true }).catch(() => {});
  await writeFile(path.join(path.dirname(socketPath), "done"), "", {
    mode: 0o600,
  }).catch(() => {});
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
  await database.end();
}
