import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_TOKEN_TTL_SECONDS = 75 * 60;
const WARN_BODY_BYTES = 4 * 1024 * 1024;
const WARN_CONCURRENCY_PER_TOKEN = 4;
const MAX_CONCURRENCY_PER_TOKEN = 8;
const WARN_GLOBAL_CONCURRENCY = 8;
const MAX_GLOBAL_CONCURRENCY = 16;
const MAX_REQUEST_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_NODES = 100_000;
const MAX_REQUEST_DEPTH = 20;
const MAX_OBJECT_KEYS = 1_000;
const MAX_ARRAY_ITEMS = 10_000;

const ALLOWED_RESPONSE_FIELDS = new Set([
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "model",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_p",
  "truncation",
]);
const ALLOWED_TOOL_TYPES = new Set(["function", "custom"]);
const ALLOWED_INCLUDE_VALUES = new Set(["reasoning.encrypted_content"]);
const FORBIDDEN_NESTED_KEYS = new Set([
  "attachments",
  "conversation",
  "file_id",
  "previous_response_id",
  "vector_store_id",
  "vector_store_ids",
]);
const FORBIDDEN_ITEM_TYPES = new Set([
  "code_interpreter",
  "computer",
  "computer_call",
  "file_search",
  "image_generation",
  "input_file",
  "input_image",
  "mcp",
  "web_search",
  "web_search_preview",
]);

class RequestBodyLimitError extends Error {}
class RequestPolicyError extends Error {}

function validateBoundedJson(value) {
  const state = { nodes: 0, textBytes: 0 };
  const visit = (entry, depth) => {
    state.nodes += 1;
    if (state.nodes > MAX_REQUEST_NODES || depth > MAX_REQUEST_DEPTH) {
      throw new RequestPolicyError("request structured input exceeds its bound");
    }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new RequestPolicyError("request structured input contains an invalid number");
      }
      return;
    }
    if (typeof entry === "string") {
      state.textBytes += Buffer.byteLength(entry);
      if (state.textBytes > MAX_REQUEST_TEXT_BYTES) {
        throw new RequestPolicyError("request text exceeds 8 MiB");
      }
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length > MAX_ARRAY_ITEMS) {
        throw new RequestPolicyError("request array exceeds 10000 items");
      }
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (typeof entry !== "object") {
      throw new RequestPolicyError("request structured input contains an invalid value");
    }
    const fields = Object.entries(entry);
    if (fields.length > MAX_OBJECT_KEYS) {
      throw new RequestPolicyError("request object exceeds 1000 fields");
    }
    for (const [key, nested] of fields) {
      if (key.length > 200 || FORBIDDEN_NESTED_KEYS.has(key)) {
        throw new RequestPolicyError("request uses provider-hosted or external state");
      }
      if (key === "type" && FORBIDDEN_ITEM_TYPES.has(nested)) {
        throw new RequestPolicyError("request uses an unapproved hosted tool or file input");
      }
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
}

