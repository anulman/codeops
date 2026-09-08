import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";

function nextMessage(lines) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP response timed out")), 5000);
    lines.once("line", line => { clearTimeout(timer); resolve(JSON.parse(line)); });
  });
}
test("installed work-items MCP advertises and relays only bounded admission arguments", async () => {
  const docker = await readFile(new URL("../../../infra/docker/codeops-agent.Dockerfile", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../../codeops-session-runtime-worker/src/acp-workspace.ts", import.meta.url), "utf8");
  assert.match(docker, /COPY services\/codeops-agent\/work-items-mcp.mjs \/opt\/codeops-agent\/work-items-mcp.mjs/);
  assert.match(workspace, /args: \["\/opt\/codeops-agent\/work-items-mcp.mjs"\]/);
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"disposition":"replayed"}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const child = spawn(process.execPath, [new URL("../work-items-mcp.mjs", import.meta.url).pathname], {
    env: { ...process.env, CODEOPS_WORK_ITEMS_BROKER_ORIGIN: `http://127.0.0.1:${server.address().port}` }, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const call = async (id, method, params) => {
    const pending = nextMessage(lines); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); return pending;
  };
  try {
    const listed = await call(1, "tools/list", {});
    const admission = listed.result.tools.filter(tool => tool.name === "work_items.admit");
    assert.equal(admission.length, 1);
    assert.equal(admission[0].inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(admission[0].inputSchema.properties).sort(), ["prompt", "repository", "title", "workItemId"]);
    const input = { repository: "example-org/example-repository", workItemId: "11111111-1111-4111-8111-111111111111", title: "Publish", prompt: "Publish the exact candidate." };
    const result = await call(2, "tools/call", { name: "work_items.admit", arguments: input });
    assert.equal(result.result.isError, false);
    assert.deepEqual(calls, [{ url: "/v1/work-items/admit", body: input }]);
  } finally {
    lines.close(); child.kill(); await new Promise(resolve => server.close(resolve));
  }
});
