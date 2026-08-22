import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseVisualAcceptanceRequest,
  parseVisualAcceptanceResult,
} from "../src/visual-acceptance-contract.mjs";
import { runVisualAcceptance } from "../src/visual-acceptance-runner.mjs";

const headSha = "d3b1fa5e0a077aa5bc131b1ed69581043d0b4d5e";
const baseSha = "b342ef7dbb7c747bac80c1bf062675e779df40c9";
const entrypointBytes = Buffer.from("export {};\n");
const catalogBytes = Buffer.from("export const fixtures = 31;\n");
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function request(outputDirectory) {
  return {
    version: "codeops.visual-acceptance-request/v1",
    repository: "anulman/renoconcierge",
    pullRequest: 157,
    headSha,
    baseSha,
    preview: {
      origin: "https://pr-157.preview.renoconcierge.ca",
      image: "sha-d3bfea6",
    },
    runId: "pr157-a80ed388-01",
    scenario: {
      entrypointSource: "candidate",
      entrypoint: "services/acceptance-runner/visual-proof.mjs",
      entrypointDigest: digest(entrypointBytes),
      catalog: "services/acceptance-runner/scenarios/customer-file-routing/catalog.mjs",
      catalogDigest: digest(catalogBytes),
      caseIds: ["anonymous-landing", "resume-dialog"],
    },
    browser: {
      name: "chromium",
      viewports: [
        { name: "desktop", width: 1440, height: 1000 },
        { name: "mobile", width: 390, height: 844 },
      ],
    },
    recommendations: {
      persistentGroups: [{
        id: "resume-agreement-journey",
        title: "Resume agreement journey",
        caseIds: ["anonymous-landing", "resume-dialog"],
        rationale: "Keep the complete agreement-to-resume journey as one durable suite.",
      }],
      scheduledCandidates: [{
        id: "weekly-resume-smoke",
        title: "Weekly resume smoke",
        caseIds: ["resume-dialog"],
        rationale: "Run the highest-value restore path on a bounded weekly cadence.",
        cadence: "weekly",
        runtimeMinutes: 12,
      }],
    },
    retention: { class: "pr-only", expiresAt: "2026-09-20T00:00:00Z" },
    outputDirectory,
  };
}

function caseResult(id, viewport, categories) {
  return {
    id,
    viewport,
    startedAt: "2026-08-20T20:00:00Z",
    completedAt: "2026-08-20T20:00:01Z",
    assertions: categories.map((category) => ({ category, name: `${category} assertion`, passed: true })),
    domCheckpoints: [{ label: "heading", value: "Customer file" }],
    accessibilityCheckpoints: [{ label: "focus", value: "resume-dialog" }],
    network: { requestCount: 3, failedRequestCount: 0, privateResponsesNoStore: true },
    console: { errorCount: 0, warningCount: 0 },
  };
}

function artifact(pathname, role, contentType, extra = {}) {
  return {
    path: pathname,
    role,
    contentType,
    caseIds: ["anonymous-landing", "resume-dialog"],
    viewport: "desktop",
    capturedAt: "2026-08-20T20:00:01Z",
    canonical: role === "canonical-raw-video",
    annotated: false,
    retentionClass: "pr-only",
    ...extra,
  };
}

