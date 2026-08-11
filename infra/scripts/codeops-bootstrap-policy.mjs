const GIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_SOURCE_GATES = [
  "codeopsCi",
  "prGuardrails",
  "acceptanceRunnerGuardrails",
];
const MAX_BOOTSTRAP_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export function bootstrapNamespace(candidateSha) {
  if (!GIT_SHA.test(candidateSha)) {
    throw new Error("candidate SHA must be a lowercase 40-character Git SHA");
  }
  return `codeops-bootstrap-${candidateSha.slice(0, 12)}`;
}

export function evaluateBootstrapDeployPlan(plan, { now = new Date() } = {}) {
  const reasons = [];
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;

  if (!GIT_SHA.test(plan?.candidateSha ?? "")) {
    reasons.push("candidate SHA must be a lowercase 40-character Git SHA");
  }

  let expectedNamespace = null;
  if (GIT_SHA.test(plan?.candidateSha ?? "")) {
    expectedNamespace = bootstrapNamespace(plan.candidateSha);
    if (plan.namespace !== expectedNamespace) {
      reasons.push(`namespace must be ${expectedNamespace}`);
    }
  }

  if (plan?.targetEnvironment !== "codeops-bootstrap") {
    reasons.push("target environment must be codeops-bootstrap");
  }
  if (plan?.deployAuthority !== "trusted-external-supervisor") {
    reasons.push("deploy authority must be the trusted external supervisor");
  }
  if (plan?.candidateHasDeployCredential !== false) {
    reasons.push("candidate must not receive a deploy credential");
  }
  if (plan?.mutatesSharedDev !== false) {
    reasons.push("bootstrap plan must exclude shared dev");
  }
  if (plan?.mutatesProduction !== false) {
    reasons.push("bootstrap plan must exclude production");
  }
  if (plan?.acceptanceVerdictWriter !== "independent-acceptance") {
    reasons.push("acceptance verdict must be written by the independent acceptance identity");
  }
  if (plan?.maxConcurrentRuns !== 1) {
    reasons.push("bootstrap concurrency must be exactly one");
  }
  if (plan?.cleanupRequired !== true) {
    reasons.push("bootstrap cleanup must be required");
  }

  for (const gate of REQUIRED_SOURCE_GATES) {
    if (plan?.sourceGates?.[gate] !== "success") {
      reasons.push(`source gate ${gate} must be success`);
    }
  }

  const imageDigests = plan?.imageDigests;
  if (
    !imageDigests ||
    typeof imageDigests !== "object" ||
    Array.isArray(imageDigests) ||
    Object.keys(imageDigests).length === 0
  ) {
    reasons.push("at least one immutable image digest is required");
  } else {
    for (const [name, digest] of Object.entries(imageDigests)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name) || !IMAGE_DIGEST.test(digest)) {
        reasons.push(`invalid immutable image digest for ${name}`);
      }
    }
  }

  const expiresAtMs = Date.parse(plan?.expiresAt ?? "");
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresAtMs)) {
    reasons.push("bootstrap expiry and current time must be valid");
  } else if (expiresAtMs <= nowMs) {
    reasons.push("bootstrap expiry must be in the future");
  } else if (expiresAtMs - nowMs > MAX_BOOTSTRAP_LIFETIME_MS) {
    reasons.push("bootstrap expiry must be within 24 hours");
  }

  return {
    ok: reasons.length === 0,
    candidateSha: GIT_SHA.test(plan?.candidateSha ?? "") ? plan.candidateSha : null,
    namespace: plan?.namespace ?? null,
    expectedNamespace,
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
    reasons,
  };
}
