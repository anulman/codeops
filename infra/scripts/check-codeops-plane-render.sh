#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
lock_path="${root}/infra/k8s/codeops/trial0/plane-chart.lock.json"
values_path="${root}/infra/k8s/codeops/trial0/plane-values.yaml"
rewrite_path="${root}/infra/scripts/rewrite-codeops-plane-images.mjs"
work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

chart_version="$(node -p "require('${lock_path}').chartVersion")"
chart_sha="$(node -p "require('${lock_path}').archiveSha256")"
chart_repo="$(node -p "require('${lock_path}').repository")"
chart_name="$(node -p "require('${lock_path}').chart")"
archive="${work_dir}/${chart_name}-${chart_version}.tgz"
rendered="${work_dir}/plane.yaml"

helm repo add codeops-plane "${chart_repo}" --force-update >/dev/null
helm pull "codeops-plane/${chart_name}" \
  --version "${chart_version}" \
  --destination "${work_dir}"
printf '%s  %s\n' "${chart_sha}" "${archive}" | sha256sum --check --status

helm template codeops-plane "${archive}" \
  --namespace codeops-bootstrap-0123456789ab \
  -f "${values_path}" \
  --set ingress.appHost=plane-0123456789ab.preview.renoconcierge.ca \
  | node "${rewrite_path}" \
  > "${rendered}"

if grep 'image:' "${rendered}" | grep -Ev '@sha256:[0-9a-f]{64}([[:space:]]|$)'; then
  echo "mutable Plane image survived the digest rewrite" >&2
  exit 1
fi

image_count="$(grep -c 'image:.*@sha256:' "${rendered}")"
test "${image_count}" -gt 0
echo "Plane chart ${chart_version} rendered with ${image_count} digest-only image references."