function result(overrides = {}) {
  return {
    version: "codeops.visual-acceptance-result/v1",
    repository: "anulman/renoconcierge",
    pullRequest: 157,
    headSha,
    baseSha,
    previewOrigin: "https://pr-157.preview.renoconcierge.ca",
    previewImage: "sha-d3bfea6",
    runId: "pr157-a80ed388-01",
    browser: { name: "chromium", version: "140.0.7339.16" },
    startedAt: "2026-08-20T20:00:00Z",
    completedAt: "2026-08-20T20:00:02Z",
    cases: [
      caseResult("anonymous-landing", "desktop", ["success", "privacy", "responsive"]),
      caseResult("resume-dialog", "mobile", ["failure", "accessibility"]),
    ],
    video: {
      clock: "node-monotonic-receipt",
      measuredDurationMs: 2_000,
      firstFrameElapsedMs: 20,
      lastFrameElapsedMs: 1_980,
      retainedFrameCount: 20,
      controllerFrameCount: 20,
      captureAttemptCount: 20,
      geometryDiscardedFrameCount: 0,
      nonMonotonicFrameCount: 0,
      maxInterFrameGapMs: 120,
      maxConsecutiveGeometryDiscardCount: 0,
      sourceGeometryMismatchCount: 0,
      sourceAspectMismatchCount: 0,
      viewportSizeMismatchCount: 0,
      sourceWidth: 1440,
      sourceHeight: 1000,
      outputWidth: 1440,
      outputHeight: 1000,
      normalization: "none",
      paddingPixels: 0,
    },
    artifacts: [
      artifact("raw.webm", "canonical-raw-video", "video/webm"),
      artifact("dom.json", "dom-checkpoints", "application/json"),
      artifact("accessibility.json", "accessibility-checkpoints", "application/json"),
      artifact("network.json", "network-evidence", "application/json"),
      artifact("console.json", "console-evidence", "application/json"),
      artifact("scenario-result.json", "scenario-report", "application/json"),
      artifact("cleanup-verification.json", "cleanup-report", "application/json"),
    ],
    annotations: [
      { label: "Open resume dialog", startSeconds: 0, endSeconds: 1 },
      { label: "Restore focus", startSeconds: 1, endSeconds: 2 },
    ],
    cleanup: { passed: true, properties: 0, opportunities: 0, customerFiles: 0, credentials: 0 },
    ...overrides,
  };
}

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-visual-test-"));
  const outputDirectory = path.join(root, "packet");
  const files = {
    token: path.join(root, "github-token"),
    attestation: path.join(root, "attestation.json"),
    fixture: path.join(root, "fixture.json"),
    headers: path.join(root, "headers.json"),
    tool: path.join(root, "tool"),
  };
  await Promise.all([
    writeFile(files.token, "github-read-token-for-test\n", { mode: 0o600 }),
    writeFile(files.attestation, JSON.stringify({
      version: "codeops.preview-attestation/v1",
      repository: "anulman/renoconcierge",
      pullRequest: 157,
      headSha,
      previewOrigin: "https://pr-157.preview.renoconcierge.ca",
      previewImage: "sha-d3bfea6",
      attestedAt: "2026-08-20T19:59:00Z",
    }), { mode: 0o600 }),
    writeFile(files.fixture, JSON.stringify({ RENO_ROUTING_FIXTURE_AUTH_SECRET: "non-production-test-secret" }), { mode: 0o600 }),
    writeFile(files.headers, JSON.stringify({ "cf-access-client-id": "test-client" }), { mode: 0o600 }),
    writeFile(files.tool, "#!/bin/sh\nexit 0\n", { mode: 0o700 }),
  ]);
  await chmod(files.tool, 0o700);
  return {
    root,
    outputDirectory,
    request: request(outputDirectory),
    environment: {
      CODEOPS_VALIDATE_GITHUB_TOKEN_FILE: files.token,
      CODEOPS_VALIDATE_PREVIEW_ATTESTATION_FILE: files.attestation,
      CODEOPS_VALIDATE_FIXTURE_ENV_FILE: files.fixture,
      CODEOPS_VALIDATE_PREVIEW_HEADERS_FILE: files.headers,
      CODEOPS_VALIDATE_FFMPEG_PATH: files.tool,
      CODEOPS_VALIDATE_FFPROBE_PATH: files.tool,
    },
  };
}

