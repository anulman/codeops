import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("documents one values file and one Helm install command", async () => {
  const [rootReadme, chartReadme, exampleSource, agentsBaseline, soulBaseline, chartAgents, chartSoul] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("infra/charts/codeops/README.md", "utf8"),
    readFile("infra/charts/codeops/examples/quickstart-values.yaml", "utf8"),
    readFile("config/project-context/AGENTS.md", "utf8"),
    readFile("config/project-context/SOUL.md", "utf8"),
    readFile("infra/charts/codeops/files/project-context/AGENTS.md", "utf8"),
    readFile("infra/charts/codeops/files/project-context/SOUL.md", "utf8"),
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
  assert.equal(example.quickstart.repository.context.agents, "");
  assert.equal(example.quickstart.repository.context.soul, "");
  assert.equal(chartAgents, agentsBaseline);
  assert.equal(chartSoul, soulBaseline);
  assert.match(rootReadme, /helm install codeops oci:\/\/ghcr\.io\/anulman\/codeops\/charts\/codeops/);
  assert.match(chartReadme, /--values values\.yaml/);
  assert.match(chartReadme, /Quickstart supports exactly one repository/);
  assert.match(chartReadme, /Helm also stores supplied[\s\S]*release record/);
  assert.match(chartReadme, /uninstall retains the quickstart Secrets and PostgreSQL data PVC/);
  assert.match(chartReadme, /ASD-STE100 technical product writing standard/);
});
