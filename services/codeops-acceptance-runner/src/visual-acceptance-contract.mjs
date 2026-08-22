import path from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DNS_TOKEN = /^[a-z0-9](?:[-a-z0-9]{0,46}[a-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const CASE_ID = /^[a-z][a-z0-9-]{0,79}$/;
const CADENCE = /^(daily|weekly)$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const ASSERTION_CATEGORIES = Object.freeze([
  "success",
  "failure",
  "privacy",
  "accessibility",
  "responsive",
]);
const CAPTURE_CLOCK = "node-monotonic-receipt";
const VIDEO_NORMALIZATIONS = new Set(["none", "scale-fill-center-crop"]);
const ARTIFACT_ROLES = new Set([
  "canonical-raw-video",
  "screenshot",
  "dom-checkpoints",
  "accessibility-checkpoints",
  "network-evidence",
  "console-evidence",
  "scenario-report",
  "cleanup-report",
]);

function fail(message) {
  throw new Error(`visual acceptance contract is invalid: ${message}`);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} fields must match exactly`);
  return value;
}

function string(value, pattern, label, maximum = 2_048) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function isoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail(`${label} must be a UTC ISO timestamp`);
  return value;
}

function httpsOrigin(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${label} must be an HTTPS origin`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || parsed.port) fail(`${label} must be an exact credential-free HTTPS origin`);
  return parsed.origin;
}

function safeRelativePath(value, label) {
  string(value, SAFE_PATH, label, 240);
  if (path.posix.normalize(value) !== value || value.startsWith(".")) fail(`${label} is not canonical`);
  return value;
}

function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} values must be unique`);
}

function finiteNumber(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail(`${label} is invalid`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} is invalid`);
  return value;
}

function videoDimension(value, label) {
  if (!Number.isInteger(value) || value < 240 || value > 4_096) fail(`${label} is invalid`);
  return value;
}

function parseVideoEvidence(raw) {
  const video = exactObject(raw, [
    "clock", "measuredDurationMs", "firstFrameElapsedMs", "lastFrameElapsedMs",
    "retainedFrameCount", "controllerFrameCount", "captureAttemptCount", "geometryDiscardedFrameCount",
    "nonMonotonicFrameCount", "maxInterFrameGapMs", "maxConsecutiveGeometryDiscardCount",
    "sourceGeometryMismatchCount", "sourceAspectMismatchCount", "viewportSizeMismatchCount",
    "sourceWidth", "sourceHeight", "outputWidth", "outputHeight", "normalization", "paddingPixels",
  ], "video evidence");
  if (video.clock !== CAPTURE_CLOCK) fail(`video evidence clock must be ${CAPTURE_CLOCK}`);
  finiteNumber(video.measuredDurationMs, 1, 3_600_000, "video evidence measuredDurationMs");
  finiteNumber(video.firstFrameElapsedMs, 0, video.measuredDurationMs, "video evidence firstFrameElapsedMs");
  finiteNumber(video.lastFrameElapsedMs, video.firstFrameElapsedMs, video.measuredDurationMs, "video evidence lastFrameElapsedMs");
  for (const field of [
    "retainedFrameCount", "controllerFrameCount", "captureAttemptCount", "geometryDiscardedFrameCount",
    "nonMonotonicFrameCount", "maxConsecutiveGeometryDiscardCount", "sourceGeometryMismatchCount",
    "sourceAspectMismatchCount", "viewportSizeMismatchCount", "paddingPixels",
  ]) nonNegativeInteger(video[field], `video evidence ${field}`);
  finiteNumber(video.maxInterFrameGapMs, 0, 3_600_000, "video evidence maxInterFrameGapMs");
  for (const field of ["sourceWidth", "sourceHeight", "outputWidth", "outputHeight"]) {
    videoDimension(video[field], `video evidence ${field}`);
  }
  if (!VIDEO_NORMALIZATIONS.has(video.normalization)) fail("video evidence normalization is invalid");
  return video;
}