async function fakeMaterialize({ revision, target, request: input }) {
  await mkdir(target);
  const relative = revision === input.headSha ? input.scenario.entrypoint : input.scenario.catalog;
  const bytes = revision === input.headSha ? entrypointBytes : catalogBytes;
  const file = path.join(target, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

async function writeScenarioArtifacts(outputDirectory, scenarioResult = result()) {
  for (const file of ["raw.webm", "dom.json", "accessibility.json", "network.json", "console.json"]) {
    await writeFile(path.join(outputDirectory, file), `${file} evidence\n`);
  }
  await writeFile(path.join(outputDirectory, "scenario-result.json"), JSON.stringify(scenarioResult));
}

function videoProbe(overrides = {}) {
  return JSON.stringify({
    streams: [{
      codec_type: "video",
      codec_name: "vp8",
      width: 1440,
      height: 1000,
      pix_fmt: "yuv420p",
      avg_frame_rate: "10/1",
      nb_read_frames: "20",
      ...(overrides.stream ?? {}),
    }],
    format: { format_name: "matroska,webm", duration: "2.000000", ...(overrides.format ?? {}) },
    ...overrides.root,
  });
}

function reviewerProbe() {
  return JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", width: 1440, height: 1000, pix_fmt: "yuv420p" }],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000" },
  });
}

async function runWithVideoOracle({ video = {}, probe = videoProbe(), annotations } = {}) {
  const state = await harness();
  const scenarioResult = result();
  Object.assign(scenarioResult.video, video);
  if (annotations) scenarioResult.annotations = annotations;
  const runProcess = async (_command, args) => {
    if (args.at(-1) === "execute") {
      await writeScenarioArtifacts(state.outputDirectory, scenarioResult);
      return "";
    }
    if (args.at(-1) === "cleanup") {
      await writeFile(path.join(state.outputDirectory, "cleanup-verification.json"), JSON.stringify(scenarioResult.cleanup));
      return "";
    }
    if (args[0] === "-nostdin") {
      await writeFile(args.at(-1), "derived h264 mp4\n");
      return "";
    }
    if (args[0] === "-v") return args.at(-1).endsWith(".webm") ? probe : reviewerProbe();
    throw new Error(`unexpected process: ${args.join(" ")}`);
  };
  return runVisualAcceptance(state.request, {
    environment: state.environment,
    materialize: fakeMaterialize,
    runProcess,
  });
}

test("validates exact request and result identities and evidence", () => {
  const parsedRequest = parseVisualAcceptanceRequest(request("/tmp/codeops-packet"));
  assert.equal(parseVisualAcceptanceResult(result(), parsedRequest).cleanup.properties, 0);
  assert.throws(
    () => parseVisualAcceptanceResult(result({ previewImage: "sha-0000000" }), parsedRequest),
    /previewImage does not match/,
  );
  assert.throws(
    () => parseVisualAcceptanceResult(result({ previewOrigin: "https://wrong.example" }), parsedRequest),
    /previewOrigin does not match/,
  );
  const unknownRecommendation = request("/tmp/codeops-packet");
  unknownRecommendation.recommendations.persistentGroups[0].caseIds = ["unknown-case"];
  assert.throws(
    () => parseVisualAcceptanceRequest(unknownRecommendation),
    /names an unrequested case/,
  );
  const failed = result();
  failed.cases[0].assertions[0].passed = false;
  assert.throws(() => parseVisualAcceptanceResult(failed, parsedRequest), /failed assertion/);
  const wrongClock = result();
  wrongClock.video.clock = "wall-clock";
  assert.throws(() => parseVisualAcceptanceResult(wrongClock, parsedRequest), /clock must be node-monotonic-receipt/);
});

test("fails closed on sparse, discontinuous, or non-monotonic capture evidence", async (context) => {
  const failures = [
    ["minimum retained frames", { retainedFrameCount: 19, controllerFrameCount: 19 }, /timing=false/],
    ["minimum controller capture ratio", { retainedFrameCount: 20, controllerFrameCount: 15, captureAttemptCount: 20, geometryDiscardedFrameCount: 5 }, /timing=false/],
    ["first-frame coverage", { measuredDurationMs: 5_000, firstFrameElapsedMs: 2_001, lastFrameElapsedMs: 4_980 }, /timing=false/],
    ["terminal-frame coverage", { measuredDurationMs: 5_000, lastFrameElapsedMs: 2_000 }, /timing=false/],
    ["maximum inter-frame gap", { maxInterFrameGapMs: 2_001 }, /timing=false/],
    ["monotonic frame order", { nonMonotonicFrameCount: 1 }, /timing=false/],
  ];
  for (const [name, video, pattern] of failures) {
    await context.test(name, async () => assert.rejects(runWithVideoOracle({ video }), pattern));
  }
});

