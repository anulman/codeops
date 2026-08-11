import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

test("doctor reports bounded tool state without environment values", () => {
  const output = execFileSync(process.execPath, ["infra/scripts/codeops-doctor.mjs", "--json"], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.ok(report.checks.some(({ name }) => name === "node"));
  assert.equal(output.includes("TOKEN"), false);
});

test("repository publishes one complete self-context contract", async () => {
  const paths = [
    "AGENTS.md",
    "docs/context/AGENTS.md",
    "docs/context/SOUL.md",
    "docs/context/CURRENT-STATE.md",
    "docs/context/DECISIONS.md",
    "docs/context/DOMAIN.md",
    "docs/context/PRODUCT.md",
    "docs/context/SOURCE-MAP.md",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  assert.equal(sources.every((source) => source.trim().length > 100), true);
  assert.match(sources[0], /Non-negotiable invariants/);
  assert.match(sources[0], /Test selection/);
});

test("initializer writes one private file and never prints credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codeops-init-"));
  const output = join(directory, "values.yaml");
  const environment = {
    ...process.env,
    CODEOPS_OPENAI_API_KEY: "fixture-openai-credential-0001",
    CODEOPS_GITHUB_READ_TOKEN: "fixture-github-read-credential-0001",
    CODEOPS_GITHUB_WRITE_TOKEN: "fixture-github-write-credential-0001",
    CODEOPS_GITHUB_WEBHOOK_SECRET: "fixture-github-webhook-credential-0001",
    CODEOPS_PLANE_API_KEY: "fixture-plane-api-credential-0001",
    CODEOPS_PLANE_WEBHOOK_SECRET: "fixture-plane-webhook-credential-0001",
    CODEOPS_ACCESS_AUDIENCE: "fixture-access-audience-0001",
  };
  const input = JSON.parse(await readFile("infra/charts/codeops/examples/onboarding.example.json", "utf8"));
  input.contextRoot = new URL("../../docs/context", import.meta.url).pathname;
  input.kubernetesApiCidrs = ["10.43.0.1/32"];
  input.githubReviewerIds = [12345678];
  const inputPath = join(directory, "onboarding.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(inputPath, JSON.stringify(input)));
  const result = spawnSync(process.execPath, ["infra/scripts/init-codeops-quickstart.mjs", "--input", inputPath, "--output", output], { encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  for (const secret of Object.values(environment).filter((value) => typeof value === "string" && value.startsWith("fixture-"))) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const values = parse(await readFile(output, "utf8"));
  assert.equal(values.profile, "custom");
  assert.equal(values.plane.deployment, "external");
  assert.equal(values.plane.adapter.enabled, true);
  assert.equal(values.quickstart.registry.enabled, false);
  assert.equal(values.quickstart.repository.context.currentState.includes("# Current state"), true);
});