export function parseVisualAcceptanceRequest(raw) {
  const request = exactObject(raw, [
    "version", "repository", "pullRequest", "headSha", "baseSha", "preview",
    "runId", "scenario", "browser", "recommendations", "retention", "outputDirectory",
  ], "request");
  if (request.version !== "codeops.visual-acceptance-request/v1") fail("request version is unsupported");
  string(request.repository, REPOSITORY, "repository", 201);
  if (!Number.isInteger(request.pullRequest) || request.pullRequest < 1 || request.pullRequest > 1_000_000) fail("pullRequest is invalid");
  string(request.headSha, SHA, "headSha", 40);
  string(request.baseSha, SHA, "baseSha", 40);
  if (request.headSha === request.baseSha) fail("headSha and baseSha must differ");
  string(request.runId, DNS_TOKEN, "runId", 48);
  if (typeof request.outputDirectory !== "string" || !path.isAbsolute(request.outputDirectory)
    || path.normalize(request.outputDirectory) !== request.outputDirectory || request.outputDirectory === path.parse(request.outputDirectory).root) {
    fail("outputDirectory must be one normalized absolute non-root path");
  }

  const preview = exactObject(request.preview, ["origin", "image"], "preview");
  preview.origin = httpsOrigin(preview.origin, "preview.origin");
  string(preview.image, /^sha-[0-9a-f]{7,40}$/, "preview.image", 44);

  const scenario = exactObject(request.scenario, [
    "entrypointSource", "entrypoint", "entrypointDigest", "catalog", "catalogDigest", "caseIds",
  ], "scenario");
  if (!["candidate", "operator"].includes(scenario.entrypointSource)) fail("scenario.entrypointSource is invalid");
  safeRelativePath(scenario.entrypoint, "scenario.entrypoint");
  string(scenario.entrypointDigest, SHA256, "scenario.entrypointDigest", 71);
  safeRelativePath(scenario.catalog, "scenario.catalog");
  string(scenario.catalogDigest, SHA256, "scenario.catalogDigest", 71);
  if (!Array.isArray(scenario.caseIds) || scenario.caseIds.length < 1 || scenario.caseIds.length > 100) fail("scenario.caseIds is invalid");
  scenario.caseIds.forEach((id) => string(id, CASE_ID, "scenario case ID", 80));
  unique(scenario.caseIds, "scenario case ID");

  const browser = exactObject(request.browser, ["name", "viewports"], "browser");
  if (browser.name !== "chromium") fail("browser.name must be chromium");
  if (!Array.isArray(browser.viewports) || browser.viewports.length < 2 || browser.viewports.length > 8) fail("browser.viewports is invalid");
  browser.viewports.forEach((viewport, index) => {
    exactObject(viewport, ["name", "width", "height"], `browser viewport ${index}`);
    string(viewport.name, CASE_ID, "viewport name", 80);
    for (const dimension of ["width", "height"]) {
      if (!Number.isInteger(viewport[dimension]) || viewport[dimension] < 240 || viewport[dimension] > 4_096) fail(`viewport ${dimension} is invalid`);
    }
  });
  unique(browser.viewports.map(({ name }) => name), "viewport name");

  const recommendations = exactObject(request.recommendations, [
    "persistentGroups", "scheduledCandidates",
  ], "recommendations");
  if (!Array.isArray(recommendations.persistentGroups) || recommendations.persistentGroups.length > 16) {
    fail("recommendations.persistentGroups is invalid");
  }
  if (!Array.isArray(recommendations.scheduledCandidates) || recommendations.scheduledCandidates.length > 16) {
    fail("recommendations.scheduledCandidates is invalid");
  }
  for (const [index, item] of recommendations.persistentGroups.entries()) {
    exactObject(item, ["id", "title", "caseIds", "rationale"], `persistent recommendation ${index}`);
    string(item.id, CASE_ID, `persistent recommendation ${index} ID`, 80);
    string(item.title, /^(?!\s)[^\u0000-\u001f\u007f]{1,160}$/, `persistent recommendation ${index} title`, 160);
    string(item.rationale, /^(?!\s)[^\u0000-\u001f\u007f]{1,500}$/, `persistent recommendation ${index} rationale`, 500);
    if (!Array.isArray(item.caseIds) || item.caseIds.length < 1) fail(`persistent recommendation ${index} caseIds is invalid`);
    item.caseIds.forEach((id) => string(id, CASE_ID, `persistent recommendation ${index} case ID`, 80));
    unique(item.caseIds, `persistent recommendation ${index} case ID`);
    if (item.caseIds.some((id) => !scenario.caseIds.includes(id))) fail(`persistent recommendation ${index} names an unrequested case`);
  }
  for (const [index, item] of recommendations.scheduledCandidates.entries()) {
    exactObject(item, ["id", "title", "caseIds", "rationale", "cadence", "runtimeMinutes"], `scheduled recommendation ${index}`);
    string(item.id, CASE_ID, `scheduled recommendation ${index} ID`, 80);
    string(item.title, /^(?!\s)[^\u0000-\u001f\u007f]{1,160}$/, `scheduled recommendation ${index} title`, 160);
    string(item.rationale, /^(?!\s)[^\u0000-\u001f\u007f]{1,500}$/, `scheduled recommendation ${index} rationale`, 500);
    if (!Array.isArray(item.caseIds) || item.caseIds.length < 1) fail(`scheduled recommendation ${index} caseIds is invalid`);
    item.caseIds.forEach((id) => string(id, CASE_ID, `scheduled recommendation ${index} case ID`, 80));
    unique(item.caseIds, `scheduled recommendation ${index} case ID`);
    if (item.caseIds.some((id) => !scenario.caseIds.includes(id))) fail(`scheduled recommendation ${index} names an unrequested case`);
    string(item.cadence, CADENCE, `scheduled recommendation ${index} cadence`, 6);
    if (!Number.isInteger(item.runtimeMinutes) || item.runtimeMinutes < 1 || item.runtimeMinutes > 1_440) {
      fail(`scheduled recommendation ${index} runtimeMinutes is invalid`);
    }
  }
  unique(recommendations.persistentGroups.map(({ id }) => id), "persistent recommendation ID");
  unique(recommendations.scheduledCandidates.map(({ id }) => id), "scheduled recommendation ID");
  unique([
    ...recommendations.persistentGroups.map(({ id }) => id),
    ...recommendations.scheduledCandidates.map(({ id }) => id),
  ], "recommendation ID");

  const retention = exactObject(request.retention, ["class", "expiresAt"], "retention");
  if (retention.class !== "pr-only") fail("retention.class must be pr-only");
  isoDate(retention.expiresAt, "retention.expiresAt");
  return request;
}

