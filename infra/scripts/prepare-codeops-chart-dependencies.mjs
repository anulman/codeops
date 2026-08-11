import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  helm([
    "dependency",
    "build",
    "--skip-refresh",
    "infra/charts/codeops",
  ], env);
} finally {
  await rm(helmRoot, { recursive: true, force: true });
}