test("fails closed on geometry, normalization, padding, and discard defects", async (context) => {
  const failures = [
    ["discard accounting", { captureAttemptCount: 21 }, /geometry=false/],
    ["discard streak", { controllerFrameCount: 20, captureAttemptCount: 24, geometryDiscardedFrameCount: 4, maxConsecutiveGeometryDiscardCount: 4 }, /geometry=false/],
    ["source geometry drift", { sourceGeometryMismatchCount: 1 }, /geometry=false/],
    ["source aspect drift", { sourceAspectMismatchCount: 1 }, /geometry=false/],
    ["viewport drift", { viewportSizeMismatchCount: 1 }, /geometry=false/],
    ["grey or letterbox padding", { paddingPixels: 1 }, /geometry=false/],
    ["undeclared normalization", { sourceWidth: 1280, sourceHeight: 889 }, /geometry=false/],
    ["non-proportional normalized source", { sourceWidth: 1280, sourceHeight: 720, normalization: "scale-fill-center-crop" }, /geometry=false/],
  ];
  for (const [name, video, pattern] of failures) {
    await context.test(name, async () => assert.rejects(runWithVideoOracle({ video }), pattern));
  }
});

test("independently rejects malformed or misleading canonical WebM media", async (context) => {
  const failures = [
    ["codec", videoProbe({ stream: { codec_name: "h264" } }), {}],
    ["container", videoProbe({ format: { format_name: "mov,mp4" } }), {}],
    ["dimensions", videoProbe({ stream: { width: 1280 } }), {}],
    ["pixel format", videoProbe({ stream: { pix_fmt: "yuv444p" } }), {}],
    ["decoded frame coverage", videoProbe({ stream: { nb_read_frames: "19" } }), {}],
    ["unexpected duplicated frames", videoProbe({ stream: { nb_read_frames: "22" } }), {}],
    ["duration drift", videoProbe({ format: { duration: "4.501000" } }), {}],
    ["audio stream", videoProbe({ root: { streams: [
      { codec_type: "video", codec_name: "vp8", width: 1440, height: 1000, pix_fmt: "yuv420p", nb_read_frames: "20" },
      { codec_type: "audio", codec_name: "opus" },
    ] } }), {}],
    ["annotation outside encoded duration", videoProbe(), {
      annotations: [{ label: "Too late", startSeconds: 1.9, endSeconds: 2.1 }],
    }],
  ];
  for (const [name, probe, input] of failures) {
    await context.test(name, async () => assert.rejects(
      runWithVideoOracle({ probe, ...input }),
      /media contract failed|annotation exceeds/,
    ));
  }
});

