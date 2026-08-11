#!/usr/bin/env bash
set -euo pipefail

namespace=""
while (($#)); do
  case "$1" in
    --namespace) namespace="${2:-}"; shift 2 ;;
    -h|--help) printf 'Usage: revoke-codeops-session-proof-secrets.sh --namespace <codeops-session-proof-name>\n'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$namespace" =~ ^codeops-session-proof-[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#namespace} -le 63 ]] || {
  printf 'namespace must be a codeops-session-proof-* Kubernetes name\n' >&2
  exit 2
}

kubectl -n "$namespace" delete secret \
  codeops-session-proof-database-owner \
  codeops-session-broker-database \
  codeops-session-broker-read-auth \
  codeops-session-broker-write-auth \
  codeops-session-runtime-worker-auth \
  codeops-session-job-initialization-auth \
  codeops-session-runtime-worker-database \
  --ignore-not-found >/dev/null
printf 'Revoked Agent Sessions proof Secrets in %s.\n' "$namespace"
