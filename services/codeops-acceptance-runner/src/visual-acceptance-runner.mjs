#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseVisualAcceptanceRequest,
  parseVisualAcceptanceResult,
} from "./visual-acceptance-contract.mjs";

const MAX_ARTIFACT_BYTES = 1_000_000_000;
const MAX_RESULT_BYTES = 4_000_000;
const MAX_PROCESS_OUTPUT_BYTES = 64_000;
const MIN_FRAME_EVENT_COUNT = 20;
const MIN_CAPTURE_RATIO = 0.8;
const MAX_INTER_FRAME_GAP_MS = 2_000;
const MAX_CONSECUTIVE_GEOMETRY_DISCARDS = 3;
const MAX_DURATION_DRIFT_MS = 2_500;
const MAX_SOURCE_ASPECT_RATIO_DRIFT = 0.002;
const REQUIRED_ENVIRONMENT = Object.freeze([
  "CODEOPS_VALIDATE_GITHUB_TOKEN_FILE",
  "CODEOPS_VALIDATE_PREVIEW_ATTESTATION_FILE",
  "CODEOPS_VALIDATE_FIXTURE_ENV_FILE",
  "CODEOPS_VALIDATE_PREVIEW_HEADERS_FILE",
  "CODEOPS_VALIDATE_FFMPEG_PATH",
  "CODEOPS_VALIDATE_FFPROBE_PATH",
]);
const OPERATOR_ENTRYPOINT_ENVIRONMENT = "CODEOPS_VALIDATE_SCENARIO_ENTRYPOINT_FILE";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readBoundedFile(file, maximum, label) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximum) {
    throw new Error(`${label} must be one regular file of at most ${maximum} bytes`);
  }
  return readFile(file);
}

async function readJson(file, maximum, label) {
  const bytes = await readBoundedFile(file, maximum, label);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is not valid JSON`); }
}

function safeEnvironmentFilePath(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${name} must name one normalized absolute file`);
  }
  return value;
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let bytes = 0;
    const collect = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_PROCESS_OUTPUT_BYTES) child.kill("SIGKILL");
      else output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || bytes > MAX_PROCESS_OUTPUT_BYTES) {
        const detail = options.discardOutput ? "" : `: ${output.slice(-8_000)}`;
        reject(new Error(`${options.label ?? path.basename(command)} failed${bytes > MAX_PROCESS_OUTPUT_BYTES ? " with excessive output" : ""}${detail}`));
      } else resolve(output);
    });
  });
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields must match exactly`);
  }
  return value;
}

async function verifyAttestation(request, environment) {
  const file = safeEnvironmentFilePath(environment, "CODEOPS_VALIDATE_PREVIEW_ATTESTATION_FILE");
  const attestation = exactKeys(await readJson(file, 16_384, "preview attestation"), [
    "version", "repository", "pullRequest", "headSha", "previewOrigin", "previewImage", "attestedAt",
  ], "preview attestation");
  if (attestation.version !== "codeops.preview-attestation/v1"
    || attestation.repository !== request.repository
    || attestation.pullRequest !== request.pullRequest
    || attestation.headSha !== request.headSha
    || attestation.previewOrigin !== request.preview.origin
    || attestation.previewImage !== request.preview.image
    || !Number.isFinite(Date.parse(attestation.attestedAt))) {
    throw new Error("preview attestation does not match the exact Validate request");
  }
  return { ...attestation, sourceDigest: sha256(await readFile(file)) };
}

async function readFixtureEnvironment(environment) {
  const file = safeEnvironmentFilePath(environment, "CODEOPS_VALIDATE_FIXTURE_ENV_FILE");
  const raw = await readJson(file, 64_000, "fixture environment");
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length < 1 || Object.keys(raw).length > 32) {
    throw new Error("fixture environment must contain 1 to 32 entries");
  }
  const result = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^RENO_[A-Z0-9_]{1,80}$/.test(name) || typeof value !== "string" || value.length < 1
      || value.length > 8_192 || /[\u0000\r\n]/.test(value)) {
      throw new Error("fixture environment contains an invalid name or value");
    }
    result[name] = value;
  }
  return result;
}

async function verifyHeadersFile(environment) {
  const file = safeEnvironmentFilePath(environment, "CODEOPS_VALIDATE_PREVIEW_HEADERS_FILE");
  const headers = await readJson(file, 64_000, "preview headers");
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length < 1
    || Object.keys(headers).length > 16) throw new Error("preview headers must contain 1 to 16 entries");
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[a-z0-9-]{1,80}$/.test(name) || typeof value !== "string" || value.length < 1
      || value.length > 8_192 || /[\u0000\r\n]/.test(value)) throw new Error("preview headers contain an invalid name or value");
  }
  return file;
}

async function materializeOne({ request, revision, target, token, runProcess }) {
  await mkdir(target, { recursive: false, mode: 0o700 });
  const repositoryUrl = `https://github.com/${request.repository}.git`;
  const authorization = Buffer.from(`x-access-token:${token}`).toString("base64");
  const git = async (args) => runProcess("git", ["-c", `safe.directory=${target}`, "-C", target, ...args], {
    env: { PATH: process.env.PATH ?? "", GIT_TERMINAL_PROMPT: "0" },
    label: "exact-source materialization",
  });
  await git(["init"]);
  await git(["remote", "add", "origin", repositoryUrl]);
  try {
    await git(["-c", `http.extraHeader=Authorization: Basic ${authorization}`, "fetch", "--depth=1", "origin", revision]);
    await git(["checkout", "--detach", "FETCH_HEAD"]);
    const exact = (await git(["rev-parse", "HEAD"])).trim();
    if (exact !== revision) throw new Error("materialized repository revision does not match the request");
  } finally {
    await git(["remote", "remove", "origin"]).catch(() => undefined);
  }
}

