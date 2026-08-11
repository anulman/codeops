import { createHash } from "node:crypto";
import { basename } from "node:path";
import { parseAllDocuments } from "yaml";

const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/;
const FORBIDDEN_KINDS = new Set([
  "Secret",
  "Ingress",
  "Role",
  "RoleBinding",
  "ClusterRole",
  "ClusterRoleBinding",
]);

function expectedArtifacts(input) {
  return [
    {
      id: "namespace",
      namespaceMode: "mixed",
      identities: [
        `Namespace/${input.namespace}`,
        "LimitRange/codeops-session-proof",
        "ResourceQuota/codeops-session-proof",
        "NetworkPolicy/default-deny",
      ],
    },
    {
      id: "database",
      namespaceMode: "targeted",
      identities: [
        "ServiceAccount/codeops-session-proof-database",
        "ConfigMap/codeops-session-proof-database-init",
        "Deployment/codeops-session-proof-database",
        "Service/codeops-session-proof-database",
        "NetworkPolicy/codeops-session-proof-database",
      ],
    },
    {
      id: "gateway",
      namespaceMode: "targeted",
      identities: [
        "ServiceAccount/codeops-control-gateway",
        "Deployment/codeops-control-gateway",
        "Service/codeops-control-gateway",
        "NetworkPolicy/codeops-control-gateway",
      ],
    },
    {
      id: "grants",
      namespaceMode: "targeted",
      identities: [
        "ServiceAccount/codeops-session-proof-grants",
        "ConfigMap/codeops-session-proof-grants",
        "Job/codeops-session-proof-grants",
        "NetworkPolicy/codeops-session-proof-grants",
      ],
    },
    {
      id: "codex-login",
      namespaceMode: "explicit",
      identities: [
        "PersistentVolumeClaim/codeops-codex-auth",
        "ServiceAccount/codeops-codex-auth",
        "Job/codeops-codex-auth-login",
        "NetworkPolicy/codeops-codex-auth",
      ],
    },
    {
      id: "codex-smoke",
      namespaceMode: "explicit",
      identities: [
        "PersistentVolumeClaim/codeops-codex-auth",
        "ServiceAccount/codeops-codex-auth",
        "Job/codeops-codex-auth-smoke",
        "NetworkPolicy/codeops-codex-auth",
      ],
    },
    {
      id: "ui",
      namespaceMode: "explicit",
      identities: [
        "ServiceAccount/codeops-agents-ui",
        "Deployment/codeops-agents-ui",
        "Service/codeops-agents-ui",
        "NetworkPolicy/codeops-agents-ui",
      ],
    },
    {
      id: "runtime",
      namespaceMode: "targeted",
      identities: [
        `ServiceAccount/codeops-session-runtime-${input.sessionSuffix}`,
        `Job/codeops-session-runtime-${input.sessionSuffix}`,
        `NetworkPolicy/codeops-session-runtime-${input.sessionSuffix}`,
      ],
    },
  ];
}

function inspectArtifact(expected, source, input) {
  const resources = parseAllDocuments(source)
    .filter((document) => document.contents !== null)
    .map((document) => document.toJS());
  if (resources.length === 0) throw new Error(`${expected.id} manifest is empty`);
  const identities = resources.map(
    (resource) => `${resource.kind}/${resource.metadata?.name ?? ""}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${expected.id} manifest contains duplicate resources`);
  }
  if (
    JSON.stringify([...identities].sort()) !==
    JSON.stringify([...expected.identities].sort())
  ) {
    throw new Error(`${expected.id} manifest resource set drifted`);
  }
  if (resources.some((resource) => FORBIDDEN_KINDS.has(resource.kind))) {
    throw new Error(`${expected.id} manifest gained forbidden authority or exposure`);
  }

  for (const resource of resources) {
    const namespace = resource.metadata?.namespace;
    if (expected.namespaceMode === "explicit" && namespace !== input.namespace) {
      throw new Error(`${expected.id} manifest must bind every resource to the proof namespace`);
    }
    if (expected.namespaceMode === "targeted" && namespace !== undefined) {
      throw new Error(`${expected.id} manifest must be applied only through the exact namespace target`);
    }
    if (expected.namespaceMode === "mixed") {
      if (resource.kind === "Namespace" && namespace !== undefined) {
        throw new Error("proof Namespace cannot itself be namespaced");
      }
      if (resource.kind !== "Namespace" && namespace !== input.namespace) {
        throw new Error("proof namespace boundary resources must be explicitly namespaced");
      }
    }
  }

  if (expected.id === "namespace") {
    const namespace = resources.find((resource) => resource.kind === "Namespace");
    if (
      namespace.metadata.labels?.["app.kubernetes.io/part-of"] !==
        "codeops-session-proof" ||
      namespace.metadata.labels?.["codeops.example/proof-run"] !==
        input.runId ||
      namespace.metadata.labels?.["codeops.example/base-sha"] !==
        input.baseSha
    ) {
      throw new Error("proof namespace identity labels drifted");
    }
  }

  return {
    id: expected.id,
    file: basename(input.files[expected.id].path),
    sha256: createHash("sha256").update(source).digest("hex"),
    namespaceMode: expected.namespaceMode,
    targetNamespace: input.namespace,
    resources: identities,
  };
}

