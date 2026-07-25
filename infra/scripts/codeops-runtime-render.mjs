const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = "CODEOPS_ORCHESTRATOR_DIGEST";

export function renderOrchestratorManifest(template, digest) {
  if (!DIGEST.test(digest)) {
    throw new Error("orchestrator image must use a lowercase SHA-256 digest");
  }
  const occurrences = template.split(TOKEN).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected exactly one ${TOKEN} token, found ${occurrences}`);
  }
  const rendered = template.replace(TOKEN, digest);
  const images = [...rendered.matchAll(/^\s*image:\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (
    rendered.includes(TOKEN) ||
    images.length !== 1 ||
    images[0] !==
      `ghcr.io/anulman/renoconcierge/renoconcierge-codeops-orchestrator@${digest}`
  ) {
    throw new Error("mutable or unresolved orchestrator image survived rendering");
  }
  return rendered;
}
