import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const path = ".github/workflows/codeops-ci.yml";
const workflow = parse(await readFile(path, "utf8"));

assert.equal(workflow.name, "CodeOps CI");
assert.ok(workflow.on?.pull_request?.paths);
assert.ok(workflow.on?.push?.paths);
assert.deepEqual(workflow.permissions, { contents: "read" });
assert.deepEqual(Object.keys(workflow.jobs), ["contracts", "proof-shard"]);

const contracts = workflow.jobs.contracts;
assert.equal(contracts["runs-on"], "ubuntu-latest");
assert.equal(contracts["timeout-minutes"], 15);
assert.equal(contracts.permissions, undefined);
assert.ok(Array.isArray(contracts.steps));
assert.deepEqual(contracts.steps[0]?.with, {
  "fetch-depth": 2,
  "persist-credentials": false,
});

const proofShard = workflow.jobs["proof-shard"];
assert.equal(proofShard.needs, "contracts");
assert.equal(proofShard["runs-on"], "ubuntu-latest");
assert.equal(proofShard["timeout-minutes"], 30);
assert.deepEqual(proofShard.strategy, {
  "fail-fast": false,
  matrix: { shard: [0, 1, 2] },
});
assert.deepEqual(proofShard.steps[0]?.with, {
  "fetch-depth": 2,
  "persist-credentials": false,
});
const shardStep = proofShard.steps.find((step) =>
  step.name === "Test closed-proof shard ${{ matrix.shard }}");
const proofFixtureStep = proofShard.steps.find((step) =>
  step.name === "Render closed-proof fixtures");
