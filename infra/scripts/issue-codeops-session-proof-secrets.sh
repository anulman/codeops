#!/usr/bin/env bash
set -euo pipefail

namespace=""
dry_run=false

usage() {
  printf 'Usage: issue-codeops-session-proof-secrets.sh --namespace <codeops-session-proof-name> [--dry-run]\n'
}

while (($#)); do
  case "$1" in
    --namespace) namespace="${2:-}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$namespace" =~ ^codeops-session-proof-[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#namespace} -le 63 ]] || {
  printf 'namespace must be a codeops-session-proof-* Kubernetes name\n' >&2
  exit 2
}

secret_names=(
  codeops-session-proof-database-owner
  codeops-session-broker-database
  codeops-session-broker-read-auth
  codeops-session-broker-write-auth
  codeops-session-runtime-worker-auth
  codeops-session-job-initialization-auth
  codeops-session-runtime-worker-database
)

if [[ "$dry_run" == true ]]; then
  printf 'Would issue seven distinct Agent Sessions proof Secrets in %s:\n' "$namespace"
  printf '  %s\n' "${secret_names[@]}"
  printf 'Database identities: codeops_session_broker_owner and codeops_session_runtime_worker\n'
  exit 0
fi

kubectl get namespace "$namespace" >/dev/null
for secret_name in "${secret_names[@]}"; do
  if kubectl -n "$namespace" get secret "$secret_name" >/dev/null 2>&1; then
    printf 'proof Secret already exists: %s/%s\n' "$namespace" "$secret_name" >&2
    exit 1
  fi
done

temp_dir="$(mktemp -d)"
chmod 700 "$temp_dir"
created=()
cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0)); then
    for secret_name in "${created[@]}"; do
      kubectl -n "$namespace" delete secret "$secret_name" --ignore-not-found >/dev/null 2>&1 || true
    done
  fi
  rm -rf -- "$temp_dir"
  exit "$status"
}
trap cleanup EXIT

owner_user=codeops_session_broker_owner
owner_password="$(openssl rand -hex 32)"
database=codeops_session_proof
worker_user=codeops_session_runtime_worker
worker_password="$(openssl rand -hex 32)"
owner_dsn="postgresql://${owner_user}:${owner_password}@codeops-session-proof-database:5432/${database}?sslmode=disable"
worker_dsn="postgresql://${worker_user}:${worker_password}@codeops-session-proof-database:5432/${database}?sslmode=disable"

write_value() {
  local path="$1"
  local value="$2"
  printf '%s' "$value" > "$temp_dir/$path"
  chmod 600 "$temp_dir/$path"
}

create_secret() {
  local secret_name="$1"
  shift
  kubectl -n "$namespace" create secret generic "$secret_name" "$@" >/dev/null
  created+=("$secret_name")
  kubectl -n "$namespace" label secret "$secret_name" \
    app.kubernetes.io/part-of=codeops-session-proof \
    codeops.example/credential-scope=session-video-proof \
    --overwrite >/dev/null
}

write_value owner-username "$owner_user"
write_value owner-password "$owner_password"
write_value database "$database"
create_secret codeops-session-proof-database-owner \
  "--from-file=username=$temp_dir/owner-username" \
  "--from-file=password=$temp_dir/owner-password" \
  "--from-file=database=$temp_dir/database"

write_value owner-database-url "$owner_dsn"
create_secret codeops-session-broker-database \
  "--from-file=database-url=$temp_dir/owner-database-url"

for capability in read write runtime-worker job-initialization; do
  write_value "$capability-token" "$(openssl rand -hex 32)"
done
create_secret codeops-session-broker-read-auth "--from-file=token=$temp_dir/read-token"
create_secret codeops-session-broker-write-auth "--from-file=token=$temp_dir/write-token"
create_secret codeops-session-runtime-worker-auth "--from-file=token=$temp_dir/runtime-worker-token"
create_secret codeops-session-job-initialization-auth "--from-file=token=$temp_dir/job-initialization-token"

write_value worker-password "$worker_password"
write_value worker-database-url "$worker_dsn"
create_secret codeops-session-runtime-worker-database \
  "--from-file=password=$temp_dir/worker-password" \
  "--from-file=database-url=$temp_dir/worker-database-url"

unset owner_password worker_password owner_dsn worker_dsn
trap - EXIT
rm -rf -- "$temp_dir"
printf 'Issued seven distinct Agent Sessions proof Secrets in %s.\n' "$namespace"
printf 'Revoke with infra/scripts/revoke-codeops-session-proof-secrets.sh --namespace %s\n' "$namespace"
