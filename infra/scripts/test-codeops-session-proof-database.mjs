import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderSessionProofDatabaseManifest } from "./codeops-session-proof-database-render.mjs";

const template = await readFile(new URL("../k8s/codeops/trial0/session-proof-database-template.yaml", import.meta.url), "utf8");
const digest = `sha256:${"a".repeat(64)}`;
const resources = (source = template) => parseAllDocuments(renderSessionProofDatabaseManifest(source, digest)).map((document) => document.toJS());

test("packages one immutable disposable PostgreSQL workload", () => {
  const values = resources();
  const pod = values.find((resource) => resource.kind === "Deployment").spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers[0].image.endsWith(`@${digest}`), true);
  assert.equal(pod.volumes.find((volume) => volume.name === "data").emptyDir.sizeLimit, "2Gi");
  assert.equal(JSON.stringify(values).includes("persistentVolumeClaim"), false);
});

test("creates the separate receipt worker role without exposing its password", () => {
  const values = resources();
  const init = values.find((resource) => resource.kind === "ConfigMap").data["01-runtime-worker.sh"];
  assert.match(init, /CREATE ROLE codeops_session_runtime_worker/);
  assert.match(init, /PASSWORD :'worker_password'/);
  assert.equal(init.includes("set -x"), false);
});

test("admits only the proof gateway and runtime worker and denies egress", () => {
  const policy = resources().find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress[0].from.map((source) => source.podSelector.matchLabels["app.kubernetes.io/name"]), ["codeops-control-gateway", "codeops-session-runtime-worker"]);
  assert.deepEqual(policy.spec.egress, []);
});

test("rejects mutable images, persistence, and network or role drift", () => {
  for (const invalid of ["", "latest", "sha256:abc", `sha256:${"A".repeat(64)}`]) assert.throws(() => renderSessionProofDatabaseManifest(template, invalid));
  for (const drifted of [
    template.replace("emptyDir: { sizeLimit: 2Gi }", "persistentVolumeClaim: { claimName: retained }") ,
    template.replace("app.kubernetes.io/name: codeops-session-runtime-worker", "app.kubernetes.io/name: unrelated"),
    template.replace("CREATE ROLE codeops_session_runtime_worker", "CREATE ROLE broader_worker"),
    `${template}\n---\napiVersion: v1\nkind: PersistentVolumeClaim\nmetadata: { name: retained }\n`,
  ]) assert.throws(() => renderSessionProofDatabaseManifest(drifted, digest));
});
