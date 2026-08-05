import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderSessionProofCodexAuthManifest } from "./codeops-session-proof-codex-auth-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/codex-auth-template.yaml", import.meta.url),
  "utf8",
);
const baseInput = {
  agentDigest: `sha256:${"a".repeat(64)}`,
  namespace: "codeops-session-proof-video-1",
  runId: "video-1",
};
const resources = (action, source = template, input = baseInput) => parseAllDocuments(
  renderSessionProofCodexAuthManifest(source, { ...input, action }),
).map((document) => document.toJS());

for (const action of ["login", "smoke"]) {
  test(`binds the credential-only ${action} Job to the exact proof namespace`, () => {
    const values = resources(action);
    assert.deepEqual(values.map((resource) => resource.kind).sort(), [
      "Job", "NetworkPolicy", "PersistentVolumeClaim", "ServiceAccount",
    ]);
    for (const resource of values) {
      assert.equal(resource.metadata.namespace, baseInput.namespace);
      assert.equal(resource.metadata.labels["app.kubernetes.io/part-of"], "codeops-session-proof");
      assert.equal(resource.metadata.labels["codeops.renoconcierge.ca/proof-run"], baseInput.runId);
    }
  });
}

test("keeps model auth on one bounded claim with no injected credential", () => {
  const values = resources("login");
  const claim = values.find((resource) => resource.kind === "PersistentVolumeClaim");
  const pod = values.find((resource) => resource.kind === "Job").spec.template.spec;
  assert.deepEqual(claim.spec.accessModes, ["ReadWriteOnce"]);
  assert.equal(claim.spec.resources.requests.storage, "1Gi");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.volumes.some((volume) => volume.secret || volume.hostPath), false);
  assert.equal(JSON.stringify(values).includes("CODEX_API_KEY"), false);
});

test("permits only DNS and public HTTPS", () => {
  const policy = resources("smoke").find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b)), [53, 53, 443]);
  const publicRule = policy.spec.egress.find((rule) => rule.ports.some((port) => port.port === 443));
  assert.equal(publicRule.to[0].ipBlock.cidr, "0.0.0.0/0");
  assert.ok(publicRule.to[0].ipBlock.except.includes("10.0.0.0/8"));
});

test("rejects namespace, image, action, claim, credential, and network drift", () => {
  for (const invalid of [
    { ...baseInput, namespace: "codeops-session-proof-other" },
    { ...baseInput, runId: "UPPER" },
    { ...baseInput, agentDigest: "latest" },
  ]) assert.throws(() => renderSessionProofCodexAuthManifest(template, { ...invalid, action: "login" }));
  for (const drifted of [
    template.replace("storage: 1Gi", "storage: 8Gi"),
    template.replace("backoffLimit: 0", "backoffLimit: 2"),
    template.replace("name: CODEX_HOME", "name: CODEX_API_KEY"),
    template.replace("- 10.0.0.0/8", "- 10.1.0.0/16"),
  ]) assert.throws(() => renderSessionProofCodexAuthManifest(drifted, { ...baseInput, action: "login" }));
});
