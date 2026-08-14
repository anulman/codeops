import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";

const script = new URL("../github-reads-mcp.mjs", import.meta.url);
const dockerfile = await readFile(
  new URL("../../../infra/docker/codeops-agent.Dockerfile", import.meta.url),
  "utf8",
);

test("packages the GitHub read MCP server as immutable agent-image content", () => {
  assert.match(
    dockerfile,
    /COPY services\/codeops-agent\/github-reads-mcp\.mjs \/opt\/codeops-agent\/github-reads-mcp\.mjs/,
  );
  assert.match(dockerfile, /chmod 0444 \/opt\/codeops-agent\/github-reads-mcp\.mjs/);
});

function nextMessage(lines) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP response timed out")), 5_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    });
  });
}

test("advertises only seven bounded read tools and relays one exact call", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks)) });
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({
        version: "codeops.github-search-result/v1",
        repository: "anulman/codeops",
        kind: "issues",
        query: "runtime",
        items: [],
        truncated: false,
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  const child = spawn(process.execPath, [script.pathname], {
    env: {
      ...process.env,
      CODEOPS_GITHUB_READS_BROKER_ORIGIN: `http://127.0.0.1:${address.port}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
    })}\n`);
    const listed = await nextMessage(lines);
    assert.deepEqual(listed.result.tools.map(({ name }) => name), [
      "github.pull_request_get",
      "github.pull_request_diff",
      "github.review_threads",
      "github.checks",
      "github.check_logs",
      "github.protected_branch",
      "github.search",
    ]);
    assert.equal(
      listed.result.tools.some(({ name }) => /create|update|comment|rerun|merge/.test(name)),
      false,
    );

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "github.search",
        arguments: {
          repository: "anulman/codeops",
          kind: "issues",
          query: "runtime",
          limit: 5,
        },
      },
    })}\n`);
    const called = await nextMessage(lines);
    assert.equal(called.result.isError, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/github/search");
    assert.deepEqual(requests[0].body, {
      repository: "anulman/codeops",
      kind: "issues",
      query: "runtime",
      limit: 5,
    });
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
  }
});
