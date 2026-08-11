import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderSessionProofGrantsManifest } from "./codeops-session-proof-grants-render.mjs";

const template = await readFile(new URL("../k8s/codeops/trial0/session-proof-grants-template.yaml", import.meta.url), "utf8");
const digest = `sha256:${"a".repeat(64)}`;
const resources = (source = template) => parseAllDocuments(renderSessionProofGrantsManifest(source, digest)).map((document) => document.toJS());

test("packages one immutable non-retrying post-migration grant Job", () => {
  const values = resources();
  const job = values.find((resource) => resource.kind === "Job");
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 300);
  assert.equal(Object.hasOwn(job.spec, "ttlSecondsAfterFinished"), false);
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(job.spec.template.spec.containers[0].image.endsWith(`@${digest}`), true);
});

test("mounts only the database owner capability and grants receipt columns", () => {
  const values = resources();
  const pod = values.find((resource) => resource.kind === "Job").spec.template.spec;
  assert.equal(pod.volumes.filter((volume) => volume.secret).length, 1);
  const sql = values.find((resource) => resource.kind === "ConfigMap").data["grants.sql"];
  assert.match(sql, /GRANT SELECT \(dispatch_id, dispatch_digest, status, result_json\)/);
  assert.match(sql, /GRANT UPDATE \(status, result_json, completed_at\)/);
  assert.equal(sql.includes("GRANT SELECT ON ALL TABLES"), false);
});

test("waits boundedly for migration and reaches only database plus DNS", () => {
  const values = resources();
  const command = values.find((resource) => resource.kind === "Job").spec.template.spec.containers[0].command.join("\n");
  assert.match(command, /attempts=.*attempts \+ 1/);
  assert.match(command, /attempts.*-lt 60/);
  assert.equal(command.includes("database-url"), false);
  const policy = values.find((resource) => resource.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress, []);
  assert.deepEqual(policy.spec.egress.flatMap((rule) => rule.ports.map((port) => port.port)).sort((a, b) => Number(a) - Number(b)), [53, 53, 5432]);
});

test("rejects mutable images, retries, broad grants, and network drift", () => {
  for (const invalid of ["", "latest", "sha256:abc", `sha256:${"A".repeat(64)}`]) assert.throws(() => renderSessionProofGrantsManifest(template, invalid));
  for (const drifted of [
    template.replace("backoffLimit: 0", "backoffLimit: 2"),
    template.replace("activeDeadlineSeconds: 300", "activeDeadlineSeconds: 300\n  ttlSecondsAfterFinished: 3600"),
    template.replace("GRANT SELECT (dispatch_id, dispatch_digest, status, result_json)", "GRANT SELECT ON ALL TABLES IN SCHEMA codeops"),
    template.replace("app.kubernetes.io/name: codeops-session-proof-database", "app.kubernetes.io/name: unrelated"),
    `${template}\n---\napiVersion: v1\nkind: Secret\nmetadata: { name: extra }\n`,
  ]) assert.throws(() => renderSessionProofGrantsManifest(drifted, digest));
});
