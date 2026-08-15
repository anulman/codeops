import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import {
  ModelBudgetAuthorityError,
  ModelBudgetExhaustedError,
} from "./model-budget-ledger.mjs";

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

function enforceResponsesPrivacyPolicy(body, authority, allowedModels, maxOutputTokens) {
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
    body.model !== authority.model ||
    body.reasoning === null ||
    typeof body.reasoning !== "object" ||
    Array.isArray(body.reasoning) ||
    body.reasoning.effort !== authority.reasoningEffort ||
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
  const payloadKeys = payload !== null && typeof payload === "object"
    ? Object.keys(payload).sort().join(",")
    : "";
  const hasSessionBudgetAuthority = payloadKeys ===
    "aud,budgetId,exp,generation,iat,maximumOutputTokens,maximumRequests,model,reasoningEffort,sub";
  const hasLegacyAuthority = payloadKeys ===
    "aud,exp,iat,maximumOutputTokens,maximumRequests,model,reasoningEffort,sub";
  if (
    payload === null ||
    typeof payload !== "object" ||
    (!hasSessionBudgetAuthority && !hasLegacyAuthority) ||
    payload.aud !== "codeops-model-proxy" ||
    typeof payload.sub !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.sub) ||
    (hasSessionBudgetAuthority && (
      typeof payload.budgetId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.budgetId) ||
      !Number.isSafeInteger(payload.generation) ||
      payload.generation < 1
    )) ||
    typeof payload.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(payload.model) ||
    !["none", "low", "medium", "high", "xhigh"].includes(
      payload.reasoningEffort,
    ) ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    !Number.isSafeInteger(payload.maximumRequests) ||
    payload.maximumRequests < 1 ||
    payload.maximumRequests > 1_000 ||
    !Number.isSafeInteger(payload.maximumOutputTokens) ||
    payload.maximumOutputTokens < 1 ||
    payload.maximumOutputTokens > 100_000 ||
    payload.iat > now + 60 ||
    payload.exp <= now ||
    payload.exp - payload.iat > MAX_TOKEN_TTL_SECONDS
  ) {
    return null;
  }
  return {
    runId: payload.sub,
    budgetId: hasSessionBudgetAuthority ? payload.budgetId : null,
    generation: hasSessionBudgetAuthority ? payload.generation : null,
    modelTokenId: hasSessionBudgetAuthority
      ? `sha256:${createHash("sha256").update(input.token).digest("hex")}`
      : null,
    expiresAt: payload.exp,
    model: payload.model,
    reasoningEffort: payload.reasoningEffort,
    maximumRequests: payload.maximumRequests,
    maximumOutputTokens: payload.maximumOutputTokens,
  };
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

async function readBoundedProviderBody(upstream) {
  if (upstream.body === null) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(upstream.body)) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new Error("provider response exceeds 20 MiB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function providerRequestId(upstream, responseBody = null) {
  const candidate =
    upstream.headers.get("request-id") ??
    upstream.headers.get("x-request-id") ??
    responseBody?.id ??
    null;
  return typeof candidate === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(candidate)
    ? candidate
    : null;
}

function provedUsage(responseBody) {
  const usage = responseBody?.usage;
  if (
    usage === null ||
    typeof usage !== "object" ||
    !Number.isSafeInteger(usage.input_tokens) ||
    usage.input_tokens < 0 ||
    !Number.isSafeInteger(usage.output_tokens) ||
    usage.output_tokens < 0 ||
    !Number.isSafeInteger(usage.total_tokens) ||
    usage.total_tokens !== usage.input_tokens + usage.output_tokens
  ) {
    return null;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function unknownFailureClass(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "timeout"
    : "transport";
}

function sseSeparator(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 };
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function completedStreamEvent(block) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(block);
  } catch {
    return { invalid: true };
  }
  const data = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data === "" || data === "[DONE]") return null;
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return { invalid: true };
  }
  if (event?.type !== "response.completed") return null;
  const usage = provedUsage(event.response);
  return usage === null
    ? { invalid: true }
    : { invalid: false, usage, response: event.response };
}