export function sessionProofSequence() {
  return [
    { id: "review-namespace", action: "review", artifact: "namespace" },
    { id: "create-namespace", action: "operator-apply", artifact: "namespace" },
    { id: "issue-broker-capabilities", action: "operator-issue-exact-secrets" },
    { id: "issue-runtime-capabilities", action: "operator-issue-exact-runtime-credentials" },
    { id: "start-database", action: "operator-apply", artifact: "database" },
    { id: "wait-database", action: "operator-wait-ready", requires: ["start-database"] },
    { id: "start-gateway", action: "operator-apply", artifact: "gateway", requires: ["wait-database"] },
    { id: "wait-gateway-migration", action: "operator-wait-ready", requires: ["start-gateway"] },
    { id: "grant-receipts", action: "operator-apply", artifact: "grants", requires: ["wait-gateway-migration"] },
    { id: "wait-grants", action: "operator-wait-complete", requires: ["grant-receipts"] },
    { id: "codex-login", action: "operator-apply", artifact: "codex-login", requires: ["wait-grants"] },
    { id: "wait-codex-login", action: "operator-wait-complete", requires: ["codex-login"] },
    { id: "codex-smoke", action: "operator-replace-auth-job", artifact: "codex-smoke", requires: ["wait-codex-login"] },
    { id: "wait-codex-smoke", action: "operator-wait-complete", requires: ["codex-smoke"] },
    { id: "start-ui", action: "operator-apply", artifact: "ui", requires: ["wait-grants"] },
    { id: "wait-ui", action: "operator-wait-ready", requires: ["start-ui"] },
    { id: "start-runtime", action: "operator-apply", artifact: "runtime", requires: ["wait-codex-smoke", "wait-ui"] },
    { id: "wait-runtime", action: "operator-wait-ready", requires: ["start-runtime"] },
    { id: "record-proof", action: "operator-record-and-export-evidence", requires: ["wait-runtime"] },
    { id: "stop-runtime", action: "operator-delete-exact-runtime-job", requires: ["record-proof"] },
    { id: "revoke-capabilities", action: "operator-revoke-exact-secrets", requires: ["stop-runtime"] },
    { id: "delete-namespace", action: "operator-delete-exact-namespace", requires: ["revoke-capabilities"] },
    { id: "verify-teardown", action: "operator-verify-namespace-absent", requires: ["delete-namespace"] },
  ];
}

export function buildSessionProofPlan(input) {
  if (!RUN_ID.test(input.runId ?? "")) {
    throw new Error("proof run ID must be one DNS-safe label");
  }
  const expectedNamespace = `codeops-session-proof-${input.runId}`;
  if (input.namespace !== expectedNamespace || input.namespace.length > 63) {
    throw new Error("proof namespace must be derived exactly from the run ID");
  }
  if (!SHA.test(input.baseSha ?? "")) {
    throw new Error("proof base SHA must contain 40 lowercase hex characters");
  }
  if (!SUFFIX.test(input.sessionSuffix ?? "")) {
    throw new Error("proof session suffix must be one bounded DNS-safe label");
  }

  const expected = expectedArtifacts(input);
  const fileIds = Object.keys(input.files ?? {}).sort();
  if (
    JSON.stringify(fileIds) !==
    JSON.stringify(expected.map((artifact) => artifact.id).sort())
  ) {
    throw new Error("proof artifact set is incomplete or contains extras");
  }
  const artifacts = expected.map((artifact) => {
    const file = input.files[artifact.id];
    if (typeof file.path !== "string" || typeof file.source !== "string") {
      throw new Error(`${artifact.id} artifact must provide path and source`);
    }
    return inspectArtifact(artifact, file.source, input);
  });

  return {
    apiVersion: "codeops.example/session-proof-plan/v1",
    admission: "closed",
    execution: "render-and-review-only",
    identity: {
      namespace: input.namespace,
      runId: input.runId,
      baseSha: input.baseSha,
      sessionSuffix: input.sessionSuffix,
    },
    artifacts,
    sequence: sessionProofSequence(),
  };
}
