#!/bin/sh
set -eu

socket_path="${CODEOPS_ACP_SOCKET:-/run/codeops/agent.sock}"
done_path="$(dirname "$socket_path")/done"
codex_home="${CODEX_HOME:-/tmp/codex-home}"
mkdir -p "$codex_home"
if [ "$codex_home" = "/tmp/codex-home" ]; then
  chmod 700 "$codex_home"
else
  # A persistent Kubernetes volume root is managed by the CSI driver and may
  # reject chmod even though fsGroup grants this container the required access.
  # Validate only the narrow access the ACP adapter needs; never inspect or
  # copy the password-equivalent credential.
  test -r "$codex_home/auth.json"
  test -w "$codex_home"
fi
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