async function writeChunk(response, chunk) {
  if (response.write(chunk)) return;
  await new Promise((resolve, reject) => {
    response.once("drain", resolve);
    response.once("error", reject);
  });
}

async function relaySettledStream(input) {
  let pending = Buffer.alloc(0);
  let terminal = null;
  const trailingBlocks = [];
  let invalidTerminal = false;
  let truncated = false;
  let bytes = 0;
  input.response.writeHead(input.upstream.status, input.responseHeaders);
  try {
    if (input.upstream.body !== null) {
      for await (const chunk of Readable.fromWeb(input.upstream.body)) {
        const next = Buffer.from(chunk);
        bytes += next.length;
        if (bytes > MAX_BODY_BYTES) {
          invalidTerminal = true;
          break;
        }
        pending = Buffer.concat([pending, next]);
        let separator;
        while ((separator = sseSeparator(pending)) !== null) {
          const end = separator.index + separator.length;
          const block = pending.subarray(0, end);
          pending = pending.subarray(end);
          const completed = completedStreamEvent(block);
          if (completed?.invalid === true) {
            invalidTerminal = true;
            continue;
          }
          if (completed !== null) {
            if (terminal !== null) {
              invalidTerminal = true;
              continue;
            }
            terminal = { block, ...completed };
            continue;
          }
          if (terminal !== null) {
            trailingBlocks.push(block);
            continue;
          }
          await writeChunk(input.response, block);
        }
      }
    }
  } catch {
    truncated = true;
  }
  if (pending.toString("utf8").trim() !== "") invalidTerminal = true;
  const requestId = providerRequestId(input.upstream, terminal?.response);
  if (terminal === null || invalidTerminal) {
    await input.ledger.settle({
      reservationId: input.reservationId,
      state: "charged_unknown",
      providerRequestId: requestId,
      provedInputTokens: null,
      provedOutputTokens: null,
      provedTotalTokens: null,
      failureClass: truncated
        ? "truncated_stream"
        : terminal === null
          ? "missing_terminal_usage"
          : "invalid_terminal_usage",
    });
  } else {
    await input.ledger.settle({
      reservationId: input.reservationId,
      state: "settled",
      providerRequestId: requestId,
      provedInputTokens: terminal.usage.inputTokens,
      provedOutputTokens: terminal.usage.outputTokens,
      provedTotalTokens: terminal.usage.totalTokens,
      failureClass: null,
    });
    await writeChunk(input.response, terminal.block);
    for (const block of trailingBlocks) await writeChunk(input.response, block);
  }
  input.response.end();
}

