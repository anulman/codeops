import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
  assert.equal(example.profile, "custom");
  assert.equal(example.temporal, undefined);
  assert.equal(example.plane.deployment, "external");
  assert.equal(example.plane.enabled, false);
  assert.equal(example.plane.adapter.enabled, true);
  assert.equal(example.plane.adapter.onboardingRequired, false);
  assert.equal(example.quickstart.enabled, true);
  assert.equal(example.quickstart.registry.enabled, false);
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
  assert.match(rootReadme, /default `full-managed` profile/);
  assert.doesNotMatch(rootReadme, /Temporal remains an external dependency/);
  assert.match(chartReadme, /--values \/absolute\/path\/values\.yaml/);
  assert.match(chartReadme, /Quickstart supports exactly one repository/);
  assert.match(chartReadme, /Helm also stores supplied[\s\S]*release record/);
  assert.match(chartReadme, /uninstall retains the quickstart Secrets and PostgreSQL data PVC/);
  assert.match(chartReadme, /workspace-launch-token/);
  assert.match(chartReadme, /upgrade-for-interactive-workspace-launch/);
  assert.match(chartReadme, /ASD-STE100 technical product writing standard/);

  const render = spawnSync("helm", [
    "template", "codeops", "infra/charts/codeops",
    "--namespace", "codeops",
    "--values", "infra/charts/codeops/examples/quickstart-values.yaml",
    "--values", "infra/fixtures/helm/quickstart-values.yaml",
    "--values", "infra/fixtures/helm/immutable-images.yaml",
    "--set", "agentsUi.access.issuer=https://example.cloudflareaccess.com",
    "--set", "ingress.host=codeops.example.com",
    "--set", "ingress.annotations.cert-manager\\.io/cluster-issuer=letsencrypt",
    "--set", "controlGateway.kubernetesApiCidrs[0]=10.43.0.1/32",
    "--set", "plane.apiOrigin=https://plane.example.com",
    "--set", "quickstart.registry.enabled=false",
  ], { encoding: "utf8" });
  assert.equal(render.status, 0, render.stderr);
  assert.match(render.stdout, /name: codeops-github-controller/);
  assert.match(render.stdout, /name: codeops-orchestrator/);
  assert.doesNotMatch(render.stdout, /name: codeops-pgdb-wl/);
});