function parseEvidenceArtifact(artifact, index) {
  exactObject(artifact, [
    "path", "role", "contentType", "caseIds", "viewport", "capturedAt",
    "canonical", "annotated", "retentionClass",
  ], `artifact ${index}`);
  safeRelativePath(artifact.path, `artifact ${index} path`);
  if (!ARTIFACT_ROLES.has(artifact.role)) fail(`artifact ${index} role is invalid`);
  string(artifact.contentType, CONTENT_TYPE, `artifact ${index} contentType`, 128);
  if (!Array.isArray(artifact.caseIds) || artifact.caseIds.length < 1) fail(`artifact ${index} caseIds is invalid`);
  artifact.caseIds.forEach((id) => string(id, CASE_ID, `artifact ${index} case ID`, 80));
  string(artifact.viewport, CASE_ID, `artifact ${index} viewport`, 80);
  isoDate(artifact.capturedAt, `artifact ${index} capturedAt`);
  if (typeof artifact.canonical !== "boolean" || typeof artifact.annotated !== "boolean") fail(`artifact ${index} media flags are invalid`);
  if (artifact.retentionClass !== "pr-only") fail(`artifact ${index} retention class is invalid`);
  if (artifact.role === "canonical-raw-video"
    && (artifact.contentType !== "video/webm" || !artifact.path.endsWith(".webm") || !artifact.canonical || artifact.annotated)) {
    fail(`artifact ${index} canonical raw video flags are invalid`);
  }
  if (artifact.role !== "canonical-raw-video" && artifact.canonical) fail(`artifact ${index} must not claim canonical media`);
  return artifact;
}