function enforceResponsesPrivacyPolicy(body, allowedModels, maxOutputTokens) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestPolicyError("request exceeds the model policy");
  }
  const unknownFields = Object.keys(body).filter(
    (field) => !ALLOWED_RESPONSE_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    throw new RequestPolicyError("request contains an unapproved Responses field");
  }
  if (
    !allowedModels.has(body.model) ||
    body.input === undefined ||
    (body.max_output_tokens !== undefined &&
      (!Number.isSafeInteger(body.max_output_tokens) ||
        body.max_output_tokens < 1 ||
        body.max_output_tokens > maxOutputTokens)) ||
    (body.store !== undefined && body.store !== false) ||
    (body.stream !== undefined && typeof body.stream !== "boolean") ||
    (body.parallel_tool_calls !== undefined &&
      typeof body.parallel_tool_calls !== "boolean") ||
    (body.temperature !== undefined &&
      (typeof body.temperature !== "number" ||
        !Number.isFinite(body.temperature) ||
        body.temperature < 0 ||
        body.temperature > 2)) ||
    (body.top_p !== undefined &&
      (typeof body.top_p !== "number" ||
        !Number.isFinite(body.top_p) ||
        body.top_p < 0 ||
        body.top_p > 1)) ||
    (body.truncation !== undefined &&
      !["auto", "disabled"].includes(body.truncation))
  ) {
    throw new RequestPolicyError("request exceeds the model policy");
  }
  if (body.include !== undefined) {
    if (
      !Array.isArray(body.include) ||
      body.include.length > ALLOWED_INCLUDE_VALUES.size ||
      new Set(body.include).size !== body.include.length ||
      body.include.some((value) => !ALLOWED_INCLUDE_VALUES.has(value))
    ) {
      throw new RequestPolicyError("request asks for unapproved included data");
    }
  }
  if (body.tools !== undefined) {
    if (
      !Array.isArray(body.tools) ||
      body.tools.length > 256 ||
      body.tools.some(
        (tool) =>
          tool === null ||
          typeof tool !== "object" ||
          Array.isArray(tool) ||
          !ALLOWED_TOOL_TYPES.has(tool.type),
      )
    ) {
      throw new RequestPolicyError("request uses an unapproved hosted tool");
    }
  }
  validateBoundedJson(body);
  return {
    ...body,
    store: false,
    max_output_tokens: body.max_output_tokens ?? maxOutputTokens,
  };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function unauthorized(response) {
  json(response, 401, { error: "unauthorized" });
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
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.sub) ||
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
    if (bytes > MAX_BODY_BYTES) {
      throw new RequestBodyLimitError("request body exceeds 20 MiB");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error("request body is empty");
  return { body: Buffer.concat(chunks), bytes };
}

