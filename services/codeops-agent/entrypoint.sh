#!/bin/sh
set -eu

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
  while [ ! -s "$CODEOPS_MODEL_PROXY_TOKEN_FILE" ]; do
    if [ "$waited" -ge "$token_wait_seconds" ]; then
      echo "short-lived model proxy token was not initialized" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  CODEX_API_KEY="$(cat "$CODEOPS_MODEL_PROXY_TOKEN_FILE")"
  if [ -z "$CODEX_API_KEY" ]; then
    echo "short-lived model proxy token is empty" >&2
    exit 1
  fi
  export CODEX_API_KEY
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
