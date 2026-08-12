#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const SCHEMA_VERSION = "codeops.smoke/v1";
const RESOURCE_TYPES = "deployments,statefulsets,persistentvolumeclaims";

function usage() {
  return `Usage: nub run smoke -- [--release <name>] [--namespace <name>] [--json]\n\nOptions:\n  --release <name>    Helm release name (default: codeops)\n  --namespace <name>  Kubernetes namespace (default: release name)\n  --json              Print the stable ${SCHEMA_VERSION} JSON report\n  --help              Show this help\n`;
}

function parseArguments(argv) {
  const options = { release: "codeops", namespace: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--release" || argument === "--namespace") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  options.namespace ??= options.release;
  for (const [name, value] of [["release", options.release], ["namespace", options.namespace]]) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) throw new Error(`${name} must be a Kubernetes DNS label`);
  }
  return options;
}

function execute(name, args) {
  return execFileSync(name, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

function check(id, category, target, status, message) {
  return { id, category, target, status, message };
}

function workloadCheck(resource) {
  const kind = resource.kind;
  const name = resource.metadata?.name ?? "unknown";
  const desired = resource.spec?.replicas ?? 1;
  const ready = resource.status?.readyReplicas ?? 0;
  const generationCurrent = (resource.status?.observedGeneration ?? 0) >= (resource.metadata?.generation ?? 0);
  let current = generationCurrent && ready === desired;
  if (kind === "StatefulSet") current &&= resource.status?.currentRevision === resource.status?.updateRevision;
  return check(
    `workload.${kind.toLowerCase()}.${name}`,
    "workload",
    `${kind}/${name}`,
    current ? "pass" : "fail",
    current ? `${ready}/${desired} replicas ready` : `${ready}/${desired} replicas ready or rollout not current`,
  );
}

function pvcCheck(resource) {
  const name = resource.metadata?.name ?? "unknown";
  const phase = resource.status?.phase ?? "Unknown";
  return check(`pvc.${name}`, "storage", `PersistentVolumeClaim/${name}`, phase === "Bound" ? "pass" : "fail", `phase is ${phase}`);
}

function resourceCategory(resource) {
  const labels = resource.metadata?.labels ?? {};
  const component = labels["app.kubernetes.io/component"] ?? "";
  const appName = labels["app.kubernetes.io/name"] ?? "";
  const name = resource.metadata?.name ?? "";
  const identity = `${component} ${appName} ${name}`.toLowerCase();
  if (identity.includes("github-controller")) return "controller";
  if (identity.includes("session-gateway") || identity.includes("control-gateway")) return "gateway";
  if (identity.includes("temporal")) return "temporal";
  if (identity.includes("jetstream") || component === "nats") return "jetstream";
  if (identity.includes("postgres")) return "postgresql";
  return undefined;
}

function belongsToRelease(resource, release) {
  const labels = resource.metadata?.labels ?? {};
  if (labels["app.kubernetes.io/instance"] === release) return true;
  return resource.kind === "PersistentVolumeClaim" && labels["app.kubernetes.io/part-of"] === "codeops" && (resource.metadata?.name ?? "").includes(release);
}

function categoryChecks(resources, readiness) {
  return ["controller", "gateway", "temporal", "jetstream", "postgresql"].map((category) => {
    const members = resources.filter((resource) => resourceCategory(resource) === category);
    if (members.length === 0) return check(`health.${category}`, "health", category, "skip", "no managed resource is installed");
    const memberTargets = new Set(members.map((resource) => `${resource.kind}/${resource.metadata?.name}`));
    const memberChecks = readiness.filter((candidate) => memberTargets.has(candidate.target));
    const healthy = memberChecks.length === members.length && memberChecks.every(({ status }) => status === "pass");
    return check(
      `health.${category}`,
      "health",
      category,
      healthy ? "pass" : "fail",
      healthy ? `${members.length} managed resource(s) ready` : "one or more managed resources are not ready",
    );
  });
}

function buildReport(options) {
  const checks = [];
  let release = { name: options.release, namespace: options.namespace, status: "unknown", revision: null, chart: null, appVersion: null };
  try {
    const releases = JSON.parse(execute("helm", ["list", "--namespace", options.namespace, "--filter", `^${options.release}$`, "--output", "json"]));
    const installed = releases.find(({ name }) => name === options.release);
    if (!installed) checks.push(check("helm.release", "helm", `HelmRelease/${options.release}`, "fail", "release not found"));
    else {
      release = {
        name: options.release,
        namespace: options.namespace,
        status: installed.status ?? "unknown",
        revision: installed.revision == null ? null : String(installed.revision),
        chart: installed.chart ?? null,
        appVersion: installed.app_version ?? null,
      };
      checks.push(check("helm.release", "helm", `HelmRelease/${options.release}`, release.status === "deployed" ? "pass" : "fail", `status is ${release.status}`));
    }
  } catch {
    checks.push(check("helm.release", "helm", `HelmRelease/${options.release}`, "fail", "Helm status query failed"));
  }

  let resources = [];
  try {
    const response = JSON.parse(execute("kubectl", ["get", RESOURCE_TYPES, "--namespace", options.namespace, "--output", "json"]));
    resources = (response.items ?? []).filter((resource) => belongsToRelease(resource, options.release));
    checks.push(check("kubernetes.resources", "kubernetes", `Namespace/${options.namespace}`, resources.length > 0 ? "pass" : "fail", resources.length > 0 ? `${resources.length} release resource(s) found` : "no release resources found"));
  } catch {
    checks.push(check("kubernetes.resources", "kubernetes", `Namespace/${options.namespace}`, "fail", "resource query failed"));
  }

  const readiness = resources.map((resource) => resource.kind === "PersistentVolumeClaim" ? pvcCheck(resource) : workloadCheck(resource));
  checks.push(...readiness, ...categoryChecks(resources, readiness));
  const summary = {
    passed: checks.filter(({ status }) => status === "pass").length,
    failed: checks.filter(({ status }) => status === "fail").length,
    skipped: checks.filter(({ status }) => status === "skip").length,
  };
  return { schemaVersion: SCHEMA_VERSION, ok: summary.failed === 0, release, summary, checks };
}

function printText(result) {
  for (const item of result.checks) process.stdout.write(`${item.status}\t${item.id}\t${item.target}\t${item.message}\n`);
  process.stdout.write(`${result.ok ? "pass" : "fail"}\tsummary\t${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) process.stdout.write(usage());
  else {
    const result = buildReport(options);
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printText(result);
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n${usage()}`);
  process.exitCode = 2;
}