async function verifySourceFile(root, relative, expectedDigest, label) {
  const file = path.join(root, relative);
  const resolvedRoot = `${await realpath(root)}${path.sep}`;
  const resolvedFile = await realpath(file);
  if (!resolvedFile.startsWith(resolvedRoot)) throw new Error(`${label} escapes its exact source checkout`);
  const bytes = await readBoundedFile(resolvedFile, 4_000_000, label);
  if (sha256(bytes) !== expectedDigest) throw new Error(`${label} digest does not match the request`);
  return resolvedFile;
}

async function verifyOperatorEntrypoint(environment, expectedDigest) {
  const file = safeEnvironmentFilePath(environment, OPERATOR_ENTRYPOINT_ENVIRONMENT);
  const bytes = await readBoundedFile(file, 4_000_000, "operator scenario entrypoint");
  if (sha256(bytes) !== expectedDigest) throw new Error("operator scenario entrypoint digest does not match the request");
  return realpath(file);
}

function escapeDrawtext(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'").replaceAll("%", "\\%");
}

function annotationFilter(annotations) {
  return annotations.map(({ label, startSeconds, endSeconds }) =>
    `drawtext=text='${escapeDrawtext(label)}':x=(w-text_w)/2:y=h-text_h-36:fontcolor=white:fontsize=24:box=1:boxcolor=black@0.72:boxborderw=10:enable='between(t,${startSeconds},${endSeconds})'`,
  ).join(",");
}

