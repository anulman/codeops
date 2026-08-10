import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_TOKEN_TTL_SECONDS = 75 * 60;

function unauthorized(response) {
  response.writeHead(401, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end('{"error":"unauthorized"}\n');
}

export function validateModelProxyToken(input) {
  if (
    typeof input.signingKey !== "string" ||
    input.signingKey.length < 32 ||
    input.signingKey.length > 4_096
  ) {
    throw new Error("model proxy signing key length is invalid");
  }
  if (typeof input.token !== "string" || input.token.length > 8_192) {
    return null;
  }
  const match = input.token.match(/^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if (match === null) return null;
  const expected = createHmac("sha256", input.signingKey)
    .update(`v1.${match[1]}`)
    .digest();
  const supplied = Buffer.from(match[2], "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const now = Math.floor((input.now ?? Date.now()) / 1_000);
  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.aud !== "codeops-model-proxy" ||
    typeof payload.sub !== "string" ||
    !/^[a-z0-9-]{1,63}$/.test(payload.sub) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    payload.iat > now + 60 ||
    payload.exp <= now ||
    payload.exp - payload.iat > MAX_TOKEN_TTL_SECONDS
  ) {
    return null;
  }
  return { runId: payload.sub, expiresAt: payload.exp };
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body exceeds 20 MiB");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("request body is empty");
  return Buffer.concat(chunks);
}

export function createModelProxyRequestListener(input) {
  if (
    typeof input.openAiApiKey !== "string" ||
    input.openAiApiKey.length < 16 ||
    /\s/.test(input.openAiApiKey)
  ) {
    throw new Error("OpenAI API key is invalid");
  }
  return (request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/healthz") {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        });
        response.end('{"status":"ok"}\n');
        return;
      }
      const authorization = request.headers.authorization;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : "";
      const authority = validateModelProxyToken({
        token,
        signingKey: input.signingKey,
        now: input.now?.(),
      });
      if (authority === null) {
        unauthorized(response);
        return;
      }
      const url = new URL(request.url ?? "", "http://codeops-model-proxy");
      if (
        request.method !== "POST" ||
        url.pathname !== "/v1/responses" ||
        url.search !== "" ||
        request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
      ) {
        response.writeHead(404, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        });
        response.end('{"error":"unsupported model operation"}\n');
        return;
      }
      const body = await readBody(request);
      const headers = new Headers({
        Accept: typeof request.headers.accept === "string" ? request.headers.accept : "application/json",
        Authorization: `Bearer ${input.openAiApiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "renoconcierge-codeops-model-proxy/0.1",
      });
      for (const name of ["openai-beta", "idempotency-key", "x-client-request-id"]) {
        const value = request.headers[name];
        if (typeof value === "string" && value.length <= 1_024) headers.set(name, value);
      }
      const upstream = await (input.fetch ?? fetch)(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          redirect: "error",
          headers,
          body,
          signal: AbortSignal.timeout(10 * 60 * 1_000),
        },
      );
      const responseHeaders = {
        "Cache-Control": "no-store",
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      };
      for (const name of ["request-id", "x-request-id", "openai-processing-ms"]) {
        const value = upstream.headers.get(name);
        if (value !== null) responseHeaders[name] = value;
      }
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body === null) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).pipe(response);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        });
      }
      response.end('{"error":"model proxy request failed"}\n');
    });
  };
}
