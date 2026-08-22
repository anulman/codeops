# Run exact-source visual acceptance

The acceptance-runner image can run one deterministic, repository-owned visual
acceptance contract. This path is a non-interactive Validate action. It makes no
model call and does not use an Agent Session.

The action fails unless it can:

- fetch the exact head and base commits with a dedicated read-only GitHub
  credential;
- verify the SHA-256 digest of the head scenario entrypoint and base catalog;
- verify a trusted preview attestation for the same repository, pull request,
  head, origin, and immutable preview image;
- run the repository entrypoint first in `execute` mode and then in `cleanup`
  mode;
- verify all required case, DOM, accessibility, network, console, privacy, and
  responsive assertions;
- verify one unannotated canonical WebM and derive one labeled H.264 reviewer
  MP4;
- verify zero run-owned properties, opportunities, customer files, and
  credentials after cleanup; and
- persist and re-read every artifact before it writes the manifest and
  qualification envelope.

## Authority inputs

Mount each input as a separate regular file. Do not put credentials in the
request JSON or repository checkout.

| Environment variable | Content |
| --- | --- |
| `CODEOPS_VALIDATE_GITHUB_TOKEN_FILE` | Dedicated read-only token for the one admitted repository. |
| `CODEOPS_VALIDATE_PREVIEW_ATTESTATION_FILE` | Trusted `codeops.preview-attestation/v1` JSON from the preview deployment authority. |
| `CODEOPS_VALIDATE_FIXTURE_ENV_FILE` | JSON object with 1–32 bounded `RENO_*` values for the disposable fixture isolate. |
| `CODEOPS_VALIDATE_PREVIEW_HEADERS_FILE` | JSON object with bounded lowercase headers for preview access. |
| `CODEOPS_VALIDATE_FFMPEG_PATH` | Absolute executable path to a separately supplied FFmpeg CLI. |
| `CODEOPS_VALIDATE_FFPROBE_PATH` | Absolute executable path to the matching FFprobe CLI. |
| `CODEOPS_VALIDATE_SCENARIO_ENTRYPOINT_FILE` | Required only for an `operator` scenario. It supplies the separately mounted, digest-bound scenario entrypoint. |

CodeOps does not distribute FFmpeg. The operator must supply an approved
process-level tool outside the CodeOps image and must meet its license and
notice obligations.

The output directory must be a new directory on durable, run-scoped storage.
The action removes an incomplete output directory after any failure. The
fixture entrypoint must make `cleanup` idempotent because CodeOps invokes it
after both successful and failed execution.

## Request

Pass one absolute request path to the runner:

```sh
node src/visual-acceptance-runner.mjs /run/request.json
```

The request uses `codeops.visual-acceptance-request/v1`. It binds:

- repository identity, pull request, exact head, and exact base;
- exact preview origin and immutable preview image;
- run ID;
- a `candidate` or `operator` scenario source, a logical entrypoint path, and
  the exact entrypoint SHA-256 digest;
- a repository-relative base-catalog path and exact SHA-256 digest;
- the complete ordered case list;
- Chromium and all named viewports;
- separate persistent-group recommendations and scheduled-candidate
  recommendations;
- `pr-only` retention and an expiry timestamp; and
- one new absolute packet directory.

For a `candidate` source, CodeOps reads the entrypoint from the exact head
checkout. For an `operator` source, CodeOps reads the separately mounted file,
verifies its requested digest, and still supplies read-only exact head and base
checkouts. This operator path lets a userland Validate action inspect a
candidate that does not yet contain the generic proof adapter. It does not
change candidate bytes.

The entrypoint receives the generated executor request path as its first
argument and either `execute` or `cleanup` as its second argument. It must write
`scenario-result.json` in `execute` mode and `cleanup-verification.json` in
`cleanup` mode. The scenario result must use
`codeops.visual-acceptance-result/v1` and name all artifact paths relative to
the packet directory.

The result must contain one canonical unannotated `video/webm` artifact. It
also supplies time-bounded action labels. CodeOps applies those labels while it
derives `reviewer-annotated.noncanonical.mp4`. The MP4 is always marked
non-canonical.

## Packet and publication

The action writes:

- repository-produced raw evidence files;
- the canonical secret-free `request.json` used for the run;
- `reviewer-annotated.noncanonical.mp4`;
- `REPLAY.md`;
- `manifest.json` and `manifest.sha256`; and
- `qualification.json` and `qualification.sha256`.

The manifest records byte counts, SHA-256 digests, content types, case IDs,
viewport, browser, timestamps, retention class, expiry, cleanup, head, base,
preview origin, preview image, scenario source, run ID, persistent-group
recommendations, and scheduled-candidate recommendations. The qualification
envelope repeats the exact head, base, preview origin, preview image, scenario
source and digest, base-catalog digest, request digest, recommendations, and
manifest digest.

A trusted controller may publish `qualification.json` to the exact pull-request
head only after separate publication authorization. The runner does not hold a
GitHub write credential and does not publish status itself. A changed head,
base, preview origin, preview image, entrypoint source or digest, catalog
digest, request, or recommendation set cannot match the old qualification
envelope and requires a new run.

Visual evidence is `pr-only` by default. The two recommendation lists are
advisory packet evidence. Running this action does not create a persistent
test group and does not schedule a test candidate.