async function deriveReviewerVideo({ canonicalFile, outputFile, annotations, canonicalVideo, ffmpeg, ffprobe, runProcess }) {
  const trimStartSeconds = Math.min(...annotations.map(({ startSeconds }) => startSeconds));
  const reviewerAnnotations = annotations.map(({ label, startSeconds, endSeconds }) => ({
    label,
    startSeconds: Math.max(0, startSeconds - trimStartSeconds),
    endSeconds: endSeconds - trimStartSeconds,
  }));
  const expectedDurationMs = canonicalVideo.encodedDurationMs - Math.round(trimStartSeconds * 1_000);
  if (!Number.isFinite(trimStartSeconds) || trimStartSeconds < 0 || expectedDurationMs <= 0) {
    throw new Error("reviewer video trim boundary is invalid");
  }
  const filters = [
    `trim=start=${trimStartSeconds}`,
    "setpts=PTS-STARTPTS",
    annotationFilter(reviewerAnnotations),
  ].filter(Boolean).join(",");
  await runProcess(ffmpeg, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", canonicalFile,
    "-vf", filters, "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", outputFile,
  ], { label: "reviewer video derivation" });
  const probe = await probeVideo({ file: outputFile, ffprobe, runProcess, label: "reviewer video probe" });
  const videoStreams = probe.streams.filter(({ codec_type: type }) => type === "video");
  const stream = videoStreams[0] ?? {};
  const encodedDurationMs = Math.round(Number(probe.format.duration) * 1_000);
  const durationDriftMs = Math.abs(encodedDurationMs - expectedDurationMs);
  if (probe.streams.length !== 1 || videoStreams.length !== 1 || stream.codec_name !== "h264"
    || stream.width !== canonicalVideo.capture.outputWidth
    || stream.height !== canonicalVideo.capture.outputHeight
    || stream.pix_fmt !== "yuv420p"
    || !Number.isFinite(encodedDurationMs) || encodedDurationMs <= 0
    || !Number.isFinite(durationDriftMs) || durationDriftMs > 1_000) {
    throw new Error("derived reviewer video does not preserve the trimmed H.264 geometry and duration");
  }
  return {
    probe,
    trim: {
      strategy: "first-annotation-start",
      sourceStartSeconds: trimStartSeconds,
      canonicalDurationMs: canonicalVideo.encodedDurationMs,
      expectedDurationMs,
      encodedDurationMs,
      durationDriftMs,
    },
  };
}

async function probeVideo({ file, ffprobe, runProcess, label }) {
  let probe;
  try {
    probe = JSON.parse(await runProcess(ffprobe, [
      "-v", "error", "-count_frames",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames",
      "-of", "json", file,
    ], { label }));
  } catch (error) {
    throw new Error(`${label} did not return valid JSON`, { cause: error });
  }
  if (!probe || typeof probe !== "object" || !Array.isArray(probe.streams)
    || !probe.format || typeof probe.format !== "object") throw new Error(`${label} shape is invalid`);
  return probe;
}

