import { parse } from "yaml";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const repositories = [
  ["codeops-nats", "https://nats-io.github.io/k8s/helm/charts/"],
  ["codeops-temporal", "https://go.temporal.io/helm-charts/"],
  ["codeops-plane", "https://helm.plane.so/"],
];

function helm(args, env) {
  const result = spawnSync("helm", args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`helm ${args[0]} failed with exit code ${result.status}`);
  }
}

async function helmWithRetry(args, env, attempts = 5) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      helm(args, env);
      return;
    } catch (error) {
      failure = error;
      if (attempt < attempts) await delay(attempt * 2_000);
    }
  }
  throw failure;
}

// Offline verification uses the same pinned archives, without repository egress.
if (process.env.CODEOPS_OFFLINE_CHARTS === "1") {
  const lock = parse(await readFile("infra/charts/codeops/Chart.lock", "utf8"));
  const pins = JSON.parse(await readFile("infra/charts/codeops/dependency-sha256.json", "utf8"));
  const names = lock.dependencies.map(({name, version}) => `${name}-${version}.tgz`).sort();
  if (JSON.stringify(Object.keys(pins).sort()) !== JSON.stringify(names)) throw new Error("Offline chart set differs from lock");
  for (const [file, expected] of Object.entries(pins)) {
    if (!/^[a-z0-9.-]+\.tgz$/.test(file) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid chart archive pin");
    const bytes = await readFile(path.join("infra/charts/codeops/charts", file));
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("Offline chart archive digest mismatch");
  }
  if (Object.keys(pins).length !== repositories.length) throw new Error("Offline chart archive set is incomplete");
  process.exit(0);
}

const helmRoot = await mkdtemp(path.join(os.tmpdir(), "codeops-helm-"));
const env = {
  ...process.env,
  HELM_CONFIG_HOME: path.join(helmRoot, "config"),
  HELM_CACHE_HOME: path.join(helmRoot, "cache"),
  HELM_DATA_HOME: path.join(helmRoot, "data"),
};

try {
  await Promise.all([
    mkdir(env.HELM_CONFIG_HOME, { recursive: true }),
    mkdir(env.HELM_CACHE_HOME, { recursive: true }),
    mkdir(env.HELM_DATA_HOME, { recursive: true }),
  ]);
  for (const [name, repository] of repositories) {
    helm(["repo", "add", name, repository], env);
  }
  await helmWithRetry([
    "dependency",
    "build",
    "--skip-refresh",
    "infra/charts/codeops",
  ], env);
} finally {
  await rm(helmRoot, { recursive: true, force: true });
}
