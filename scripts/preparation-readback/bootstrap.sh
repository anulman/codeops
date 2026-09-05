#!/usr/bin/bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")"
/usr/bin/sha256sum --strict --check SHA256SUMS >/dev/null
out="${RUNNER_TEMP:?}/codeops-readback-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
# Refuse collisions, never remove earlier evidence.
mkdir -m 700 -- "$out"
(
  ulimit -v 131072
  ulimit -t 10
  ulimit -n 32
  ulimit -f 64
  exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
    RB_REPOSITORY="$GITHUB_REPOSITORY" RB_SHA="$GITHUB_SHA" \
    RB_WORKFLOW_SHA="$GITHUB_WORKFLOW_SHA" RB_WORKFLOW_REF="$GITHUB_WORKFLOW_REF" \
    RB_RUN_ID="$GITHUB_RUN_ID" RB_ATTEMPT="$GITHUB_RUN_ATTEMPT" RB_JOB="$GITHUB_JOB" \
    RB_IMAGE_OS="${ImageOS:-unknown}" RB_IMAGE_VERSION="${ImageVersion:-unknown}" \
    /usr/bin/timeout --signal=TERM --kill-after=2s 25s \
    /usr/bin/python3 -I -S -B discover.py
) >"$out/receipt.json" 2>"$out/error.json"
/usr/bin/sha256sum "$out/receipt.json" >"$out/receipt.sha256"
