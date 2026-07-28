import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  authenticateBearer,
  parseDispatchRequest,
  resolveGitHubBranchHead,
} from "./core.js";
import { loadInClusterKubernetesClient } from "./kubernetes.js";
import { createAgentJobRunner } from "./runtime.js";

const MAX_BODY_BYTES = 1024 * 1024;

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

function requireDigestImage(name: string): string {
  const value = required(name);
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must be an immutable digest image`);
  }
  return value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("dispatch body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("dispatch body is empty");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": String(encoded.length),
  });
  response.end(encoded);
}

const namespace = required("CODEOPS_NAMESPACE");
const token = await secretFile("CODEOPS_DISPATCH_TOKEN_FILE");
if (token.length < 32 || token.length > 4_096) {
  throw new Error("dispatch token length is invalid");
}
const repositoryHeadToken = await secretFile(
  "CODEOPS_REPOSITORY_HEAD_TOKEN_FILE",
);
if (repositoryHeadToken.length < 32 || repositoryHeadToken.length > 4_096) {
  throw new Error("repository head token length is invalid");
}
const kubernetes = await loadInClusterKubernetesClient(namespace);
const modelAuthMode = required("CODEOPS_MODEL_AUTH_MODE");
const modelAuth =
  modelAuthMode === "chatgpt"
    ? {
        mode: "chatgpt" as const,
        claimName: required("CODEOPS_CODEX_AUTH_CLAIM"),
      }
    : modelAuthMode === "api-key"
      ? {
          mode: "api-key" as const,
          apiKey: await secretFile("CODEOPS_MODEL_API_KEY_FILE"),
        }
      : (() => {
          throw new Error(
            "CODEOPS_MODEL_AUTH_MODE must be api-key or chatgpt",
          );
        })();
const repositoryUrl = required("CODEOPS_REPOSITORY_URL");
const repositoryReadToken = await secretFile(
  "CODEOPS_REPOSITORY_READ_TOKEN_FILE",
);
const run = createAgentJobRunner({
  kubernetes,
  config: {
    namespace,
    repositoryUrl,
    agentImage: requireDigestImage("CODEOPS_AGENT_IMAGE"),
    sessionGatewayImage: requireDigestImage("CODEOPS_SESSION_GATEWAY_IMAGE"),
    repositoryReadToken,
    modelAuth,
    evidenceRoot: required("CODEOPS_EVIDENCE_ROOT"),
  },
});

let serial: Promise<unknown> = Promise.resolve();
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/v1/repository-heads/main"
    ) {
      if (
        !authenticateBearer(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          repositoryHeadToken,
        )
      ) {
        json(response, 401, { status: "unauthorized" });
        return;
      }
      try {
        json(response, 200, {
          version: "codeops.repository-head/v1",
          ref: "refs/heads/main",
          sha: await resolveGitHubBranchHead({
            repositoryUrl,
            repositoryReadToken,
            branch: "main",
          }),
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/agent-jobs") {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (
      !authenticateBearer(
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
        token,
      )
    ) {
      json(response, 401, { status: "unauthorized" });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { status: "unsupported-media-type" });
      return;
    }
    try {
      const dispatch = parseDispatchRequest(await readJson(request));
      const result = serial.then(() => run(dispatch));
      serial = result.catch(() => undefined);
      json(response, 200, await result);
    } catch {
      json(response, 503, { status: "unavailable" });
    }
  })();
});

const port = Number(process.env.CODEOPS_HTTP_PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CODEOPS_HTTP_PORT must be valid");
}
server.listen(port, process.env.CODEOPS_HTTP_HOST ?? "0.0.0.0");
