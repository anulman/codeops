import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAllDocuments } from "yaml";
import { renderCodexAuthManifest } from "./codeops-codex-auth-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/codex-auth-template.yaml", import.meta.url),
  "utf8",
);
const digest = `sha256:${"a".repeat(64)}`;

function resources(action) {
  return parseAllDocuments(
    renderCodexAuthManifest(template, { action, agentDigest: digest }),
  ).map((document) => document.toJS());
}

for (const action of ["login", "smoke"]) {
  test(`renders the credential-only ${action} Job`, () => {
    const values = resources(action);
    const job = values.find((resource) => resource.kind === "Job");
    const pod = job.spec.template.spec;
    const container = pod.containers[0];
    assert.equal(job.metadata.name, `codeops-codex-auth-${action}`);
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(JSON.stringify(pod).includes("secretKeyRef"), false);
    assert.equal(JSON.stringify(pod).includes("serviceAccountToken"), false);
    assert.equal(JSON.stringify(pod).includes("CODEOPS_REPOSITORY"), false);
    assert.equal(JSON.stringify(pod).includes("CODEX_API_KEY"), false);
    assert.equal(
      container.volumeMounts.find((mount) => mount.name === "codex-auth")
        .mountPath,
      "/var/lib/codeops-codex",
    );
    assert.match(container.args[0], new RegExp(`\\n\\s+${action}\\)`));
  });
}

test("fails closed on mutable images, invalid actions, or secret drift", () => {
  assert.throws(() =>
    renderCodexAuthManifest(template, {
      action: "login",
      agentDigest: "latest",
    }),
  );
  assert.throws(() =>
    renderCodexAuthManifest(template, {
      action: "refresh",
      agentDigest: digest,
    }),
  );
  assert.throws(() =>
    renderCodexAuthManifest(
      template.replace(
        "name: CODEX_HOME",
        "name: CODEX_API_KEY",
      ),
      { action: "login", agentDigest: digest },
    ),
  );
});
