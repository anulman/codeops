import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";

import { prepareCodeOpsReleaseChart } from "./codeops-release-chart.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

function releaseValues() {
  return {
    agentsUi: { image: { repository: "ghcr.io/anulman/codeops/agents-ui", digest: digest("a") } },
    gateway: { image: { repository: "ghcr.io/anulman/codeops/session-control-gateway", digest: digest("b") } },
    controlGateway: { image: { repository: "ghcr.io/anulman/codeops/control-gateway", digest: digest("c") } },
    lifecycleRelay: { image: { repository: "ghcr.io/anulman/codeops/control-gateway", digest: digest("c") } },
    modelProxy: { image: { repository: "ghcr.io/anulman/codeops/model-proxy", digest: digest("d") } },
    orchestrator: { image: { repository: "ghcr.io/anulman/codeops/orchestrator", digest: digest("e") } },
    githubController: {
      image: { repository: "ghcr.io/anulman/codeops/plane-controller", digest: digest("f") },
      controlPlaneSha: "1".repeat(40),
    },
    postgresql: { image: { repository: "postgres", digest: digest("2") } },
    runtime: {
      workerImage: { repository: "ghcr.io/anulman/codeops/session-runtime-worker", digest: digest("3") },
      agentImage: { repository: "ghcr.io/anulman/codeops/agent", digest: digest("4") },
      sessionGatewayImage: { repository: "ghcr.io/anulman/codeops/session-gateway", digest: digest("5") },
    },
  };
}

test("stages a release chart with the exact immutable image identity embedded", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-release-chart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseValuesPath = path.join(root, "values.release.yaml");
  const outputRoot = path.join(root, "chart");
  await writeFile(releaseValuesPath, stringify(releaseValues()));
  const sourceBefore = await readFile("infra/charts/codeops/values.yaml", "utf8");

  const result = await prepareCodeOpsReleaseChart({
    chartRoot: "infra/charts/codeops",
    releaseValuesPath,
    outputRoot,
  });
  assert.equal(result.embeddedPaths.length, 23);
  const staged = parse(await readFile(path.join(outputRoot, "values.yaml"), "utf8"));
  assert.equal(staged.agentsUi.image.digest, digest("a"));
  assert.equal(staged.githubController.controlPlaneSha, "1".repeat(40));
  assert.equal(staged.postgresql.image.repository, "postgres");
  assert.equal(staged.postgresql.image.digest, digest("2"));
  assert.equal(staged.quickstart.enabled, false);
  assert.match(
    await readFile(path.join(outputRoot, "LICENSE"), "utf8"),
    /Apache License/,
  );
  assert.match(
    await readFile(path.join(outputRoot, "THIRD_PARTY_NOTICES.md"), "utf8"),
    /NATS Helm chart/,
  );
  assert.match(
    await readFile(path.join(outputRoot, "licenses/NATS-CHART-APACHE-2.0.txt"), "utf8"),
    /Apache License/,
  );
  assert.match(
    await readFile(path.join(outputRoot, "licenses/TEMPORAL-CHART-MIT.txt"), "utf8"),
    /Temporal Technologies/,
  );
  assert.match(
    await readFile(path.join(outputRoot, "licenses/PLANE-CHART-AGPL-3.0.txt"), "utf8"),
    /Plane Software/,
  );
  assert.equal(await readFile("infra/charts/codeops/values.yaml", "utf8"), sourceBefore);
});

test("rejects missing, additional, or pre-existing release-chart output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codeops-release-chart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseValuesPath = path.join(root, "values.release.yaml");
  const outputRoot = path.join(root, "chart");
  const missing = releaseValues();
  delete missing.runtime.agentImage.digest;
  await writeFile(releaseValuesPath, stringify(missing));
  await assert.rejects(
    prepareCodeOpsReleaseChart({ chartRoot: "infra/charts/codeops", releaseValuesPath, outputRoot }),
    /exact immutable release identity/,
  );

  const extra = releaseValues();
  extra.quickstart = { openaiApiKey: "must-not-enter-release-values" };
  await writeFile(releaseValuesPath, stringify(extra));
  await assert.rejects(
    prepareCodeOpsReleaseChart({ chartRoot: "infra/charts/codeops", releaseValuesPath, outputRoot }),
    /exact immutable release identity/,
  );

  await writeFile(releaseValuesPath, stringify(releaseValues()));
  await prepareCodeOpsReleaseChart({ chartRoot: "infra/charts/codeops", releaseValuesPath, outputRoot });
  await assert.rejects(
    prepareCodeOpsReleaseChart({ chartRoot: "infra/charts/codeops", releaseValuesPath, outputRoot }),
    /output already exists/,
  );
});