test("creates a bound packet and marks the annotated MP4 non-canonical", async () => {
  const state = await harness();
  const calls = [];
  const runProcess = async (_command, args, options) => {
    calls.push({ args, options });
    if (args.at(-1) === "execute") {
      await writeScenarioArtifacts(state.outputDirectory);
      return "";
    }
    if (args.at(-1) === "cleanup") {
      await writeFile(path.join(state.outputDirectory, "cleanup-verification.json"), JSON.stringify(result().cleanup));
      return "";
    }
    if (args[0] === "-nostdin") {
      await writeFile(args.at(-1), "derived h264 mp4\n");
      return "";
    }
    if (args[0] === "-v") return args.at(-1).endsWith(".webm") ? videoProbe() : reviewerProbe();
    throw new Error(`unexpected process: ${args.join(" ")}`);
  };
  const proof = await runVisualAcceptance(state.request, {
    environment: state.environment,
    materialize: fakeMaterialize,
    runProcess,
  });
  assert.equal(proof.manifest.status, "qualified");
  assert.equal(proof.manifest.identity.headSha, headSha);
  assert.equal(proof.manifest.cleanup.credentials, 0);
  assert.equal(proof.manifest.video.durationDriftMs, 0);
  assert.equal(proof.manifest.video.capture.captureRatio, 1);
  assert.equal(proof.manifest.video.probe.streams[0].codec_name, "vp8");
  assert.deepEqual(proof.manifest.recommendations, state.request.recommendations);
  assert.equal(proof.qualification.headSha, headSha);
  assert.equal(proof.qualification.previewOrigin, state.request.preview.origin);
  assert.deepEqual(proof.qualification.recommendations, state.request.recommendations);
  assert.equal(proof.qualification.manifestDigest, proof.manifestDigest);
  assert.equal(proof.qualification.validateRequestDigest, proof.manifest.identity.validateRequestDigest);
  const reviewer = proof.manifest.artifacts.find(({ role }) => role === "noncanonical-reviewer-video");
  assert.deepEqual({ canonical: reviewer.canonical, annotated: reviewer.annotated, contentType: reviewer.contentType }, {
    canonical: false,
    annotated: true,
    contentType: "video/mp4",
  });
  assert.equal(proof.manifest.artifacts.find(({ role }) => role === "canonical-raw-video").contentType, "video/webm");
  for (const evidence of proof.manifest.artifacts) {
    assert.equal(Number.isInteger(evidence.bytes) && evidence.bytes > 0, true);
    assert.match(evidence.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(evidence.previewOrigin, state.request.preview.origin);
  }
  assert.match(await readFile(path.join(state.outputDirectory, "manifest.sha256"), "utf8"), /^[0-9a-f]{64}  manifest\.json\n$/);
  assert.match(await readFile(path.join(state.outputDirectory, "qualification.sha256"), "utf8"), /^[0-9a-f]{64}  qualification\.json\n$/);
  assert.deepEqual(JSON.parse(await readFile(path.join(state.outputDirectory, "request.json"), "utf8")), state.request);
  assert.equal(JSON.stringify(proof).includes("non-production-test-secret"), false);
  assert.equal(calls.filter(({ args }) => args.at(-1) === "cleanup").length, 1);
  assert.equal((await stat(proof.manifestPath)).isFile(), true);
});

test("runs a digest-bound operator scenario without changing candidate bytes", async () => {
  const state = await harness();
  const operatorEntrypoint = path.join(state.root, "operator-visual-proof.mjs");
  await writeFile(operatorEntrypoint, entrypointBytes, { mode: 0o500 });
  state.environment.CODEOPS_VALIDATE_SCENARIO_ENTRYPOINT_FILE = operatorEntrypoint;
  state.request.scenario.entrypointSource = "operator";
  const runProcess = async (_command, args) => {
    if (args.at(-1) === "execute") {
      await writeScenarioArtifacts(state.outputDirectory);
      return "";
    }
    if (args.at(-1) === "cleanup") {
      await writeFile(path.join(state.outputDirectory, "cleanup-verification.json"), JSON.stringify(result().cleanup));
      return "";
    }
    if (args[0] === "-nostdin") {
      await writeFile(args.at(-1), "derived h264 mp4\n");
      return "";
    }
    if (args[0] === "-v") return args.at(-1).endsWith(".webm") ? videoProbe() : reviewerProbe();
    throw new Error(`unexpected process: ${args.join(" ")}`);
  };
  const proof = await runVisualAcceptance(state.request, {
    environment: state.environment,
    materialize: fakeMaterialize,
    runProcess,
  });
  assert.equal(proof.manifest.identity.scenarioEntrypointSource, "operator");
  assert.equal(proof.qualification.scenarioEntrypointSource, "operator");
});

test("runs cleanup after scenario failure and removes the incomplete packet", async () => {
  const state = await harness();
  let cleanupCalls = 0;
  const runProcess = async (_command, args) => {
    if (args.at(-1) === "execute") throw new Error("scenario failed without secret output");
    if (args.at(-1) === "cleanup") {
      cleanupCalls += 1;
      await writeFile(path.join(state.outputDirectory, "cleanup-verification.json"), JSON.stringify(result().cleanup));
      return "";
    }
    throw new Error("unexpected process");
  };
  await assert.rejects(
    runVisualAcceptance(state.request, { environment: state.environment, materialize: fakeMaterialize, runProcess }),
    /scenario failed/,
  );
  assert.equal(cleanupCalls, 1);
  await assert.rejects(stat(state.outputDirectory), { code: "ENOENT" });
});
