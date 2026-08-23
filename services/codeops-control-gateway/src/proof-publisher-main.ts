import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { authenticateBearer } from "./bearer-auth.js";
import {
  createAwsS3Transport,
  createS3ProofPublisher,
  type S3ProofPublisherConfig,
} from "./proof-publisher.js";

const MAX_BODY_BYTES = 84 * 1024 * 1024;

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

function integer(name: string, minimum: number, maximum: number): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    request.destroy();
    throw new Error("request body exceeds 84 MiB");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      request.destroy();
      throw new Error("request body exceeds 84 MiB");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(bytes);
}

const authToken = await secretFile("CODEOPS_PROOF_PUBLISHER_AUTH_TOKEN_FILE");
if (authToken.length < 32 || authToken.length > 4_096) {
  throw new Error("proof publisher auth token length is invalid");
}
const config: S3ProofPublisherConfig = {
  destinationId: required("CODEOPS_PROOF_PUBLISHER_DESTINATION_ID"),
  endpoint: required("CODEOPS_PROOF_PUBLISHER_S3_ENDPOINT"),
  publicBaseUrl: required("CODEOPS_PROOF_PUBLISHER_PUBLIC_BASE_URL"),
  bucket: required("CODEOPS_PROOF_PUBLISHER_S3_BUCKET"),
  region: required("CODEOPS_PROOF_PUBLISHER_S3_REGION"),
  retentionDays: integer("CODEOPS_PROOF_PUBLISHER_RETENTION_DAYS", 1, 3650),
  accessKeyId: await secretFile("CODEOPS_PROOF_PUBLISHER_ACCESS_KEY_ID_FILE"),
  secretAccessKey: await secretFile(
    "CODEOPS_PROOF_PUBLISHER_SECRET_ACCESS_KEY_FILE",
  ),
};
const publish = createS3ProofPublisher(config, {
  transport: createAwsS3Transport(config),
});

const server = createServer((request, response) => {
  void (async () => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/proof-publications") {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (
      !authenticateBearer(
        typeof request.headers.authorization === "string"
          ? request.headers.authorization
          : undefined,
        authToken,
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
      const receipt = await publish(await readJson(request));
      json(response, receipt.status === "published" ? 200 : 409, receipt);
    } catch {
      json(response, 400, { status: "invalid-request" });
    }
  })().catch(() => {
    if (!response.headersSent) json(response, 503, { status: "unavailable" });
    else response.destroy();
  });
});

const port = integer("CODEOPS_HTTP_PORT", 1, 65_535);
server.listen(port, process.env.CODEOPS_HTTP_HOST?.trim() || "0.0.0.0");