async function inspectCanonicalVideo({ file, video, annotations, ffprobe, runProcess }) {
  const captureRatio = video.captureAttemptCount > 0
    ? video.controllerFrameCount / video.captureAttemptCount
    : 0;
  const terminalBlindIntervalMs = video.measuredDurationMs - video.lastFrameElapsedMs;
  const sourceAspectRatioDrift = Math.abs(
    (video.sourceWidth / video.sourceHeight) - (video.outputWidth / video.outputHeight),
  );
  const timingPassed = video.retainedFrameCount >= MIN_FRAME_EVENT_COUNT
    && video.captureAttemptCount >= video.controllerFrameCount
    && video.retainedFrameCount >= video.controllerFrameCount
    && captureRatio >= MIN_CAPTURE_RATIO
    && video.firstFrameElapsedMs <= MAX_INTER_FRAME_GAP_MS
    && terminalBlindIntervalMs <= MAX_INTER_FRAME_GAP_MS
    && video.maxInterFrameGapMs <= MAX_INTER_FRAME_GAP_MS
    && video.nonMonotonicFrameCount === 0;
  const geometryPassed = video.geometryDiscardedFrameCount
      === video.captureAttemptCount - video.controllerFrameCount
    && video.maxConsecutiveGeometryDiscardCount <= MAX_CONSECUTIVE_GEOMETRY_DISCARDS
    && video.sourceGeometryMismatchCount === 0
    && video.sourceAspectMismatchCount === 0
    && video.viewportSizeMismatchCount === 0
    && video.paddingPixels === 0
    && sourceAspectRatioDrift <= MAX_SOURCE_ASPECT_RATIO_DRIFT
    && (video.normalization !== "none"
      || (video.sourceWidth === video.outputWidth && video.sourceHeight === video.outputHeight));
  if (!timingPassed || !geometryPassed) {
    throw new Error(`canonical video capture contract failed: timing=${timingPassed} geometry=${geometryPassed}`);
  }

  const probe = await probeVideo({ file, ffprobe, runProcess, label: "canonical WebM probe" });
  const videoStreams = probe.streams.filter(({ codec_type: type }) => type === "video");
  const stream = videoStreams[0] ?? {};
  const encodedDurationMs = Math.round(Number(probe.format.duration) * 1_000);
  const decodedFrameCount = Number(stream.nb_read_frames);
  const durationDriftMs = Math.abs(encodedDurationMs - video.measuredDurationMs);
  const formatNames = String(probe.format.format_name ?? "").split(",");
  const mediaPassed = probe.streams.length === 1
    && videoStreams.length === 1
    && ["vp8", "vp9"].includes(stream.codec_name)
    && formatNames.includes("webm")
    && stream.width === video.outputWidth
    && stream.height === video.outputHeight
    && stream.pix_fmt === "yuv420p"
    && Number.isInteger(decodedFrameCount)
    && decodedFrameCount >= video.retainedFrameCount
    && decodedFrameCount <= video.retainedFrameCount + 1
    && Number.isFinite(encodedDurationMs)
    && encodedDurationMs > 0
    && durationDriftMs <= MAX_DURATION_DRIFT_MS;
  if (!mediaPassed) {
    throw new Error(`canonical WebM media contract failed: codec=${stream.codec_name ?? "missing"} format=${probe.format.format_name ?? "missing"} output=${stream.width ?? "missing"}x${stream.height ?? "missing"} frames=${stream.nb_read_frames ?? "missing"} duration=${probe.format.duration ?? "missing"}`);
  }
  if (annotations.some(({ endSeconds }) => endSeconds * 1_000 > encodedDurationMs)) {
    throw new Error("canonical video annotation exceeds the encoded duration");
  }
  return {
    capture: {
      ...video,
      captureRatio,
      terminalBlindIntervalMs,
      sourceAspectRatioDrift,
    },
    probe,
    encodedDurationMs,
    decodedFrameCount,
    durationDriftMs,
    limits: {
      minFrameEventCount: MIN_FRAME_EVENT_COUNT,
      minCaptureRatio: MIN_CAPTURE_RATIO,
      maxInterFrameGapMs: MAX_INTER_FRAME_GAP_MS,
      maxConsecutiveGeometryDiscards: MAX_CONSECUTIVE_GEOMETRY_DISCARDS,
      maxDurationDriftMs: MAX_DURATION_DRIFT_MS,
      maxSourceAspectRatioDrift: MAX_SOURCE_ASPECT_RATIO_DRIFT,
    },
  };
}