export function parseVisualAcceptanceResult(raw, request) {
  const result = exactObject(raw, [
    "version", "repository", "pullRequest", "headSha", "baseSha", "previewOrigin", "previewImage",
    "runId", "browser", "startedAt", "completedAt", "cases", "artifacts",
    "video", "annotations", "cleanup",
  ], "result");
  if (result.version !== "codeops.visual-acceptance-result/v1") fail("result version is unsupported");
  for (const field of ["repository", "pullRequest", "headSha", "baseSha", "runId"]) {
    if (result[field] !== request[field]) fail(`result ${field} does not match the request`);
  }
  if (result.previewOrigin !== request.preview.origin) fail("result previewOrigin does not match the request");
  if (result.previewImage !== request.preview.image) fail("result previewImage does not match the request");
  isoDate(result.startedAt, "result.startedAt");
  isoDate(result.completedAt, "result.completedAt");
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) fail("result timestamps are reversed");
  exactObject(result.browser, ["name", "version"], "result.browser");
  if (result.browser.name !== request.browser.name) fail("result browser name does not match the request");
  string(result.browser.version, /^[0-9]+(?:\.[0-9]+){1,3}$/, "result browser version", 40);
  result.video = parseVideoEvidence(result.video);

  if (!Array.isArray(result.cases) || result.cases.length !== request.scenario.caseIds.length) fail("result cases do not match the request");
  for (const [index, item] of result.cases.entries()) {
    exactObject(item, [
      "id", "viewport", "startedAt", "completedAt", "assertions", "domCheckpoints",
      "accessibilityCheckpoints", "network", "console",
    ], `case ${index}`);
    string(item.id, CASE_ID, `case ${index} ID`, 80);
    string(item.viewport, CASE_ID, `case ${index} viewport`, 80);
    if (!request.browser.viewports.some(({ name }) => name === item.viewport)) fail(`case ${item.id} viewport was not requested`);
    isoDate(item.startedAt, `case ${item.id} startedAt`);
    isoDate(item.completedAt, `case ${item.id} completedAt`);
    if (!Array.isArray(item.assertions) || item.assertions.length < 1) fail(`case ${item.id} has no assertions`);
    for (const assertion of item.assertions) {
      exactObject(assertion, ["category", "name", "passed"], `case ${item.id} assertion`);
      if (!ASSERTION_CATEGORIES.includes(assertion.category)) fail(`case ${item.id} assertion category is invalid`);
      string(assertion.name, /^(?!\s)[^\u0000-\u001f\u007f]{1,240}$/, `case ${item.id} assertion name`, 240);
      if (assertion.passed !== true) fail(`case ${item.id} contains a failed assertion`);
    }
    if (!Array.isArray(item.domCheckpoints) || item.domCheckpoints.length < 1) fail(`case ${item.id} has no DOM checkpoints`);
    if (!Array.isArray(item.accessibilityCheckpoints) || item.accessibilityCheckpoints.length < 1) fail(`case ${item.id} has no accessibility checkpoints`);
    exactObject(item.network, ["requestCount", "failedRequestCount", "privateResponsesNoStore"], `case ${item.id} network`);
    if (!Number.isInteger(item.network.requestCount) || item.network.requestCount < 1
      || !Number.isInteger(item.network.failedRequestCount) || item.network.failedRequestCount < 0
      || item.network.privateResponsesNoStore !== true) fail(`case ${item.id} network evidence is invalid`);
    exactObject(item.console, ["errorCount", "warningCount"], `case ${item.id} console`);
    if (item.console.errorCount !== 0 || !Number.isInteger(item.console.warningCount) || item.console.warningCount < 0) fail(`case ${item.id} console evidence is invalid`);
  }
  unique(result.cases.map(({ id }) => id), "result case ID");
  if (JSON.stringify([...result.cases.map(({ id }) => id)].sort()) !== JSON.stringify([...request.scenario.caseIds].sort())) fail("result case IDs do not match the request");
  const categories = new Set(result.cases.flatMap(({ assertions }) => assertions.map(({ category }) => category)));
  for (const required of ASSERTION_CATEGORIES) if (!categories.has(required)) fail(`result omits ${required} assertions`);

  if (!Array.isArray(result.artifacts) || result.artifacts.length < 7 || result.artifacts.length > 500) fail("result artifacts are invalid");
  result.artifacts.forEach(parseEvidenceArtifact);
  unique(result.artifacts.map(({ path: artifactPath }) => artifactPath), "artifact path");
  if (result.artifacts.filter(({ role }) => role === "canonical-raw-video").length !== 1) fail("result must contain one canonical raw WebM");
  for (const role of ["dom-checkpoints", "accessibility-checkpoints", "network-evidence", "console-evidence", "scenario-report", "cleanup-report"]) {
    if (!result.artifacts.some((artifact) => artifact.role === role)) fail(`result omits ${role}`);
  }

  if (!Array.isArray(result.annotations) || result.annotations.length < 1 || result.annotations.length > 100) fail("result annotations are invalid");
  for (const [index, annotation] of result.annotations.entries()) {
    exactObject(annotation, ["label", "startSeconds", "endSeconds"], `annotation ${index}`);
    string(annotation.label, /^[A-Za-z0-9][A-Za-z0-9 ,.:'()/-]{0,79}$/, `annotation ${index} label`, 80);
    if (!Number.isFinite(annotation.startSeconds) || annotation.startSeconds < 0
      || !Number.isFinite(annotation.endSeconds) || annotation.endSeconds <= annotation.startSeconds
      || annotation.endSeconds > 3_600) fail(`annotation ${index} interval is invalid`);
  }

  exactObject(result.cleanup, ["passed", "properties", "opportunities", "customerFiles", "credentials"], "cleanup");
  if (result.cleanup.passed !== true || ["properties", "opportunities", "customerFiles", "credentials"]
    .some((field) => result.cleanup[field] !== 0)) fail("cleanup did not prove zero run-owned records and credentials");
  return result;
}

export const visualAcceptanceAssertionCategories = ASSERTION_CATEGORIES;