export function createModelProxyRequestListener(input) {
  if (
    typeof input.openAiApiKey !== "string" ||
    input.openAiApiKey.length < 16 ||
    /\s/.test(input.openAiApiKey)
  ) {
    throw new Error("OpenAI API key is invalid");
  }
  if (
    input.modelBudgetLedger === null ||
    typeof input.modelBudgetLedger?.reserve !== "function" ||
    typeof input.modelBudgetLedger?.settle !== "function"
  ) {
    throw new Error("model budget ledger is invalid");
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
      if (authority.budgetId === null) {
        const priorUsage = requestsByRun.get(authority.runId);
        const requestCount =
          priorUsage && priorUsage.expiresAt === authority.expiresAt
            ? priorUsage.count + 1
            : 1;
        const admittedMaximumRequests = Math.min(
          maxRequestsPerRun,
          authority.maximumRequests,
        );
        if (requestCount > admittedMaximumRequests) {
          release();
          log({
            event: "model_proxy_request_stop_loss",
            subject: authority.runId,
            requestCount: requestCount - 1,
            maximumRequests: admittedMaximumRequests,
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
      }
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
          authority,
          allowedModels,
          Math.min(maxOutputTokens, authority.maximumOutputTokens),
        );
        const reservationId = authority.budgetId === null ? null : randomUUID();
        if (reservationId !== null) {
          try {
            await input.modelBudgetLedger.reserve({
              reservationId,
              modelTokenId: authority.modelTokenId,
              sessionId: authority.runId,
              budgetId: authority.budgetId,
              generation: authority.generation,
              provider: "openai",
              model: authority.model,
              reasoningEffort: authority.reasoningEffort,
              requestedOutputTokens: admittedBody.max_output_tokens,
              reservedOutputTokens: admittedBody.max_output_tokens,
            });
          } catch (error) {
            if (error instanceof ModelBudgetExhaustedError) {
              status = 429;
              json(
                response,
                status,
                { error: "model budget exhausted", limit: error.limit },
                { "Retry-After": "60" },
              );
              return;
            }
            if (error instanceof ModelBudgetAuthorityError) {
              status = 403;
              json(response, status, { error: "model budget authority invalid" });
              return;
            }
            throw error;
          }
        }
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
        let upstream;
        try {
          upstream = await (input.fetch ?? fetch)(
            "https://api.openai.com/v1/responses",
            {
              method: "POST",
              redirect: "error",
              headers,
              body: upstreamBody,
              signal: AbortSignal.timeout(10 * 60 * 1_000),
            },
          );
        } catch (error) {
          if (reservationId !== null) {
            await input.modelBudgetLedger.settle({
              reservationId,
              state: "charged_unknown",
              providerRequestId: null,
              provedInputTokens: null,
              provedOutputTokens: null,
              provedTotalTokens: null,
              failureClass: unknownFailureClass(error),
            });
          }
          throw error;
        }
        status = upstream.status;
        const responseHeaders = {
          "Cache-Control": "no-store",
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        };
        for (const name of ["request-id", "x-request-id", "openai-processing-ms"]) {
          const value = upstream.headers.get(name);
          if (value !== null) responseHeaders[name] = value;
        }
        if (reservationId === null) {
          response.writeHead(upstream.status, responseHeaders);
          if (upstream.body === null) {
            response.end();
            return;
          }
          await new Promise((resolve, reject) => {
            Readable.fromWeb(upstream.body)
              .once("error", reject)
              .pipe(response)
              .once("finish", resolve)
              .once("error", reject);
          });
          return;
        }
        if (upstream.ok && admittedBody.stream === true) {
          await relaySettledStream({
            upstream,
            response,
            responseHeaders,
            ledger: input.modelBudgetLedger,
            reservationId,
          });
          return;
        }
        const providerBody = await readBoundedProviderBody(upstream);
        const providerJson = parseJson(providerBody);
        const requestId = providerRequestId(upstream, providerJson);
        if (upstream.status >= 400 && upstream.status < 500) {
          await input.modelBudgetLedger.settle({
            reservationId,
            state: "provider_rejected",
            providerRequestId: requestId,
            provedInputTokens: null,
            provedOutputTokens: null,
            provedTotalTokens: null,
            failureClass: "provider_rejected",
          });
        } else if (upstream.ok && admittedBody.stream !== true) {
          const usage = provedUsage(providerJson);
          await input.modelBudgetLedger.settle(
            usage === null
              ? {
                  reservationId,
                  state: "charged_unknown",
                  providerRequestId: requestId,
                  provedInputTokens: null,
                  provedOutputTokens: null,
                  provedTotalTokens: null,
                  failureClass: providerJson === null
                    ? "invalid_terminal_usage"
                    : "missing_terminal_usage",
                }
              : {
                  reservationId,
                  state: "settled",
                  providerRequestId: requestId,
                  provedInputTokens: usage.inputTokens,
                  provedOutputTokens: usage.outputTokens,
                  provedTotalTokens: usage.totalTokens,
                  failureClass: null,
                },
          );
        } else {
          await input.modelBudgetLedger.settle({
            reservationId,
            state: "charged_unknown",
            providerRequestId: requestId,
            provedInputTokens: null,
            provedOutputTokens: null,
            provedTotalTokens: null,
            failureClass: "transport",
          });
        }
        response.writeHead(upstream.status, responseHeaders);
        response.end(providerBody);
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
