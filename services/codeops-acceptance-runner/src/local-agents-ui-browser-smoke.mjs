#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentsUiSmoke } from "./agents-ui-smoke.mjs";
import { browserAcceptanceReport } from "./browser-acceptance-report.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const token = "r".repeat(64);
const writeToken = "w".repeat(64);
const brokerRequests = [];

function fleet() {
  return {
    version: "codeops.session-fleet/v1",
    sessions: [
      {
        version: "codeops.session-snapshot/v1",
        sessionId: "session-browser-smoke",
        generation: 1,
        state: "running",
        identity: {
          repository: "example-org/example-repository",
          branch: "feat/browser-smoke",
          baseSha: "a".repeat(40),
          workflowId: "workflow-browser-smoke",
          runId: "run-browser-smoke",
          parentSessionId: null,
          forkedAtCursor: null,
        },
        lease: {
          leaseId: "11111111-1111-4111-8111-111111111111",
          generation: 1,
          status: "active",
          holderId: "worker-browser-smoke",
          acquiredAt: "2026-08-11T12:00:00.000Z",
          expiresAt: "2026-08-11T13:00:00.000Z",
        },
        checkpoint: null,
        pendingPermission: null,
        eventCursor: 1,
        capabilities: [
          { action: "prompt", availability: "enabled" },
          { action: "respond_permission", availability: "disabled", reason: "No request." },
          { action: "cancel", availability: "enabled" },
          { action: "checkpoint", availability: "enabled" },
          { action: "hibernate", availability: "enabled" },
          { action: "resume", availability: "disabled", reason: "Already running." },
          { action: "fork", availability: "disabled", reason: "No checkpoint." },
          { action: "archive", availability: "disabled", reason: "Still running." },
        ],
        updatedAt: "2026-08-11T12:01:00.000Z",
      },
    ],
  };
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address is invalid");
  return address.port;
}

async function waitForUi(origin, child) {
  const deadline = Date.now() + 30_000;
  let lastResponse = "no response";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Agents UI exited with ${child.exitCode}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
      lastResponse = `${response.status} ${(await response.text()).slice(0, 8_000)}`;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Agents UI did not become ready: ${lastResponse}`);
}

const broker = createServer((request, response) => {
  brokerRequests.push({ url: request.url, authorization: request.headers.authorization });
  if (request.url === "/v1/sessions?limit=100" && request.headers.authorization === `Bearer ${token}`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(fleet()));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "not-found" }));
});
const uiProbe = createServer();
const directory = await mkdtemp(path.join(tmpdir(), "codeops-ui-smoke-"));
let ui;
try {
  const brokerPort = await listen(broker);
  const uiPort = await listen(uiProbe);
  await new Promise((resolve, reject) => uiProbe.close((error) => error ? reject(error) : resolve()));
  const readTokenPath = path.join(directory, "read-token");
  const writeTokenPath = path.join(directory, "write-token");
  await Promise.all([
    writeFile(readTokenPath, `${token}\n`, { mode: 0o600 }),
    writeFile(writeTokenPath, `${writeToken}\n`, { mode: 0o600 }),
  ]);
  ui = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: path.join(repositoryRoot, "sites/agents-ui"),
    env: {
      ...process.env,
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: String(uiPort),
      CODEOPS_SESSION_BROKER_URL: `http://127.0.0.1:${brokerPort}`,
      CODEOPS_SESSION_BROKER_READ_TOKEN_FILE: readTokenPath,
      CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE: writeTokenPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  ui.stdout.on("data", (chunk) => { logs += chunk; });
  ui.stderr.on("data", (chunk) => { logs += chunk; });
  const origin = `http://127.0.0.1:${uiPort}`;
  try {
    await waitForUi(origin, ui);
    await runAgentsUiSmoke({ baseUrl: origin });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nBroker requests: ${JSON.stringify(brokerRequests)}\n${logs.slice(-8_000)}`);
  }
  process.stdout.write(`${JSON.stringify(browserAcceptanceReport())}\n`);
} finally {
  if (ui?.exitCode === null) {
    ui.kill("SIGTERM");
    await Promise.race([once(ui, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (ui.exitCode === null) ui.kill("SIGKILL");
  }
  await new Promise((resolve) => broker.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
