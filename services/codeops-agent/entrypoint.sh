#!/bin/sh
set -eu

node --input-type=module - <<'NODE'
const providerName = "codeops_proxy";
const processProvider = process.env.MODEL_PROVIDER;
const proxyOrigin = process.env.CODEOPS_MODEL_PROXY_ORIGIN;
if (processProvider !== providerName) {
  throw new Error("MODEL_PROVIDER must equal codeops_proxy");
}
let origin;
try {
  origin = new URL(proxyOrigin ?? "");
} catch {
  throw new Error("CODEOPS_MODEL_PROXY_ORIGIN must be one valid URL");
}
if (
  origin.protocol !== "http:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
) {
  throw new Error("CODEOPS_MODEL_PROXY_ORIGIN must be one credential-free HTTP origin");
}
let config;
try {
  config = JSON.parse(process.env.CODEX_CONFIG ?? "");
} catch {
  throw new Error("CODEX_CONFIG must be valid JSON");
}
const providers = config?.model_providers;
const provider = providers?.[providerName];
if (
  config?.model_provider !== providerName ||
  !providers ||
  JSON.stringify(Object.keys(providers).sort()) !== JSON.stringify([providerName]) ||
  !provider ||
  JSON.stringify(Object.keys(provider).sort()) !==
    JSON.stringify(["base_url", "env_key", "name", "wire_api"]) ||
  provider.name !== "CodeOps model proxy" ||
  provider.base_url !== `${origin.origin}/v1` ||
  provider.env_key !== "CODEX_API_KEY" ||
  provider.wire_api !== "responses"
) {
  throw new Error("CODEX_CONFIG model proxy routing contract is invalid");
}
NODE

if [ "${CODEOPS_MODEL_PROXY_TOKEN_FILE:-}" != "/run/codeops/model-proxy-token" ]; then
  echo "CODEOPS_MODEL_PROXY_TOKEN_FILE must equal /run/codeops/model-proxy-token" >&2
  exit 1
fi
if [ "${CODEX_API_KEY+x}" = x ] || [ "${OPENAI_API_KEY+x}" = x ]; then
  echo "CODEX_API_KEY and OPENAI_API_KEY are forbidden before mounted token import" >&2
  exit 1
fi

socket_path="${CODEOPS_ACP_SOCKET:-/run/codeops/agent.sock}"
done_path="$(dirname "$socket_path")/done"
codex_home="${CODEX_HOME:-/var/lib/codeops-agent/codex-home}"
if [ "$codex_home" != "/var/lib/codeops-agent/codex-home" ]; then
  echo "CODEX_HOME must use the isolated per-Session agent home" >&2
  exit 1
fi
mkdir -p "$codex_home"
chmod 700 "$codex_home"
test -d "$codex_home"
test -w "$codex_home"
export CODEX_HOME="$codex_home"
rm -f "$socket_path" "$done_path"

if [ -n "${CODEOPS_MODEL_PROXY_TOKEN_FILE:-}" ]; then
  token_wait_seconds="${CODEOPS_MODEL_PROXY_TOKEN_WAIT_SECONDS:-60}"
  case "$token_wait_seconds" in
    ''|*[!0-9]*) echo "CODEOPS_MODEL_PROXY_TOKEN_WAIT_SECONDS must be an integer" >&2; exit 1 ;;
  esac
  waited=0
  while [ ! -f "$CODEOPS_MODEL_PROXY_TOKEN_FILE" ]; do
    if [ "$waited" -ge "$token_wait_seconds" ]; then
      echo "short-lived model proxy token was not initialized" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  CODEX_API_KEY="$(node --input-type=module - "$CODEOPS_MODEL_PROXY_TOKEN_FILE" <<'NODE'
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

const descriptor = openSync(
  process.argv[2],
  constants.O_RDONLY | constants.O_NOFOLLOW,
);
try {
  const stats = fstatSync(descriptor);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
    throw new Error("published model proxy token must be one mode 0600 regular file");
  }
  const token = readFileSync(descriptor);
  if (token.length === 0) {
    throw new Error("short-lived model proxy token is empty");
  }
  process.stdout.write(token);
} finally {
  closeSync(descriptor);
}
NODE
)"
  export CODEX_API_KEY
fi

if [ -z "${CODEX_API_KEY:-}" ]; then
  echo "CODEX_API_KEY is required" >&2
  exit 1
fi

socat \
  "UNIX-LISTEN:${socket_path},fork,unlink-early,mode=0600" \
  "EXEC:/opt/codeops-agent/node_modules/.bin/codex-acp,pipes,stderr" &
socat_pid=$!

cleanup() {
  kill "$socat_pid" 2>/dev/null || true
  wait "$socat_pid" 2>/dev/null || true
  rm -f "$socket_path"
}
trap cleanup EXIT INT TERM

while [ ! -f "$done_path" ]; do
  if ! kill -0 "$socat_pid" 2>/dev/null; then
    wait "$socat_pid"
    exit 1
  fi
  sleep 1
done
