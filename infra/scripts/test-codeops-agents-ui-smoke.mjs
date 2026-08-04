import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderAgentsUiSmokeManifest } from "./codeops-agents-ui-smoke-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agents-ui-smoke-template.yaml", import.meta.url),
  "utf8",
);
const digest = `sha256:${"a".repeat(64)}`;

function resources(source = template) {
  return parseAllDocuments(renderAgentsUiSmokeManifest(source, digest)).map(
    (document) => document.toJS(),
  );
}

test("renders one immutable tokenless cluster Playwright Job", () => {
  const values = resources();
  const value = values.find((resource) => resource.kind === "Job");
  const pod = value.spec.template.spec;
  const container = pod.containers[0];
  assert.equal(value.kind, "Job");
  assert.equal(value.spec.backoffLimit, 0);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(
    container.image,
    `ghcr.io/anulman/renoconcierge/renoconcierge-acceptance-runner@${digest}`,
  );
  assert.deepEqual(container.command, [
    "node",
    "services/acceptance-runner/src/codeops-agents-ui-smoke.mjs",
  ]);
  assert.equal(JSON.stringify(value).includes("secretName"), false);
  const policy = values.find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(
    policy.spec.egress.flatMap((rule) => rule.ports.map(({ port }) => port)),
    [3000, 53, 53],
  );
});

test("rejects mutable images, external targets, authority, and runtime drift", () => {
  for (const invalid of ["", "latest", `sha256:${"A".repeat(64)}`]) {
    assert.throws(() => renderAgentsUiSmokeManifest(template, invalid));
  }
  for (const drifted of [
    template.replace("kind: Job", "kind: Deployment"),
    template.replace("automountServiceAccountToken: false", "automountServiceAccountToken: true"),
    template.replace("http://codeops-agents-ui:3000", "https://agents.renoconcierge.ca"),
    template.replace("readOnlyRootFilesystem: true", "readOnlyRootFilesystem: false"),
    template.replace(
      "app.kubernetes.io/name: codeops-agents-ui",
      "app.kubernetes.io/name: codeops-control-gateway",
    ),
    `${template}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: forbidden\n`,
  ]) {
    assert.throws(() => renderAgentsUiSmokeManifest(drifted, digest));
  }
});
