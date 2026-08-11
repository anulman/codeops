#!/usr/bin/env bash
set -euo pipefail

namespace=""
while (($#)); do
  case "$1" in
    --namespace) namespace="${2:-}"; shift 2 ;;
    -h|--help) printf 'Usage: revoke-codeops-session-proof-runtime-credentials.sh --namespace <codeops-session-proof-name>\n'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$namespace" =~ ^codeops-session-proof-[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#namespace} -le 63 ]] || {
  printf 'namespace must be a codeops-session-proof-* Kubernetes name\n' >&2
  exit 2
}

kubectl -n "$namespace" delete secret \
  codeops-registry \
  codeops-agent-source-credentials \
  --ignore-not-found >/dev/null
printf 'Revoked two Agent Sessions proof runtime credentials from %s.\n' "$namespace"
