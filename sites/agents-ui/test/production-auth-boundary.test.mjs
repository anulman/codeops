import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(origin, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Agents UI exited before readiness.\n${output()}`);
    }
    try {
      return await fetch(origin, { redirect: "manual" });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Agents UI did not become ready.\n${output()}`);
}

test("production rejects an unauthenticated document before SSR serialization", async (t) => {
  const port = await availablePort();
  let stdout = "";
  let stderr = "";
  const child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...globalThis.process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
      AGENTS_UI_ACCESS_REQUIRED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });

  const response = await waitForServer(`http://127.0.0.1:${port}/`, child, () => stdout + stderr);
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Unauthorized");
  assert.doesNotMatch(stdout + stderr, /Serialization error|SerovalUnsupportedTypeError/);
});
