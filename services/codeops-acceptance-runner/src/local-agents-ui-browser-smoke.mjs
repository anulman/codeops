#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const ownerPrincipal = "codeops:agents-ui";
const brokerRequests = [];
const webPushPublicKey = "B".repeat(87);
const legacyWorkspaceFixture = JSON.parse(
  await readFile(
    path.join(
      repositoryRoot,
      "packages/codeops-contracts/test/fixtures/codeops-0.4.2-workspace-session.json",
    ),
    "utf8",
  ),
);
const legacySessionId = legacyWorkspaceFixture.snapshot.sessionId;

function fleet() {
  return {
    version: "codeops.session-fleet/v1",
    sessions: [legacyWorkspaceFixture.snapshot],
  };
}

function workspaceCatalog() {
  return {
    version: "codeops.workspace-catalog/v1",
    repositories: [
      {
        key: "renoconcierge",
        label: "RenoConcierge",
        repository: "anulman/renoconcierge",
        defaultRef: "main",
      },
      {
        key: "codeops",
        label: "CodeOps",
        repository: "anulman/codeops",
        defaultRef: "main",
      },
    ],
  };
}

function providerEffectFleet() {
  return {
    version: "codeops.provider-effect-fleet/v1",
    effects: [],
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

const broker = createServer(async (request, response) => {
  brokerRequests.push({
    url: request.url,
    authorization: request.headers.authorization,
    principal: request.headers["x-codeops-principal"],
  });
  if (
    request.url === "/v1/session-notifications/config" &&
    request.method === "GET" &&
    request.headers.authorization === `Bearer ${token}`
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      version: "codeops.web-push-configuration/v1",
      enabled: true,
      publicKey: webPushPublicKey,
    }));
    return;
  }
  if (
    request.url === "/v1/session-notifications/subscriptions" &&
    request.method === "POST" &&
    request.headers.authorization === `Bearer ${writeToken}` &&
    request.headers["x-codeops-principal"] === ownerPrincipal
  ) {
    let body = "";
    for await (const chunk of request) body += chunk;
    const subscription = JSON.parse(body);
    brokerRequests.at(-1).subscriptionDeviceId = subscription.deviceId;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      version: "codeops.web-push-subscription-result/v1",
      subscriptionId: `sha256:${"c".repeat(64)}`,
      deviceId: subscription.deviceId,
      status: "active",
    }));
    return;
  }
  if (
    request.url === "/v1/sessions?limit=100" &&
    request.headers.authorization === `Bearer ${token}` &&
    request.headers["x-codeops-principal"] === ownerPrincipal
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(fleet()));
    return;
  }
  if (
    request.url === "/v1/provider-effects?limit=100" &&
    request.headers.authorization === `Bearer ${token}` &&
    request.headers["x-codeops-principal"] === ownerPrincipal
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(providerEffectFleet()));
    return;
  }
  if (
    request.url === `/v1/sessions/${legacySessionId}` &&
    request.headers.authorization === `Bearer ${token}` &&
    request.headers["x-codeops-principal"] === ownerPrincipal
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      version: "codeops.session-detail/v1",
      session: legacyWorkspaceFixture.snapshot,
    }));
    return;
  }
  if (
    request.url === `/v1/sessions/${legacySessionId}/events?afterCursor=0&limit=500` &&
    request.headers.authorization === `Bearer ${token}` &&
    request.headers["x-codeops-principal"] === ownerPrincipal
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      version: "codeops.session-events/v1",
      sessionId: legacySessionId,
      afterCursor: 0,
      nextCursor: 0,
      events: [],
    }));
    return;
  }
  if (
    request.url === "/v1/workspace-catalog" &&
    request.headers.authorization === `Bearer ${writeToken}`
  ) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(workspaceCatalog()));
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
      CODEOPS_SESSION_NOTIFICATION_URL: `http://127.0.0.1:${brokerPort}`,
      CODEOPS_SESSION_BROKER_READ_TOKEN_FILE: readTokenPath,
      CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE: writeTokenPath,
      CODEOPS_SESSION_OWNER_FIXED_PRINCIPAL: ownerPrincipal,
      CODEOPS_WORKSPACE_LAUNCH_URL: `http://127.0.0.1:${brokerPort}`,
      CODEOPS_WORKSPACE_LAUNCH_TOKEN_FILE: writeTokenPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  ui.stdout.on("data", (chunk) => { logs += chunk; });
  ui.stderr.on("data", (chunk) => { logs += chunk; });
  const origin = `http://127.0.0.1:${uiPort}`;
  try {
    await waitForUi(origin, ui);
    await runAgentsUiSmoke({
      baseUrl: origin,
      sessionId: legacySessionId,
      verifyNotificationGesture: true,
    });
    const subscriptions = brokerRequests.filter(
      ({ url }) => url === "/v1/session-notifications/subscriptions",
    );
    if (subscriptions.length !== 1 || !subscriptions[0].subscriptionDeviceId) {
      throw new Error(
        `notification subscription persistence proof failed: ${JSON.stringify(subscriptions)}`,
      );
    }
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
