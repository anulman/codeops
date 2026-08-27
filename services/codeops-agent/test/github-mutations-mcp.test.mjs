import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";

const script = new URL("../github-mutations-mcp.mjs", import.meta.url);
const dockerfile = await readFile(
  new URL("../../../infra/docker/codeops-agent.Dockerfile", import.meta.url),
  "utf8",
);

test("packages the GitHub mutation MCP server as immutable agent-image content", () => {
  assert.match(
    dockerfile,
    /COPY services\/codeops-agent\/github-mutations-mcp\.mjs \/opt\/codeops-agent\/github-mutations-mcp\.mjs/,
  );
  assert.match(
    dockerfile,
    /chmod 0444 \/opt\/codeops-agent\/github-mutations-mcp\.mjs/,
  );
});

test("pins the agent validation tools and verifies their archives", () => {
  assert.equal((dockerfile.match(/^FROM node:24-trixie-slim/gm) ?? []).length, 2);
  assert.match(dockerfile, /ARG HELM_VERSION=3\.19\.2/);
  assert.match(dockerfile, /ARG HELM_LINUX_AMD64_SHA256=2114c9dea2844dce6d0ee2d792a9aae846be8cf53d5b19dc2988b5a0e8fec26e/);
  assert.match(dockerfile, /ARG NUB_VERSION=0\.1\.11/);
  assert.match(dockerfile, /ARG NUB_LINUX_X64_SHA256=d227290e3a45c05ff20508a961f01950c50a138b08caf76d59f403e8a721330d/);
  assert.match(dockerfile, /sha256sum --check --strict/);
  assert.match(dockerfile, /helm version --short/);
  assert.match(dockerfile, /nub --version/);
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

test("advertises only six bounded mutation tools and relays one exact call", async () => {
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
        version: "codeops.github-check-rerun-result/v1",
        repository: "anulman/codeops",
        operationId: `githubmutation-${"a".repeat(64)}`,
        headSha: "b".repeat(40),
        checkRunId: 1234,
        accepted: true,
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  const child = spawn(process.execPath, [script.pathname], {
    env: {
      ...process.env,
      CODEOPS_GITHUB_MUTATIONS_BROKER_ORIGIN:
        `http://127.0.0.1:${address.port}`,
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
      "github.branch_publish",
      "github.pull_request_create",
      "github.pull_request_update_branch",
      "github.pull_request_update",
      "github.review_thread_reply",
      "github.check_rerun",
    ]);
    assert.equal(
      listed.result.tools.some(({ name }) => /merge|close|release|deploy|delete/.test(name)),
      false,
    );
    const branchPublish = listed.result.tools.find(
      ({ name }) => name === "github.branch_publish",
    );
    assert.equal(
      branchPublish.inputSchema.properties.changes.items.properties.oldText.minLength,
      undefined,
    );
    assert.deepEqual(branchPublish.inputSchema.properties.mode.enum, ["create", "fast_forward"]);
    assert.match(branchPublish.description, /atomically compares expectedBranchHeadSha/);
    assert.match(branchPublish.description, /262144 bytes \(256 KiB\)/);
    assert.match(branchPublish.inputSchema.description, /262144 bytes \(256 KiB\)/);
    assert.match(branchPublish.inputSchema.properties.expectedBranchHeadEffectId.description, /durable successful CodeOps publication effect/);
    assert.match(branchPublish.inputSchema.properties.expectedHeadSha.description, /not the atomic target-ref fence/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "github.check_rerun",
        arguments: {
          repository: "anulman/codeops",
          expectedHeadSha: "b".repeat(40),
          checkRunId: 1234,
        },
      },
    })}\n`);
    const called = await nextMessage(lines);
    assert.equal(called.result.isError, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/github-mutations/check/rerun");
    assert.deepEqual(requests[0].body, {
      repository: "anulman/codeops",
      expectedHeadSha: "b".repeat(40),
      checkRunId: 1234,
    });
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
  }
});
