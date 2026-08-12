import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function fixtureCommands() {
  const directory = await mkdtemp(join(tmpdir(), "codeops-smoke-"));
  const command = `#!/usr/bin/env node
const name = process.argv[1].split("/").at(-1);
const unhealthy = process.env.CODEOPS_SMOKE_FIXTURE === "unhealthy";
if (name === "helm") {
  process.stdout.write(JSON.stringify([{name:"team-a",namespace:"engineering",revision:"4",status:"deployed",chart:"codeops-0.1.9",app_version:"abc123"}]));
} else {
  const labels = (component, app = "codeops") => ({"app.kubernetes.io/instance":"team-a","app.kubernetes.io/part-of":"codeops","app.kubernetes.io/component":component,"app.kubernetes.io/name":app});
  const deployment = (name, component, app) => ({kind:"Deployment",metadata:{name,generation:2,labels:labels(component,app)},spec:{replicas:1},status:{observedGeneration:2,readyReplicas:unhealthy && component === "github-controller" ? 0 : 1}});
  const stateful = (name, component, app) => ({kind:"StatefulSet",metadata:{name,generation:2,labels:labels(component,app)},spec:{replicas:1},status:{observedGeneration:2,readyReplicas:1,currentRevision:"r2",updateRevision:"r2"}});
  const pvc = (name, component, phase="Bound") => ({kind:"PersistentVolumeClaim",metadata:{name,labels:labels(component)},status:{phase}});
  process.stdout.write(JSON.stringify({items:[
    deployment("team-a-github-controller","github-controller"),
    deployment("team-a-session-gateway","session-gateway"),
    deployment("team-a-control-gateway","control-gateway"),
    deployment("team-a-temporal-frontend","frontend","temporal"),
    stateful("team-a-jetstream","nats","jetstream"),
    stateful("team-a-postgresql","postgresql"),
    pvc("team-a-controller-state","github-controller",unhealthy ? "Pending" : "Bound")
  ]}));
}`;
  for (const name of ["helm", "kubectl"]) {
    const path = join(directory, name);
    await writeFile(path, command);
    await chmod(path, 0o755);
  }
  return directory;
}

function run(directory, fixture = "healthy") {
  return spawnSync(process.execPath, ["infra/scripts/codeops-smoke.mjs", "--release", "team-a", "--namespace", "engineering", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, CODEOPS_SMOKE_FIXTURE: fixture, CODEOPS_TEST_CREDENTIAL: "must-never-appear-0001" },
  });
}

test("healthy installation returns the stable credential-safe JSON schema", async () => {
  const result = run(await fixtureCommands());
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, "codeops.smoke/v1");
  assert.equal(report.ok, true);
  assert.equal(report.release.status, "deployed");
  assert.equal(report.summary.failed, 0);
  for (const category of ["controller", "gateway", "temporal", "jetstream", "postgresql"]) {
    assert.equal(report.checks.find(({ id }) => id === `health.${category}`).status, "pass");
  }
  assert.equal(`${result.stdout}${result.stderr}`.includes("must-never-appear-0001"), false);
});

test("unready workloads and claims cause a nonzero exit", async () => {
  const result = run(await fixtureCommands(), "unhealthy");
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.summary.failed >= 3);
  assert.equal(report.checks.find(({ id }) => id === "health.controller").status, "fail");
  assert.equal(report.checks.find(({ id }) => id.startsWith("pvc.")).status, "fail");
});