export function createModelProxyRequestListener(input) {
  if (
    typeof input.openAiApiKey !== "string" ||
    input.openAiApiKey.length < 16 ||
    /\s/.test(input.openAiApiKey)
  ) {
    throw new Error("OpenAI API key is invalid");
  }
  const inFlightByRun = new Map();
  const requestsByRun = new Map();
  const allowedModels = new Set(
    input.allowedModels ?? ["gpt-5.6-sol", "gpt-5.4-nano-2026-03-17"],
  );
  const maxOutputTokens = input.maxOutputTokens ?? 32_768;
  const maxRequestsPerRun = input.maxRequestsPerRun ?? 200;
  if (
    allowedModels.size === 0 ||
    [...allowedModels].some((model) => typeof model !== "string" || model.length > 100) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 100_000 ||
    !Number.isSafeInteger(maxRequestsPerRun) ||
    maxRequestsPerRun < 1 ||
    maxRequestsPerRun > 1_000
  ) {
    throw new Error("model proxy request policy is invalid");
  }
  let globalInFlight = 0;
  const log = input.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const acquire = (runId) => {
    const tokenInFlight = inFlightByRun.get(runId) ?? 0;
    if (
      tokenInFlight >= MAX_CONCURRENCY_PER_TOKEN ||
      globalInFlight >= MAX_GLOBAL_CONCURRENCY
    ) {
      log({
        event: "model_proxy_stop_loss",
        subject: runId,
        tokenConcurrency: tokenInFlight,
        globalConcurrency: globalInFlight,
      });
      return null;
    }
    const nextTokenInFlight = tokenInFlight + 1;
    const nextGlobalInFlight = globalInFlight + 1;
    inFlightByRun.set(runId, nextTokenInFlight);
    globalInFlight = nextGlobalInFlight;
    if (
      nextTokenInFlight >= WARN_CONCURRENCY_PER_TOKEN ||
      nextGlobalInFlight >= WARN_GLOBAL_CONCURRENCY
    ) {
      log({
        event: "model_proxy_limit_warning",
        subject: runId,
        tokenConcurrency: nextTokenInFlight,
        globalConcurrency: nextGlobalInFlight,
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (inFlightByRun.get(runId) ?? 1) - 1;
      if (remaining === 0) inFlightByRun.delete(runId);
      else inFlightByRun.set(runId, remaining);
      globalInFlight -= 1;
    };
  };
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
      if (requestsByRun.size >= 1_024) {
        const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1_000);
        for (const [runId, usage] of requestsByRun) {
          if (usage.expiresAt <= nowSeconds) requestsByRun.delete(runId);
        }
      }
      const url = new URL(request.url ?? "", "http://codeops-model-proxy");
      if (
        request.method !== "POST" ||
        url.pathname !== "/v1/responses" ||
        url.search !== "" ||
        request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
      ) {
        json(response, 404, { error: "unsupported model operation" });
        return;
      }
      const release = acquire(authority.runId);
      if (release === null) {
        json(
          response,
          429,
          { error: "model proxy concurrency stop-loss reached" },
          { "Retry-After": "5" },
        );
        return;
      }
      const priorUsage = requestsByRun.get(authority.runId);
      const requestCount =
        priorUsage && priorUsage.expiresAt === authority.expiresAt
          ? priorUsage.count + 1
          : 1;
      if (requestCount > maxRequestsPerRun) {
        release();
        log({
          event: "model_proxy_request_stop_loss",
          subject: authority.runId,
          requestCount: requestCount - 1,
          maximumRequests: maxRequestsPerRun,
        });
        json(
          response,
          429,
          { error: "model proxy request stop-loss reached" },
          { "Retry-After": "60" },
        );
        return;
      }
      requestsByRun.set(authority.runId, {
        count: requestCount,
        expiresAt: authority.expiresAt,
      });
      const startedAt = Date.now();
      let status = 502;
      let requestBytes = 0;
      try {
        const bodyResult = await readBody(request);
        requestBytes = bodyResult.bytes;
        let body;
        try {
          body = JSON.parse(bodyResult.body.toString("utf8"));
        } catch {
          throw new RequestPolicyError("request body must be JSON");
        }
        const admittedBody = enforceResponsesPrivacyPolicy(
          body,
          allowedModels,
          maxOutputTokens,
        );
        const upstreamBody = Buffer.from(JSON.stringify(admittedBody));
        if (requestBytes >= WARN_BODY_BYTES) {
          log({
            event: "model_proxy_body_warning",
            subject: authority.runId,
            requestBytes,
            maximumBytes: MAX_BODY_BYTES,
          });
        }
        const headers = new Headers({
          Accept: typeof request.headers.accept === "string" ? request.headers.accept : "application/json",
          Authorization: `Bearer ${input.openAiApiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "codeops-model-proxy/0.1",
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
            body: upstreamBody,
            signal: AbortSignal.timeout(10 * 60 * 1_000),
          },
        );
        status = upstream.status;
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
        await new Promise((resolve, reject) => {
          Readable.fromWeb(upstream.body).once("error", reject).pipe(response).once("finish", resolve).once("error", reject);
        });
      } catch (error) {
        if (error instanceof RequestBodyLimitError) status = 413;
        else if (error instanceof RequestPolicyError) status = 400;
        throw error;
      } finally {
        release();
        log({
          event: "model_proxy_request",
          subject: authority.runId,
          status,
          latencyMs: Date.now() - startedAt,
          requestBytes,
        });
      }
    })().catch((error) => {
      if (!response.headersSent) {
        const status =
          error instanceof RequestBodyLimitError
            ? 413
            : error instanceof RequestPolicyError
              ? 400
              : 502;
        json(response, status, {
          error:
            status === 413
              ? "model proxy request exceeds the stop-loss limit"
              : status === 400
                ? "model proxy request exceeds the model policy"
                : "model proxy request failed",
        });
        return;
      }
      response.end();
    });
  };
}