assert.ok(proofShard.steps.some((step) => step.run === "nub install --frozen-lockfile"));
for (const renderer of [
  "render-codeops-session-runtime-worker.mjs",
  "render-codeops-session-proof-namespace.mjs",
  "render-codeops-session-proof-gateway.mjs",
  "render-codeops-session-proof-ui.mjs",
  "render-codeops-session-proof-database.mjs",
  "render-codeops-session-proof-grants.mjs",
  "render-codeops-session-proof-codex-auth.mjs",
]) {
  assert.ok(proofFixtureStep?.run?.includes(renderer));
}
assert.equal(shardStep?.env?.CODEOPS_PROOF_TEST_SHARD_COUNT, 3);
assert.equal(shardStep?.env?.CODEOPS_PROOF_TEST_SHARD_INDEX, "${{ matrix.shard }}");
assert.equal(
  shardStep?.run,
  "node --test infra/scripts/test-codeops-session-proof-namespace-create.mjs",
);
assert.equal(
  contracts.steps.some((step) =>
    step.run?.includes("test-codeops-session-proof-namespace-create.mjs")),
  false,
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Install Nub" &&
      step.env?.GITHUB_TOKEN === "${{ github.token }}" &&
      step.run?.includes("https://nubjs.com/install.sh") &&
      step.run?.includes("0.1.11"),
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Verify independent product and internal release routing" &&
      step.run === "node --test infra/scripts/test-release-scope.mjs",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Verify trusted release image plan" &&
      step.run === "node infra/scripts/test-ci-image-plan.mjs",
  ),
);
for (const stepName of [
  "Render Trial 0 orchestrator with an immutable image",
  "Test and render the Trial 0 Plane controller",
  "Test and render the scoped cluster-native image path",
  "Test and render the isolated Trial 0 Agent Job",
]) {
  const step = contracts.steps.find((candidate) => candidate.name === stepName);
  assert.ok(step?.run?.includes("infra/scripts/check-codeops-manifests.mjs"));
  assert.equal(step?.run?.includes("kubectl"), false);
}
assert.ok(contracts.steps.some((step) => step.run === "nub install --frozen-lockfile"));
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @codeops/codeops-contracts test",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Test and render the scoped cluster-native image path" &&
      step.run?.includes("infra/scripts/test-codeops-cluster-build.mjs") &&
      step.run?.includes("infra/scripts/render-codeops-cluster-registry.mjs") &&
      step.run?.includes(
        "infra/scripts/render-codeops-cluster-image-builder.mjs",
      ) &&
      step.env?.CODEOPS_REGISTRY_HOST ===
        "registry-bbbbbbbbbbbb.preview.codeops.example",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Build privileged Plane controller image" &&
      step.run?.includes("infra/docker/codeops-plane-controller.Dockerfile"),
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Test and render the Trial 0 Plane controller" &&
      step.run?.includes("infra/scripts/test-codeops-plane-controller.mjs") &&
      step.run?.includes("infra/scripts/render-codeops-plane-controller.mjs") &&
      step.env?.CODEOPS_PLANE_CONTROLLER_HOST === "work.codeops.example" &&
      step.env?.CODEOPS_ALLOWED_GITHUB_REVIEWER_IDS === "6723643628" &&
      step.env?.CODEOPS_READY_STATE_ID &&
      step.env?.CODEOPS_IN_PROGRESS_STATE_ID &&
      step.env?.CODEOPS_NEEDS_ATTENTION_STATE_ID &&
      step.env?.CODEOPS_COMPLETE_STATE_ID,
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @codeops/codeops-contracts typecheck",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @codeops/codeops-contracts build",
  ),
);
assert.ok(contracts.steps.some((step) => step.run === "git diff --check HEAD^ HEAD"));
assert.ok(
  contracts.steps.some(
    (step) => step.run === "node --test infra/scripts/test-codeops-capacity.mjs",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "node --test infra/scripts/test-codeops-bootstrap-policy.mjs",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "node --test infra/scripts/test-codeops-plane-chart.mjs",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "node --test infra/scripts/test-codeops-plane-images.mjs",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "bash infra/scripts/check-codeops-plane-render.sh",
  ),
);
assert.ok(
  workflow.on.pull_request.paths.includes("services/codeops-session-gateway/**"),
);
assert.ok(
  workflow.on.pull_request.paths.includes("services/codeops-plane-controller/**"),
);
assert.ok(workflow.on.pull_request.paths.includes("services/codeops-agent/**"));
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Test and typecheck ACP session gateway" &&
      step.run?.includes(
        "npm ci --workspaces=false --prefix services/codeops-session-gateway",
      ) &&
      step.run?.includes("npm test --prefix services/codeops-session-gateway") &&
      step.run?.includes(
        "npm run typecheck --prefix services/codeops-session-gateway",
      ),
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Test and typecheck Plane research admission controller" &&
      step.run?.includes(
        "npm ci --workspaces=false --prefix services/codeops-plane-controller",
      ) &&
      step.run?.includes("npm test --prefix services/codeops-plane-controller") &&
      step.run?.includes(
        "npm run typecheck --prefix services/codeops-plane-controller",
      ),
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Verify pinned ACP agent adapter" &&
      step.run?.includes(
        "npm ci --workspaces=false --prefix services/codeops-agent",
      ) &&
      step.run?.includes("npm test --prefix services/codeops-agent"),
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Build isolated ACP runtime images" &&
      step.run?.includes("infra/docker/codeops-agent.Dockerfile") &&
      step.run?.includes("infra/docker/codeops-session-gateway.Dockerfile"),
  ),
);
assert.ok(
  contracts.steps.some(
    (step) =>
      step.name === "Test and render the isolated Trial 0 Agent Job" &&
      step.env?.CODEOPS_PROMPT ===
        "Inspect the exact candidate and return an implementation plan.",
  ),
);

function inspect(value, path = []) {
  if (typeof value === "string") {
    assert.equal(value.includes("secrets."), false, `secret context at ${path.join(".")}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, [...path, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "permissions") {
        assert.equal(typeof child, "object", `shorthand permissions at ${path.join(".")}`);
        for (const permission of Object.values(child ?? {})) {
          assert.notEqual(permission, "write", `write permission at ${path.join(".")}`);
        }
      }
      inspect(child, [...path, key]);
    }
  }
}

inspect(workflow);

console.log(`${path} is valid, read-only, and uses no privileged secrets.`);
