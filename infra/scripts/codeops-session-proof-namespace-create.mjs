import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bindSessionProofNamespace } from "./codeops-session-proof-admission.mjs";
import {
  readSessionProofNamespace,
  runSessionProofPreflight,
} from "./codeops-session-proof-preflight.mjs";

const MAX_OUTPUT_BYTES = 1024 * 1024;

function parsePlan(source) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("proof plan must be valid JSON");
  }
}

export function createSessionProofNamespace(input, runner = execFileSync) {
  const plan = parsePlan(input.planSource);
  const artifact = plan.artifacts?.find((value) => value.id === "namespace");
  const manifestSha256 = createHash("sha256")
    .update(input.namespaceManifestSource ?? "")
    .digest("hex");
  if (!artifact || artifact.sha256 !== manifestSha256) {
    throw new Error("reviewed proof namespace manifest digest drifted");
  }

  const preflight = runSessionProofPreflight(input, runner);
  let createSucceeded = true;
  try {
    runner(
      "kubectl",
      ["create", "--filename", "-", "--request-timeout=30s"],
      {
        encoding: "utf8",
        input: input.namespaceManifestSource,
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: 45_000,
      },
    );
  } catch {
    createSucceeded = false;
  }
  const namespaceResource = readSessionProofNamespace(
    input.admission.identity.namespace,
    runner,
  );
  if (namespaceResource === null) {
    throw new Error(
      createSucceeded
        ? "created proof Namespace could not be read back"
        : "proof namespace package creation failed before Namespace identity existed",
    );
  }
  const admission = bindSessionProofNamespace(input.admission, {
    namespaceResource,
    operator: preflight.operator,
    target: preflight.target,
    observedAt: input.observedAt,
  });
  return {
    apiVersion: "codeops.example/session-proof-namespace-create/v1",
    result: createSucceeded
      ? "created-and-uid-bound"
      : "namespace-uid-bound-create-incomplete",
    checkedAt: input.observedAt,
    planSha256: input.admission.planSha256,
    namespaceManifestSha256: manifestSha256,
    namespace: {
      name: input.admission.identity.namespace,
      uid: admission.namespaceUid,
    },
    proceed: createSucceeded,
    admission,
  };
}
