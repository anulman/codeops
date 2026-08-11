#!/usr/bin/env bash
set -euo pipefail

namespace=""
registry_config_file=""
repository_token_file=""
dry_run=false

usage() {
  printf 'Usage: issue-codeops-session-proof-runtime-credentials.sh --namespace <codeops-session-proof-name> --registry-config-file <path> --repository-token-file <path> [--dry-run]\n'
}

while (($#)); do
  case "$1" in
    --namespace) namespace="${2:-}"; shift 2 ;;
    --registry-config-file) registry_config_file="${2:-}"; shift 2 ;;
    --repository-token-file) repository_token_file="${2:-}"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$namespace" =~ ^codeops-session-proof-[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#namespace} -le 63 ]] || {
  printf 'namespace must be a codeops-session-proof-* Kubernetes name\n' >&2
  exit 2
}

credential_names=(codeops-registry codeops-agent-source-credentials)
if [[ "$dry_run" == true ]]; then
  printf 'Would issue two create-only Agent Sessions runtime credentials in %s:\n' "$namespace"
  printf '  %s\n' "${credential_names[@]}"
  printf 'Inputs: one Kubernetes registry config and one repository read token file.\n'
  exit 0
fi

for path in "$registry_config_file" "$repository_token_file"; do
  [[ -f "$path" && ! -L "$path" && -s "$path" ]] || {
    printf 'credential input must be one non-empty regular file, not a symlink\n' >&2
    exit 2
  }
done
registry_size="$(wc -c < "$registry_config_file")"
repository_size="$(wc -c < "$repository_token_file")"
((registry_size >= 32 && registry_size <= 65536 && repository_size >= 20 && repository_size <= 257)) || {
  printf 'credential input size is outside the bounded contract\n' >&2
  exit 2
}
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!value.auths || typeof value.auths !== "object" || Array.isArray(value.auths) || Object.keys(value.auths).length !== 1) process.exit(1);
  const entry = value.auths["ghcr.io"];
  if (!entry || typeof entry !== "object" || typeof entry.auth !== "string" || entry.auth.length < 8 || entry.auth.length > 4096) process.exit(1);
  if (Object.hasOwn(value, "credsStore") || Object.hasOwn(value, "credHelpers")) process.exit(1);
' "$registry_config_file" || {
  printf 'registry config must contain exactly one ghcr.io auth entry\n' >&2
  exit 2
}

(( $(wc -l < "$repository_token_file") <= 1 )) || {
  printf 'repository token file must contain one line\n' >&2
  exit 2
}
repository_token="$(tr -d '\r\n' < "$repository_token_file")"
[[ "$repository_token" =~ ^[A-Za-z0-9_]{20,255}$ ]] || {
  unset repository_token
  printf 'repository token must be one bounded token value\n' >&2
  exit 2
}

kubectl get namespace "$namespace" >/dev/null
for credential_name in "${credential_names[@]}"; do
  if kubectl -n "$namespace" get secret "$credential_name" >/dev/null 2>&1; then
    unset repository_token
    printf 'proof runtime credential already exists: %s/%s\n' "$namespace" "$credential_name" >&2
    exit 1
  fi
done

temp_dir="$(mktemp -d)"
chmod 700 "$temp_dir"
created=()
cleanup() {
  local status=$?
  trap - EXIT
  unset repository_token
  if ((status != 0)); then
    for credential_name in "${created[@]}"; do
      kubectl -n "$namespace" delete secret "$credential_name" --ignore-not-found >/dev/null 2>&1 || true
    done
  fi
  rm -rf -- "$temp_dir"
  exit "$status"
}
trap cleanup EXIT

install -m 600 "$registry_config_file" "$temp_dir/registry-config.json"
printf '%s' "$repository_token" > "$temp_dir/repository-read-token"
chmod 600 "$temp_dir/repository-read-token"
unset repository_token

kubectl -n "$namespace" create secret generic codeops-registry \
  --type=kubernetes.io/dockerconfigjson \
  "--from-file=.dockerconfigjson=$temp_dir/registry-config.json" >/dev/null
created+=(codeops-registry)
kubectl -n "$namespace" create secret generic codeops-agent-source-credentials \
  "--from-file=repository-read-token=$temp_dir/repository-read-token" >/dev/null
created+=(codeops-agent-source-credentials)

for credential_name in "${created[@]}"; do
  kubectl -n "$namespace" label secret "$credential_name" \
    app.kubernetes.io/part-of=codeops-session-proof \
    codeops.example/credential-scope=session-video-proof-runtime \
    --overwrite >/dev/null
done

trap - EXIT
rm -rf -- "$temp_dir"
printf 'Issued two Agent Sessions proof runtime credentials in %s.\n' "$namespace"
printf 'Revoke with infra/scripts/revoke-codeops-session-proof-runtime-credentials.sh --namespace %s\n' "$namespace"