async function inspectArtifacts(result, outputDirectory, request) {
  const root = `${await realpath(outputDirectory)}${path.sep}`;
  const inspected = [];
  for (const artifact of result.artifacts) {
    const file = path.join(outputDirectory, artifact.path);
    const resolved = await realpath(file);
    if (!resolved.startsWith(root)) throw new Error(`artifact ${artifact.path} escapes the packet directory`);
    const metadata = await lstat(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact ${artifact.path} is not a bounded regular file`);
    }
    const bytes = await readFile(resolved);
    inspected.push({
      ...artifact,
      bytes: metadata.size,
      sha256: sha256(bytes),
      expiresAt: request.retention.expiresAt,
      headSha: request.headSha,
      baseSha: request.baseSha,
      previewOrigin: request.preview.origin,
      previewImage: request.preview.image,
      runId: request.runId,
      browser: result.browser,
    });
  }
  return inspected;
}

function replayText(request) {
  const operatorInput = request.scenario.entrypointSource === "operator"
    ? ` Also provide the digest-bound operator scenario through ${OPERATOR_ENTRYPOINT_ENVIRONMENT}.`
    : "";
  return `# Replay visual acceptance\n\nCopy the packet's \`request.json\` to a new run input and change only \`outputDirectory\` to a new durable directory. Use the immutable CodeOps acceptance-runner image that created this packet. Provide the credential and tool files as mounted, non-repository inputs.${operatorInput} Then run:\n\n\`\`\`sh\nnode src/visual-acceptance-runner.mjs /run/request.json\n\`\`\`\n\nThe request must still bind repository \`${request.repository}\`, PR #${request.pullRequest}, head \`${request.headSha}\`, base \`${request.baseSha}\`, preview origin \`${request.preview.origin}\`, preview image \`${request.preview.image}\`, ${request.scenario.entrypointSource} scenario entrypoint \`${request.scenario.entrypoint}\`, and catalog \`${request.scenario.catalog}\`. Any identity or digest change requires a new qualification run.\n`;
}

export async function runVisualAcceptance(rawRequest, input = {}) {
  const request = parseVisualAcceptanceRequest(structuredClone(rawRequest));
  const environment = input.environment ?? process.env;
  const runProcess = input.runProcess ?? run;
  for (const name of REQUIRED_ENVIRONMENT) safeEnvironmentFilePath(environment, name);
  const token = (await readBoundedFile(environment.CODEOPS_VALIDATE_GITHUB_TOKEN_FILE, 4_096, "GitHub read credential")).toString("utf8").trim();
  if (token.length < 16 || /\s/.test(token)) throw new Error("GitHub read credential is invalid");
  const attestation = await verifyAttestation(request, environment);
  const fixtureEnvironment = await readFixtureEnvironment(environment);
  const previewHeadersFile = await verifyHeadersFile(environment);
  const ffmpeg = environment.CODEOPS_VALIDATE_FFMPEG_PATH;
  const ffprobe = environment.CODEOPS_VALIDATE_FFPROBE_PATH;
  await Promise.all([access(ffmpeg, constants.X_OK), access(ffprobe, constants.X_OK)]);

  await mkdir(path.dirname(request.outputDirectory), { recursive: true });
  await mkdir(request.outputDirectory, { recursive: false, mode: 0o700 });
  const workspace = await mkdtemp(path.join(os.tmpdir(), `codeops-validate-${request.runId}-`));
  const headRoot = path.join(workspace, "head");
  const baseRoot = path.join(workspace, "base");
  const startedAt = new Date().toISOString();
  let entrypoint;
  let executorRequestPath;
  let scenarioFailure;
  try {
    const materialize = input.materialize ?? materializeOne;
    await materialize({ request, revision: request.headSha, target: headRoot, token, runProcess });
    await materialize({ request, revision: request.baseSha, target: baseRoot, token, runProcess });
    entrypoint = request.scenario.entrypointSource === "candidate"
      ? await verifySourceFile(headRoot, request.scenario.entrypoint, request.scenario.entrypointDigest, "scenario entrypoint")
      : await verifyOperatorEntrypoint(environment, request.scenario.entrypointDigest);
    await verifySourceFile(baseRoot, request.scenario.catalog, request.scenario.catalogDigest, "base scenario catalog");
    const executorRequest = {
      version: "codeops.visual-acceptance-executor-request/v1",
      repository: request.repository,
      pullRequest: request.pullRequest,
      headSha: request.headSha,
      baseSha: request.baseSha,
      preview: request.preview,
      runId: request.runId,
      browser: request.browser,
      caseIds: request.scenario.caseIds,
      scenarioEntrypointSource: request.scenario.entrypointSource,
      headRoot,
      baseRoot,
      outputDirectory: request.outputDirectory,
      resultPath: path.join(request.outputDirectory, "scenario-result.json"),
    };
    executorRequestPath = path.join(workspace, "executor-request.json");
    await writeFile(executorRequestPath, `${canonicalJson(executorRequest)}\n`, { mode: 0o600, flag: "wx" });
    const scenarioEnvironment = {
      PATH: process.env.PATH ?? "",
      HOME: workspace,
      NODE_ENV: "test",
      NO_COLOR: "1",
      CODEOPS_VALIDATE_PREVIEW_HEADERS_FILE: previewHeadersFile,
      ...fixtureEnvironment,
    };
    try {
      await runProcess(process.execPath, [entrypoint, executorRequestPath, "execute"], {
        cwd: headRoot,
        env: scenarioEnvironment,
        label: `${request.scenario.entrypointSource} visual acceptance scenario`,
        discardOutput: true,
      });
    } catch (error) {
      scenarioFailure = error;
    }
    let cleanupFailure;
    try {
      await runProcess(process.execPath, [entrypoint, executorRequestPath, "cleanup"], {
        cwd: headRoot,
        env: scenarioEnvironment,
        label: `${request.scenario.entrypointSource} visual acceptance cleanup`,
        discardOutput: true,
      });
    } catch (error) {
      cleanupFailure = error;
    }
    if (cleanupFailure) throw new Error("repository visual acceptance cleanup failed", { cause: cleanupFailure });
    const cleanup = exactKeys(
      await readJson(path.join(request.outputDirectory, "cleanup-verification.json"), 64_000, "cleanup verification"),
      ["passed", "properties", "opportunities", "customerFiles", "credentials"],
      "cleanup verification",
    );
    if (cleanup.passed !== true || ["properties", "opportunities", "customerFiles", "credentials"]
      .some((field) => cleanup[field] !== 0)) throw new Error("cleanup verification did not prove zero run-owned records and credentials");
    if (scenarioFailure) throw scenarioFailure;
    const resultPath = path.join(request.outputDirectory, "scenario-result.json");
    const result = parseVisualAcceptanceResult(await readJson(resultPath, MAX_RESULT_BYTES, "scenario result"), request);
    if (JSON.stringify(result.cleanup) !== JSON.stringify(cleanup)) {
      throw new Error("scenario cleanup result conflicts with independent cleanup verification");
    }
    const artifacts = await inspectArtifacts(result, request.outputDirectory, request);
    const canonical = artifacts.find(({ role }) => role === "canonical-raw-video");
    const canonicalVideo = await inspectCanonicalVideo({
      file: path.join(request.outputDirectory, canonical.path),
      video: result.video,
      annotations: result.annotations,
      ffprobe,
      runProcess,
    });
    const reviewerPath = "reviewer-annotated.noncanonical.mp4";
    const reviewerFile = path.join(request.outputDirectory, reviewerPath);
    const reviewerVideo = await deriveReviewerVideo({
      canonicalFile: path.join(request.outputDirectory, canonical.path),
      outputFile: reviewerFile,
      annotations: result.annotations,
      canonicalVideo,
      ffmpeg,
      ffprobe,
      runProcess,
    });
    const reviewerMetadata = await lstat(reviewerFile);
    if (!reviewerMetadata.isFile() || reviewerMetadata.isSymbolicLink()
      || reviewerMetadata.size < 1 || reviewerMetadata.size > MAX_ARTIFACT_BYTES) {
      throw new Error("derived reviewer video is not a bounded regular file");
    }
    const reviewer = {
      path: reviewerPath,
      role: "noncanonical-reviewer-video",
      contentType: "video/mp4",
      caseIds: request.scenario.caseIds,
      viewport: "mixed",
      capturedAt: result.completedAt,
      canonical: false,
      annotated: true,
      retentionClass: request.retention.class,
      expiresAt: request.retention.expiresAt,
      bytes: reviewerMetadata.size,
      sha256: sha256(await readFile(reviewerFile)),
      headSha: request.headSha,
      baseSha: request.baseSha,
      previewOrigin: request.preview.origin,
      previewImage: request.preview.image,
      runId: request.runId,
      browser: result.browser,
      probe: reviewerVideo.probe,
      trim: reviewerVideo.trim,
    };
    const validateRequestPath = path.join(request.outputDirectory, "request.json");
    await writeFile(validateRequestPath, `${canonicalJson(request)}\n`, { mode: 0o600, flag: "wx" });
    const validateRequestBytes = await readFile(validateRequestPath);
    const validateRequest = {
      path: "request.json", role: "validate-request", contentType: "application/json",
      caseIds: request.scenario.caseIds, viewport: "not-applicable", capturedAt: result.completedAt,
      canonical: false, annotated: false, retentionClass: request.retention.class,
      expiresAt: request.retention.expiresAt, bytes: validateRequestBytes.byteLength,
      sha256: sha256(validateRequestBytes), headSha: request.headSha, baseSha: request.baseSha,
      previewOrigin: request.preview.origin, previewImage: request.preview.image,
      runId: request.runId, browser: result.browser,
    };
    const replayPath = path.join(request.outputDirectory, "REPLAY.md");
    await writeFile(replayPath, replayText(request), { mode: 0o600, flag: "wx" });
    const replayMetadata = await stat(replayPath);
    const replay = {
      path: "REPLAY.md", role: "replay-instructions", contentType: "text/markdown",
      caseIds: request.scenario.caseIds, viewport: "not-applicable", capturedAt: result.completedAt,
      canonical: false, annotated: false, retentionClass: request.retention.class,
      expiresAt: request.retention.expiresAt, bytes: replayMetadata.size,
      sha256: sha256(await readFile(replayPath)), headSha: request.headSha, baseSha: request.baseSha,
      previewOrigin: request.preview.origin, previewImage: request.preview.image,
      runId: request.runId, browser: result.browser,
    };
    const manifest = {
      version: "codeops.visual-acceptance-manifest/v1",
      status: "qualified",
      identity: {
        repository: request.repository, pullRequest: request.pullRequest,
        headSha: request.headSha, baseSha: request.baseSha,
        previewOrigin: request.preview.origin, previewImage: request.preview.image,
        previewAttestationDigest: attestation.sourceDigest, runId: request.runId,
        validateRequestDigest: validateRequest.sha256,
        scenarioEntrypointSource: request.scenario.entrypointSource,
        scenarioEntrypointDigest: request.scenario.entrypointDigest,
        baseCatalogDigest: request.scenario.catalogDigest,
      },
      startedAt,
      completedAt: new Date().toISOString(),
      browser: result.browser,
      viewports: request.browser.viewports,
      caseIds: request.scenario.caseIds,
      recommendations: request.recommendations,
      retention: request.retention,
      cleanup: result.cleanup,
      video: canonicalVideo,
      artifacts: [...artifacts, reviewer, replay, validateRequest].sort((left, right) => left.path.localeCompare(right.path)),
    };
    const manifestPath = path.join(request.outputDirectory, "manifest.json");
    await writeFile(manifestPath, `${canonicalJson(manifest)}\n`, { mode: 0o600, flag: "wx" });
    const manifestBytes = await readFile(manifestPath);
    await writeFile(path.join(request.outputDirectory, "manifest.sha256"), `${sha256(manifestBytes).slice(7)}  manifest.json\n`, { mode: 0o600, flag: "wx" });
    const qualification = {
      version: "codeops.visual-acceptance-qualification/v1",
      conclusion: "success",
      repository: request.repository,
      pullRequest: request.pullRequest,
      headSha: request.headSha,
      baseSha: request.baseSha,
      previewOrigin: request.preview.origin,
      previewImage: request.preview.image,
      scenarioEntrypointSource: request.scenario.entrypointSource,
      scenarioEntrypointDigest: request.scenario.entrypointDigest,
      baseCatalogDigest: request.scenario.catalogDigest,
      validateRequestDigest: validateRequest.sha256,
      recommendations: request.recommendations,
      runId: request.runId,
      manifestPath: "manifest.json",
      manifestDigest: sha256(manifestBytes),
      completedAt: manifest.completedAt,
    };
    const qualificationPath = path.join(request.outputDirectory, "qualification.json");
    await writeFile(qualificationPath, `${canonicalJson(qualification)}\n`, { mode: 0o600, flag: "wx" });
    const qualificationBytes = await readFile(qualificationPath);
    await writeFile(path.join(request.outputDirectory, "qualification.sha256"), `${sha256(qualificationBytes).slice(7)}  qualification.json\n`, { mode: 0o600, flag: "wx" });
    return {
      manifest,
      manifestPath,
      manifestDigest: sha256(manifestBytes),
      qualification,
      qualificationPath,
      qualificationDigest: sha256(qualificationBytes),
    };
  } catch (error) {
    await rm(request.outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath || !path.isAbsolute(requestPath)) throw new Error("usage: visual-acceptance-runner.mjs /absolute/request.json");
  const result = await runVisualAcceptance(await readJson(requestPath, 256_000, "Validate request"));
  process.stdout.write(`${JSON.stringify({
    status: "qualified",
    manifest: result.manifestPath,
    manifestDigest: result.manifestDigest,
    qualification: result.qualificationPath,
    qualificationDigest: result.qualificationDigest,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
