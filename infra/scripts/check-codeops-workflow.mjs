import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const path = ".github/workflows/codeops-ci.yml";
const workflow = parse(await readFile(path, "utf8"));

assert.equal(workflow.name, "CodeOps CI");
assert.ok(workflow.on?.pull_request?.paths);
assert.ok(workflow.on?.push?.paths);
assert.deepEqual(workflow.permissions, { contents: "read" });
assert.equal(Object.keys(workflow.jobs).length, 1);

const contracts = workflow.jobs.contracts;
assert.equal(contracts["runs-on"], "ubuntu-latest");
assert.equal(contracts.permissions, undefined);
assert.ok(Array.isArray(contracts.steps));
assert.deepEqual(contracts.steps[0]?.with, {
  "fetch-depth": 2,
  "persist-credentials": false,
});
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
    (step) => step.run === "nub run --filter @renoconcierge/codeops-contracts test",
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
        "registry-bbbbbbbbbbbb.preview.renoconcierge.ca",
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
      step.env?.CODEOPS_PLANE_CONTROLLER_HOST === "work.renoconcierge.ca",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @renoconcierge/codeops-contracts typecheck",
  ),
);
assert.ok(
  contracts.steps.some(
    (step) => step.run === "nub run --filter @renoconcierge/codeops-contracts build",
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
      step.run === "npm ci --workspaces=false --prefix services/codeops-agent",
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
