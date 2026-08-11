import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("documents one values file and one Helm install command", async () => {
  const [rootReadme, chartReadme, exampleSource] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("infra/charts/codeops/README.md", "utf8"),
    readFile("infra/charts/codeops/examples/quickstart-values.yaml", "utf8"),
  ]);
  const example = parse(exampleSource);
  assert.equal(example.quickstart.enabled, true);
  assert.equal(example.quickstart.repository.plane.personas.length, 7);
  assert.deepEqual(Object.keys(example.quickstart.repository.context).sort(), [
    "agents",
    "currentState",
    "decisions",
    "directory",
    "domain",
    "product",
    "soul",
    "sourceMap",
  ]);
  assert.equal(JSON.stringify(example).includes("image.digest"), false);
  assert.match(rootReadme, /helm install codeops oci:\/\/ghcr\.io\/anulman\/codeops\/charts\/codeops/);
  assert.match(chartReadme, /--values values\.yaml/);
  assert.match(chartReadme, /Quickstart supports exactly one repository/);
  assert.match(chartReadme, /Helm also stores supplied[\s\S]*release record/);
  assert.match(chartReadme, /uninstall retains the quickstart Secrets and PostgreSQL data PVC/);
});
