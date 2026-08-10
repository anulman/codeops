#!/bin/sh
set -eu

socket_path="${CODEOPS_ACP_SOCKET:-/run/codeops/agent.sock}"
done_path="$(dirname "$socket_path")/done"
codex_home="${CODEX_HOME:-/tmp/codex-home}"
if [ "$codex_home" != "/tmp/codex-home" ]; then
  echo "CODEX_HOME must use the isolated temporary agent home" >&2
  exit 1
fi
mkdir -p "$codex_home"
chmod 700 "$codex_home"
export CODEX_HOME="$codex_home"
rm -f "$socket_path" "$done_path"

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
