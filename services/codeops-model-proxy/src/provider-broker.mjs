import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;
const FALLBACK_STATUSES = new Set([401, 403, 429]);

function string(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function jwtClaims(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function accountIdFromClaims(claims) {
  return string(claims?.chatgpt_account_id) ??
    string(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id);
}

function parseAuth(raw) {
  let auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new Error("ChatGPT auth file is not valid JSON");
  }
  const tokens = auth?.tokens;
  const accessToken = string(tokens?.access_token);
  const refreshToken = string(tokens?.refresh_token);
  const accountId = string(tokens?.account_id) ??
    accountIdFromClaims(jwtClaims(tokens?.id_token));
  if (auth?.auth_mode !== "chatgpt" || !accessToken || !refreshToken || !accountId) {
    throw new Error("ChatGPT auth file is incomplete");
  }
  return { auth, accessToken, refreshToken, accountId };
}

function accessTokenExpiresSoon(accessToken, now) {
  const exp = jwtClaims(accessToken)?.exp;
  return !Number.isSafeInteger(exp) || exp * 1_000 <= now + REFRESH_WINDOW_MS;
}

async function persistAuth(authFile, auth, refresh) {
  const tokens = { ...auth.tokens };
  if (string(refresh.id_token)) tokens.id_token = refresh.id_token;
  if (string(refresh.access_token)) tokens.access_token = refresh.access_token;
  if (string(refresh.refresh_token)) tokens.refresh_token = refresh.refresh_token;
  const next = {
    auth_mode: "chatgpt",
    tokens,
    last_refresh: new Date().toISOString(),
  };
  const temporary = join(dirname(authFile), `.auth.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, authFile);
}

function providerHeaders(headers, authorization, accountId = null) {
  const result = new Headers(headers);
  result.set("Authorization", `Bearer ${authorization}`);
  result.set("originator", "codex_cli_rs");
  result.set("User-Agent", "codeops-model-proxy/0.1");
  if (accountId === null) result.delete("ChatGPT-Account-ID");
  else result.set("ChatGPT-Account-ID", accountId);
  return result;
}

function chatGptBody(body) {
  const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
  delete parsed.background;
  return Buffer.from(JSON.stringify(parsed));
}

export function createProviderBroker(input) {
  const primaryMode = input.primaryMode;
  const apiKey = string(input.apiKey);
  const authFile = string(input.chatGptAuthFile);
  const allowApiKeyFallback = input.allowApiKeyFallback === true;
  const fetchImpl = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const log = input.log ?? (() => {});
  if (!["api-key", "chatgpt-primary"].includes(primaryMode)) {
    throw new Error("model provider primary mode is invalid");
  }
  if (primaryMode === "api-key" && apiKey === null) {
    throw new Error("API-key primary mode requires OPENAI_API_KEY");
  }
  if (primaryMode === "chatgpt-primary" && authFile === null) {
    throw new Error("ChatGPT primary mode requires an auth file");
  }
  if (allowApiKeyFallback && apiKey === null) {
    throw new Error("API-key fallback requires OPENAI_API_KEY");
  }

  let refreshPromise = null;
  async function loadAuth() {
    try {
      return parseAuth(await readFile(authFile, "utf8"));
    } catch (error) {
      throw new Error("ChatGPT auth file could not be loaded", { cause: error });
    }
  }
  async function refreshAuth(current) {
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = (async () => {
      const latest = await loadAuth();
      if (
        latest.accessToken !== current.accessToken &&
        !accessTokenExpiresSoon(latest.accessToken, now())
      ) return latest;
      let response;
      try {
        response = await fetchImpl(TOKEN_REFRESH_URL, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", originator: "codex_cli_rs" },
          body: JSON.stringify({
            client_id: CODEX_OAUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: latest.refreshToken,
          }),
        });
      } catch (error) {
        throw new Error("ChatGPT token refresh transport failed", { cause: error });
      }
      if (!response.ok) throw new Error(`ChatGPT token refresh rejected with ${response.status}`);
      const refreshed = await response.json();
      if (!string(refreshed.access_token)) {
        throw new Error("ChatGPT token refresh omitted the access token");
      }
      const refreshedAccount = accountIdFromClaims(jwtClaims(refreshed.id_token));
      if (refreshedAccount !== null && refreshedAccount !== latest.accountId) {
        throw new Error("ChatGPT token refresh changed the account identity");
      }
      await persistAuth(authFile, latest.auth, refreshed);
      return loadAuth();
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function apiRequest(init, fallbackReason = null) {
    log({ event: "model_proxy_provider_route", route: "api-key", fallbackReason });
    return fetchImpl(OPENAI_RESPONSES_URL, {
      ...init,
      headers: providerHeaders(init.headers, apiKey),
    });
  }

  async function chatGptRequest(init) {
    let auth = await loadAuth();
    if (accessTokenExpiresSoon(auth.accessToken, now())) auth = await refreshAuth(auth);
    const request = async () => fetchImpl(CHATGPT_RESPONSES_URL, {
      ...init,
      headers: providerHeaders(init.headers, auth.accessToken, auth.accountId),
      body: chatGptBody(init.body),
    });
    let response = await request();
    if (response.status === 401) {
      await response.body?.cancel();
      auth = await refreshAuth(auth);
      response = await request();
    }
    log({ event: "model_proxy_provider_route", route: "chatgpt", status: response.status });
    return response;
  }

  return async (url, init) => {
    if (String(url) !== OPENAI_RESPONSES_URL) {
      throw new Error("model provider broker received an unsupported upstream URL");
    }
    if (primaryMode === "api-key") return apiRequest(init);
    let response;
    try {
      response = await chatGptRequest(init);
    } catch (error) {
      if (!allowApiKeyFallback || error?.name === "AbortError") throw error;
      // Auth-file and refresh failures happen before chargeable inference. A
      // generic transport failure is ambiguous and must never duplicate work.
      if (!String(error?.message).startsWith("ChatGPT auth") &&
          !String(error?.message).startsWith("ChatGPT token")) throw error;
      return apiRequest(init, "subscription-auth");
    }
    if (allowApiKeyFallback && FALLBACK_STATUSES.has(response.status)) {
      await response.body?.cancel();
      return apiRequest(init, `subscription-${response.status}`);
    }
    return response;
  };
}

export const providerBrokerConstants = {
  CHATGPT_RESPONSES_URL,
  OPENAI_RESPONSES_URL,
  TOKEN_REFRESH_URL,
};
