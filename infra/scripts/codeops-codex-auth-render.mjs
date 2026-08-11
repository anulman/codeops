import { parseAllDocuments } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ACTIONS = new Set(["login", "smoke"]);

export function renderCodexAuthManifest(template, input) {
  if (!DIGEST.test(input.agentDigest ?? "")) {
    throw new Error("agentDigest must be a lowercase SHA-256 digest");
  }
  if (!ACTIONS.has(input.action)) {
    throw new Error("auth action must be login or smoke");
  }
  const rendered = template
    .replaceAll("__CODEOPS_AGENT_DIGEST__", input.agentDigest)
    .replaceAll("__CODEOPS_AUTH_ACTION__", input.action);
  if (/__CODEOPS_[A-Z0-9_]+__/.test(rendered)) {
    throw new Error("unresolved Codex auth token");
  }
  const resources = parseAllDocuments(rendered).map((document) =>
    document.toJS(),
  );
  const identities = resources
    .map((resource) => `${resource.kind}/${resource.metadata.name}`)
    .sort();
  const expected = [
    `Job/codeops-codex-auth-${input.action}`,
    "NetworkPolicy/codeops-codex-auth",
    "PersistentVolumeClaim/codeops-codex-auth",
    "ServiceAccount/codeops-codex-auth",
  ].sort();
  if (JSON.stringify(identities) !== JSON.stringify(expected)) {
    throw new Error("Codex auth resource set drifted");
  }
  const job = resources.find((resource) => resource.kind === "Job");
  const pod = job.spec.template.spec;
  const container = pod.containers[0];
  if (
    pod.automountServiceAccountToken !== false ||
    resources.find((resource) => resource.kind === "ServiceAccount")
      .automountServiceAccountToken !== false ||
    pod.volumes.some((volume) => volume.secret || volume.hostPath) ||
    container.env.some((entry) =>
      /TOKEN|KEY|REPOSITORY|PLANE|GITHUB|KUBERNETES/.test(entry.name),
    )
  ) {
    throw new Error("Codex auth Job credential boundary drifted");
  }
  if (
    pod.volumes.find((volume) => volume.name === "codex-auth")
      ?.persistentVolumeClaim?.claimName !== "codeops-codex-auth"
  ) {
    throw new Error("Codex auth claim binding drifted");
  }
  return rendered;
}
