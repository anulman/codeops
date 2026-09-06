#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validateCodeOpsReleaseVersion } from "./codeops-release-version.mjs";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  open,
  rename,
  lstat,
} from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCK_SCHEMA = "codeops.consumer-lock/v1";
const POLICY_SCHEMA = "codeops.consumer-policy/v1";
const EVIDENCE_SCHEMA = "codeops.consumer-evidence/v1";
const SMOKE_SCHEMA = "codeops.smoke/v1";
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;

function usage() {
  return `Usage:
  codeopsctl verify --lock <file> --values <file> [--chart-path <file>] [--manifest-path <file>]
  codeopsctl deploy --lock <file> --values <file> --policy <file> [--release <name>] [--namespace <name>]
  codeopsctl smoke [--release <name>] [--namespace <name>]
  codeopsctl upgrade --lock <file> --values <file> --policy <file> --operation-dir <private-dir> --notification-url <https-url> [--stage verify|preflight|deploy|notify] [--resume]
  codeopsctl upgrade --operation-dir <private-dir> --status
  codeopsctl upgrade --lock <file> --values <file> --policy <file> --plan

The verify and deploy commands emit ${EVIDENCE_SCHEMA} JSON.
The smoke command emits ${SMOKE_SCHEMA} JSON.
`;
}

export function formatError(error) {
  const messages = [];
  const visit = (current) => {
    if (!(current instanceof Error)) {
      messages.push(String(current));
      return;
    }
    messages.push(current.message);
    if (current instanceof AggregateError) {
      for (const nested of current.errors) visit(nested);
    } else if (current.cause !== undefined) {
      visit(current.cause);
    }
  };
  visit(error);
  return [...new Set(messages)].join("\ncaused by: ");
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || !["verify", "deploy", "smoke", "upgrade"].includes(command)) {
    throw new Error("command must be verify, deploy, smoke, or upgrade");
  }
  const options = {
    command,
    release: "codeops",
    namespace: undefined,
  };
  const names = new Set([
    "lock",
    "values",
    "policy",
    "release",
    "namespace",
    "chart-path",
    "manifest-path",
    "output-dir",
    ...(command === "upgrade" ? ["operation-dir", "notification-url", "stage"] : []),
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (command === "upgrade" && ["--plan", "--dry-run", "--status", "--resume", "--stream"].includes(argument)) {
      options[argument.slice(2).replace("dry-run", "plan")] = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--") || !names.has(argument.slice(2))) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  options.namespace ??= options.release;
  for (const [name, value] of [
    ["release", options.release],
    ["namespace", options.namespace],
  ]) {
    if (!DNS_LABEL.test(value)) throw new Error(`${name} must be a Kubernetes DNS label`);
  }
  if (command !== "smoke" && !options.status) {
    if (!options.lock) throw new Error("--lock is required");
    if (!options.values) throw new Error("--values is required");
  }
  if (command === "deploy" && !options.policy) {
    throw new Error("--policy is required for deploy");
  }
  if (command === "upgrade") {
    if (!options.status && !options.policy) throw new Error("--policy is required for upgrade");
    if (!options.plan && !options.operation_dir) throw new Error("--operation-dir is required");
    if (!options.plan && !options.status && !options.notification_url) throw new Error("--notification-url is required");
    if (options.stage && !["verify", "preflight", "deploy", "notify"].includes(options.stage)) throw new Error("invalid upgrade stage");
    if (options.status && (options.plan || options.resume || options.stage)) throw new Error("status cannot be combined with execution options");
    if (options.plan && (options.resume || options.stage)) throw new Error("plan cannot be combined with execution options");
    if (options.output_dir) throw new Error("upgrade uses --operation-dir");
  }
  return options;
}

let upgradeLog;
let upgradeStream = false;
function recordUpgradeDiagnostic(entry) {
  const line = `${JSON.stringify(entry)}\n`;
  if (upgradeLog) appendFileSync(upgradeLog, line, { mode: 0o600 });
  if (upgradeStream) process.stderr.write(line);
}
function recordCommand(name, status, bytes = 0) {
  if (upgradeLog) recordUpgradeDiagnostic({ tool: name, status, bytes, output: "redacted" });
}

function execute(name, args, { env = process.env, input, timeout = 120_000 } = {}) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env,
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  recordCommand(name, result.status, (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0));
  if (upgradeLog && (result.error || result.status !== 0)) throw new Error(`${name} failed; inspect operation diagnostics`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${name} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function executeCombined(name, args, { env = process.env, timeout = 120_000 } = {}) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env,
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  recordCommand(name, result.status, (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0));
  if (upgradeLog && (result.error || result.status !== 0)) throw new Error(`${name} failed; inspect operation diagnostics`);
  if (result.error) throw result.error;
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} failed${output.trim() ? `: ${output.trim()}` : ""}`);
  }
  return output;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

export function validateLock(lock) {
  assertObject(lock, "consumer lock");
  if (lock.schemaVersion !== LOCK_SCHEMA) throw new Error("consumer lock schema is not supported");
  if (Object.keys(lock).sort().join(",") !== "chart,release,schemaVersion") {
    throw new Error("consumer lock contains unsupported fields");
  }
  assertObject(lock.release, "consumer lock release");
  assertObject(lock.chart, "consumer lock chart");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(lock.release.repository)) {
    throw new Error("release repository must be owner/name");
  }
  if (typeof lock.release.tag !== "string" || !lock.release.tag.startsWith("v")) {
    throw new Error("release tag must have a v prefix");
  }
  validateCodeOpsReleaseVersion(lock.release.tag.slice(1));
  if (!SOURCE_SHA.test(lock.release.sourceSha)) throw new Error("release source SHA is invalid");
  if (!/^[0-9a-f]{64}$/.test(lock.release.manifestSha256)) {
    throw new Error("release manifest checksum is invalid");
  }
  if (lock.release.manifestAsset !== "release-manifest.json") {
    throw new Error("release manifest asset is not supported");
  }
  if (lock.release.tag !== `v${lock.chart.version}`) {
    throw new Error("release tag and chart version differ");
  }
  if (!lock.chart.repository.startsWith("oci://")) throw new Error("chart repository must be OCI");
  if (!SHA256.test(lock.chart.digest)) throw new Error("chart digest is invalid");
  if (!/^[0-9a-f]{64}$/.test(lock.chart.packageSha256)) {
    throw new Error("chart package checksum is invalid");
  }
  if (lock.chart.asset !== `codeops-${lock.chart.version}.tgz`) {
    throw new Error("chart asset does not match the chart version");
  }
  return lock;
}

export function validatePolicy(policy) {
  assertObject(policy, "consumer policy");
  if (policy.schemaVersion !== POLICY_SCHEMA) throw new Error("consumer policy schema is not supported");
  const policyFields = new Set([
    "schemaVersion",
    "helmTimeout",
    "httpTimeoutMs",
    "requiredSecrets",
    "cluster",
    "postDeployHttpChecks",
  ]);
  if (Object.keys(policy).some((field) => !policyFields.has(field))) {
    throw new Error("consumer policy contains unsupported fields");
  }
  policy.helmTimeout ??= "20m";
  policy.httpTimeoutMs ??= 15_000;
  if (!Array.isArray(policy.requiredSecrets) || policy.requiredSecrets.some((name) => !DNS_LABEL.test(name))) {
    throw new Error("requiredSecrets must contain Kubernetes Secret names");
  }
  if (new Set(policy.requiredSecrets).size !== policy.requiredSecrets.length) {
    throw new Error("requiredSecrets must not contain duplicates");
  }
  assertObject(policy.cluster, "consumer policy cluster");
  if (
    Object.keys(policy.cluster).sort().join(",") !==
    "kubernetesServiceCidrs,readyNodeSelector"
  ) {
    throw new Error("consumer policy cluster contains unsupported fields");
  }
  if (
    !Array.isArray(policy.cluster.kubernetesServiceCidrs) ||
    policy.cluster.kubernetesServiceCidrs.length === 0 ||
    policy.cluster.kubernetesServiceCidrs.some((cidr) => !/^\d{1,3}(\.\d{1,3}){3}\/32$/.test(cidr))
  ) {
    throw new Error("cluster.kubernetesServiceCidrs must contain IPv4 /32 CIDRs");
  }
  if (typeof policy.cluster.readyNodeSelector !== "string" || !policy.cluster.readyNodeSelector) {
    throw new Error("cluster.readyNodeSelector is required");
  }
  if (
    typeof policy.helmTimeout !== "string" ||
    !/^[1-9][0-9]{0,2}[smh]$/.test(policy.helmTimeout) ||
    durationMilliseconds(policy.helmTimeout) > 60 * 60_000
  ) {
    throw new Error("helmTimeout must be a positive duration no longer than 1h");
  }
  if (
    !Number.isSafeInteger(policy.httpTimeoutMs) ||
    policy.httpTimeoutMs < 1_000 ||
    policy.httpTimeoutMs > 60_000
  ) {
    throw new Error("httpTimeoutMs must be between 1000 and 60000");
  }
  if (
    policy.postDeployHttpChecks !== undefined &&
    (!Array.isArray(policy.postDeployHttpChecks) ||
      policy.postDeployHttpChecks.length > 20 ||
      policy.postDeployHttpChecks.some((check) => {
        if (check && typeof check === "object" && !Array.isArray(check)) {
          check.acceptedStatuses ??= [200];
        }
        if (
          !check ||
          typeof check !== "object" ||
          Array.isArray(check) ||
          Object.keys(check).sort().join(",") !== "acceptedStatuses,url" ||
          !Array.isArray(check.acceptedStatuses) ||
          check.acceptedStatuses.length === 0 ||
          new Set(check.acceptedStatuses).size !== check.acceptedStatuses.length ||
          check.acceptedStatuses.some(
            (status) => !Number.isSafeInteger(status) || status < 100 || status > 599,
          )
        ) {
          return true;
        }
        try {
          const url = new URL(check.url);
          return url.protocol !== "https:" || url.username !== "" || url.password !== "";
        } catch {
          return true;
        }
      }))
  ) {
    throw new Error("postDeployHttpChecks must contain strict HTTPS checks and statuses");
  }
  return policy;
}

function durationMilliseconds(value) {
  const units = { s: 1_000, m: 60_000, h: 60 * 60_000 };
  return Number(value.slice(0, -1)) * units[value.at(-1)];
}

async function boundedResponseBytes(response, url, maximumBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`download exceeds ${maximumBytes} bytes: ${url}`);
  }
  if (!response.body) throw new Error(`download body is missing: ${url}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      throw new Error(`download exceeds ${maximumBytes} bytes: ${url}`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

async function download(url, outputPath, maximumBytes = 64 * 1024 * 1024) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}: ${url}`);
  await writeFile(outputPath, await boundedResponseBytes(response, url, maximumBytes), { flag: "wx" });
}

async function downloadReleaseAsset(lock, asset, outputPath) {
  const base = `https://github.com/${lock.release.repository}/releases/download/${lock.release.tag}`;
  try {
    await download(`${base}/${asset}`, outputPath);
  } catch (directError) {
    const releaseResponse = await fetch(
      `https://api.github.com/repos/${lock.release.repository}/releases/tags/${lock.release.tag}`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "codeopsctl" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!releaseResponse.ok) throw directError;
    const release = JSON.parse(
      (await boundedResponseBytes(releaseResponse, releaseResponse.url, 1024 * 1024)).toString("utf8"),
    );
    const match = release.assets?.find(({ name }) => name === asset);
    if (!match) throw directError;
    const assetResponse = await fetch(match.url, {
      redirect: "follow",
      headers: { Accept: "application/octet-stream", "User-Agent": "codeopsctl" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!assetResponse.ok) throw directError;
    await writeFile(
      outputPath,
      await boundedResponseBytes(assetResponse, match.url, 64 * 1024 * 1024),
      { flag: "wx" },
    );
  }
}

async function anonymousImageCheck(image) {
  const registryPath = image.repository.replace(/^ghcr\.io\//, "");
  if (registryPath === image.repository) throw new Error(`unsupported image registry: ${image.repository}`);
  const tokenResponse = await fetch(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${registryPath}:pull`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!tokenResponse.ok) throw new Error(`anonymous token request failed for ${image.repository}`);
  const { token } = JSON.parse(
    (await boundedResponseBytes(tokenResponse, tokenResponse.url, 64 * 1024)).toString("utf8"),
  );
  if (!token) throw new Error(`anonymous token is missing for ${image.repository}`);
  const manifestResponse = await fetch(
    `https://ghcr.io/v2/${registryPath}/manifests/${image.digest}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
        ].join(", "),
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!manifestResponse.ok) {
    throw new Error(`${image.repository}@${image.digest} is not anonymously readable`);
  }
  await manifestResponse.body?.cancel();
}

function validateManifest(lock, bytes) {
  if (sha256(bytes) !== lock.release.manifestSha256) {
    throw new Error("release manifest checksum does not match the consumer lock");
  }
  const manifest = JSON.parse(bytes);
  if (manifest.version !== "codeops.release-images/v1") throw new Error("release manifest schema is not supported");
  if (manifest.sourceSha !== lock.release.sourceSha) throw new Error("release source SHA does not match the lock");
  if (
    manifest.chart?.repository !== lock.chart.repository ||
    manifest.chart?.version !== lock.chart.version ||
    manifest.chart?.digest !== lock.chart.digest
  ) {
    throw new Error("release chart identity does not match the lock");
  }
  const images = Object.values(manifest.images ?? {});
  if (images.length !== 10) throw new Error("release manifest must contain ten CodeOps images");
  for (const image of images) {
    if (!SHA256.test(image.digest) || image.immutableRef !== `${image.repository}@${image.digest}`) {
      throw new Error("release manifest contains an invalid immutable image");
    }
  }
  return manifest;
}

async function prepareRelease(options, lock, directory) {
  const manifestPath = path.join(directory, lock.release.manifestAsset);
  const chartPath = path.join(directory, lock.chart.asset);
  if (options.manifest_path) {
    if (path.resolve(options.manifest_path) !== path.resolve(manifestPath)) await copyFile(options.manifest_path, manifestPath);
  }
  else if (!options.operationId || !await regularFileExists(manifestPath)) await downloadReleaseAsset(lock, lock.release.manifestAsset, manifestPath);

  let pulledDigest = lock.chart.digest;
  if (options.chart_path) {
    if (path.resolve(options.chart_path) !== path.resolve(chartPath)) await copyFile(options.chart_path, chartPath);
  } else if (!options.operationId || !await regularFileExists(chartPath)) {
    const registryRoot = path.join(directory, "anonymous-registry");
    const home = path.join(registryRoot, "home");
    const docker = path.join(registryRoot, "docker");
    const helmRegistry = path.join(home, ".config", "helm", "registry", "config.json");
    await mkdir(path.dirname(helmRegistry), { recursive: true });
    await mkdir(docker, { recursive: true });
    await writeFile(helmRegistry, '{"auths":{}}\n');
    await writeFile(path.join(docker, "config.json"), '{"auths":{}}\n');
    const output = executeCombined(
      "helm",
      ["pull", lock.chart.repository, "--version", lock.chart.version, "--destination", directory],
      {
        env: {
          ...process.env,
          HOME: home,
          DOCKER_CONFIG: docker,
          HELM_REGISTRY_CONFIG: helmRegistry,
        },
      },
    );
    pulledDigest = output.match(/^Digest: (sha256:[0-9a-f]{64})$/m)?.[1];
    if (pulledDigest !== lock.chart.digest) throw new Error("anonymous chart digest does not match the lock");
  }
  const [chartBytes, manifestBytes] = await Promise.all([readFile(chartPath), readFile(manifestPath)]);
  if (sha256(chartBytes) !== lock.chart.packageSha256) {
    throw new Error("chart package checksum does not match the consumer lock");
  }
  const manifest = validateManifest(lock, manifestBytes);
  return { chartPath, manifestPath, manifest, pulledDigest };
}

function expectedRuntimeImages(manifest) {
  return new Set(
    Object.entries(manifest.images)
      .filter(([name]) => name !== "acceptance-runner")
      .map(([, image]) => image.immutableRef),
  );
}

function renderedCodeOpsImages(rendered) {
  return new Set(
    rendered.match(/ghcr\.io\/anulman\/codeops\/[a-z0-9-]+@sha256:[0-9a-f]{64}/g) ?? [],
  );
}

export function buildHelmRenderArguments(options, chartPath) {
  return ["template", options.release, chartPath, "--namespace", options.namespace,
    "--values", options.values,
    ...(options.operationId ? ["--is-upgrade", "--dry-run=server"] : [])];
}

async function verify(options, lock, directory) {
  const prepared = await prepareRelease(options, lock, directory);
  await Promise.all(Object.values(prepared.manifest.images).map(anonymousImageCheck));
  const metadata = execute("helm", ["show", "chart", prepared.chartPath]);
  if (!new RegExp(`^name: codeops$`, "m").test(metadata)) throw new Error("chart name is not codeops");
  if (!new RegExp(`^version: ${lock.chart.version.replaceAll(".", "\\.")}$`, "m").test(metadata)) {
    throw new Error("chart version does not match the lock");
  }
  if (!new RegExp(`^appVersion: [\"']?${lock.release.sourceSha}[\"']?$`, "m").test(metadata)) {
    throw new Error("chart source SHA does not match the lock");
  }
  // Upgrade templates use live, read-only lookup and upgrade migration hooks.
  // Offline lint cannot resolve execution-namespace credential references.
  if (!options.operationId) execute("helm", ["lint", prepared.chartPath, "--values", options.values]);
  const rendered = execute("helm", buildHelmRenderArguments(options, prepared.chartPath));
  const releaseImages = expectedRuntimeImages(prepared.manifest);
  const expectedImages = renderedCodeOpsImages(rendered);
  if (expectedImages.size === 0) throw new Error("rendered chart contains no CodeOps images");
  for (const image of expectedImages) {
    if (!releaseImages.has(image)) throw new Error(`rendered chart contains a foreign CodeOps image: ${image}`);
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA,
    command: "verify",
    ok: true,
    release: {
      tag: lock.release.tag,
      sourceSha: lock.release.sourceSha,
      chartVersion: lock.chart.version,
      chartDigest: lock.chart.digest,
    },
    checks: {
      manifestChecksum: "pass",
      chartChecksum: "pass",
      anonymousChart: options.chart_path ? "provided" : "pass",
      anonymousImages: "pass",
      chartRender: "pass",
    },
    prepared: { ...prepared, expectedImages: [...expectedImages].sort() },
  };
}

function kubectlJson(args) {
  return JSON.parse(execute("kubectl", args));
}

function releaseResources(release, namespace) {
  const selector = `app.kubernetes.io/instance=${release}`;
  return kubectlJson([
    "get",
    "deployments,statefulsets,persistentvolumeclaims,configmaps",
    "--namespace",
    namespace,
    "--selector",
    selector,
    "--output",
    "json",
  ]).items ?? [];
}

function identity(resource) {
  return {
    name: resource.metadata.name,
    uid: resource.metadata.uid,
    ...(resource.kind === "PersistentVolumeClaim" ? { volumeName: resource.spec?.volumeName ?? null } : {}),
  };
}

function snapshotPvcs(resources) {
  return resources
    .filter(({ kind }) => kind === "PersistentVolumeClaim")
    .map(identity)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function referencedPersistentVolumeClaimNames(resources) {
  return [...new Set(resources.flatMap((resource) =>
    (resource.spec?.template?.spec?.volumes ?? [])
      .map((volume) => volume.persistentVolumeClaim?.claimName)
      .filter((name) => typeof name === "string" && name !== ""),
  ))].sort();
}

function snapshotReferencedPvcs(resources, namespace) {
  return referencedPersistentVolumeClaimNames(resources).map((name) =>
    identity(kubectlJson([
      "get", "persistentvolumeclaim", name,
      "--namespace", namespace, "--output", "json",
    ])));
}

function snapshotPreservedPvcs(resources, namespace) {
  return [...new Map([
    ...snapshotPvcs(resources),
    ...snapshotReferencedPvcs(resources, namespace),
  ].map((entry) => [entry.name, entry])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
}

function snapshotSecrets(names, namespace) {
  return names
    .map((name) => {
      const secret = kubectlJson(["get", "secret", name, "--namespace", namespace, "--output", "json"]);
      return {
        name,
        uid: secret.metadata.uid,
        dataSha256: sha256(JSON.stringify(Object.entries(secret.data ?? {}).sort())),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sameIdentities(before, after, name) {
  const current = new Map(after.map((entry) => [entry.name, entry]));
  for (const entry of before) {
    if (JSON.stringify(current.get(entry.name)) !== JSON.stringify(entry)) {
      throw new Error(`${name} identity changed: ${entry.name}`);
    }
  }
}

function readiness(resources) {
  const checks = [];
  for (const resource of resources) {
    const desired = resource.spec?.replicas ?? 1;
    const ready = resource.status?.readyReplicas ?? 0;
    let current = (resource.status?.observedGeneration ?? 0) >= (resource.metadata?.generation ?? 0) && ready === desired;
    if (resource.kind === "StatefulSet") current &&= resource.status?.currentRevision === resource.status?.updateRevision;
    if (resource.kind === "PersistentVolumeClaim") current = resource.status?.phase === "Bound";
    if (["Deployment", "StatefulSet", "PersistentVolumeClaim"].includes(resource.kind)) {
      checks.push({ kind: resource.kind, name: resource.metadata.name, ready: current });
    }
  }
  return checks;
}

function actualCodeOpsImages(resources) {
  const images = new Set();
  for (const resource of resources) {
    for (const container of [
      ...(resource.spec?.template?.spec?.containers ?? []),
      ...(resource.spec?.template?.spec?.initContainers ?? []),
    ]) {
      if (container.image?.startsWith("ghcr.io/anulman/codeops/")) images.add(container.image);
    }
    if (resource.kind === "ConfigMap" && resource.metadata?.labels?.["app.kubernetes.io/component"] === "runtime") {
      for (const value of Object.values(resource.data ?? {})) {
        if (typeof value === "string" && value.startsWith("ghcr.io/anulman/codeops/")) images.add(value);
      }
    }
  }
  return images;
}

function compareImageSets(expected, actual) {
  for (const image of expected) if (!actual.has(image)) throw new Error(`deployed CodeOps image is missing: ${image}`);
  for (const image of actual) if (!expected.has(image)) throw new Error(`deployed CodeOps image is not locked: ${image}`);
}

export function buildSmokeReport(release, namespace, resources, helmRelease) {
  const checks = readiness(resources).map((entry) => ({
    id: `${entry.kind.toLowerCase()}.${entry.name}`,
    target: `${entry.kind}/${entry.name}`,
    status: entry.ready ? "pass" : "fail",
  }));
  checks.unshift({
    id: "helm.release",
    target: `HelmRelease/${release}`,
    status: helmRelease?.status === "deployed" ? "pass" : "fail",
  });
  const failed = checks.filter(({ status }) => status === "fail").length;
  return {
    schemaVersion: SMOKE_SCHEMA,
    ok: failed === 0,
    release: {
      name: release,
      namespace,
      status: helmRelease?.status ?? "missing",
      revision: helmRelease?.revision == null ? null : String(helmRelease.revision),
      chart: helmRelease?.chart ?? null,
      appVersion: helmRelease?.app_version ?? null,
    },
    summary: { passed: checks.length - failed, failed },
    checks,
  };
}

function smoke(options) {
  const installed = kubectlHelmRelease(options.release, options.namespace);
  const resources = releaseResources(options.release, options.namespace);
  return buildSmokeReport(options.release, options.namespace, resources, installed);
}

function kubectlHelmRelease(release, namespace) {
  const releases = JSON.parse(execute("helm", ["list", "--namespace", namespace, "--filter", `^${release}$`, "--output", "json"]));
  return releases.find(({ name }) => name === release);
}

export function buildCompensatingRollbackPlan({
  release,
  namespace,
  previousRelease,
  namespaceExisted,
  helmTimeout,
}) {
  if (previousRelease) {
    return [[
      "helm",
      [
        "rollback",
        release,
        String(previousRelease.revision),
        "--namespace",
        namespace,
        "--no-hooks",
        "--wait",
        "--wait-for-jobs",
        "--timeout",
        helmTimeout,
      ],
    ]];
  }
  return [
    ["helm", ["uninstall", release, "--namespace", namespace, "--wait", "--timeout", helmTimeout]],
    ...(!namespaceExisted
      ? [["kubectl", ["delete", "namespace", namespace, "--wait=true", `--timeout=${helmTimeout}`]]]
      : []),
  ];
}

export function buildHelmUpgradeArguments({
  release,
  chartPath,
  namespace,
  valuesPath,
  helmTimeout,
  preserveInstalledValues,
  operationId,
}) {
  return [
    "upgrade",
    "--install",
    release,
    chartPath,
    "--namespace",
    namespace,
    "--create-namespace",
    ...(operationId ? ["--reset-values", "--description", `codeops-upgrade:${operationId}`] : preserveInstalledValues ? ["--reset-then-reuse-values"] : []),
    "--values",
    valuesPath,
    ...(operationId ? [] : ["--atomic"]),
    "--wait",
    "--wait-for-jobs",
    "--timeout",
    helmTimeout,
  ];
}

async function deploy(options, lock, policy, directory) {
  const verification = options.upgradeVerification ?? await verify(options, lock, directory);
  const apiIp = execute("kubectl", ["get", "service", "kubernetes", "--output", "jsonpath={.spec.clusterIP}"]).trim();
  if (!policy.cluster.kubernetesServiceCidrs.includes(`${apiIp}/32`)) {
    throw new Error("Kubernetes Service ClusterIP is outside the consumer policy");
  }
  const nodes = kubectlJson(["get", "nodes", "--selector", policy.cluster.readyNodeSelector, "--output", "json"]);
  if (!(nodes.items ?? []).some((node) => node.status?.conditions?.some(({ type, status }) => type === "Ready" && status === "True"))) {
    throw new Error("no Ready node matches the consumer policy");
  }
  let beforeResources = [];
  const namespaceExists = spawnSync(
    "kubectl",
    ["get", "namespace", options.namespace, "--output", "name"],
    { encoding: "utf8", timeout: 30_000 },
  ).status === 0;
  if (!namespaceExists && policy.requiredSecrets.length > 0) {
    throw new Error("consumer namespace must exist before external Secrets can be checked");
  }
  if (namespaceExists) beforeResources = releaseResources(options.release, options.namespace);
  const previousRelease = namespaceExists
    ? kubectlHelmRelease(options.release, options.namespace)
    : undefined;
  if (options.operationId && previousRelease?.status !== "deployed") throw new Error("upgrade requires an existing deployed release");
  const pvcsBefore = snapshotPreservedPvcs(beforeResources, options.namespace);
  const secretsBefore = snapshotSecrets(policy.requiredSecrets, options.namespace);
  if (options.beforeUpgrade) await options.beforeUpgrade({ previousRelease, pvcsBefore, secretsBefore });
  await (options.operationId ? executeUpgrade : execute)(
    "helm",
    buildHelmUpgradeArguments({
      release: options.release,
      chartPath: verification.prepared.chartPath,
      namespace: options.namespace,
      valuesPath: options.values,
      helmTimeout: policy.helmTimeout,
      preserveInstalledValues: previousRelease !== undefined,
      operationId: options.operationId,
    }),
    { timeout: durationMilliseconds(policy.helmTimeout) + 5 * 60_000, options },
  );
  try {
    const afterResources = releaseResources(options.release, options.namespace);
    const installed = kubectlHelmRelease(options.release, options.namespace);
    if (
      installed?.status !== "deployed" ||
      installed?.chart !== `codeops-${lock.chart.version}` ||
      installed?.app_version !== lock.release.sourceSha
    ) {
      throw new Error("deployed Helm release identity does not match the lock");
    }
    const smokeReport = buildSmokeReport(options.release, options.namespace, afterResources, installed);
    if (!smokeReport.ok) throw new Error("one or more CodeOps resources are not ready");
    sameIdentities(
      pvcsBefore,
      snapshotPreservedPvcs(afterResources, options.namespace),
      "PVC",
    );
    sameIdentities(secretsBefore, snapshotSecrets(policy.requiredSecrets, options.namespace), "Secret");
    compareImageSets(new Set(verification.prepared.expectedImages), actualCodeOpsImages(afterResources));
    for (const check of policy.postDeployHttpChecks ?? []) {
      const response = await fetch(check.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(policy.httpTimeoutMs),
      });
      if (!check.acceptedStatuses.includes(response.status)) {
        throw new Error(`post-deploy HTTP check failed with ${response.status}: ${check.url}`);
      }
    }
    return {
      schemaVersion: EVIDENCE_SCHEMA,
      command: "deploy",
      ok: true,
      release: verification.release,
      preservation: {
        persistentVolumeClaims: pvcsBefore.length,
        externalSecrets: secretsBefore.length,
      },
      smoke: smokeReport,
      exactImages: "pass",
      postDeployHttpChecks: policy.postDeployHttpChecks?.length ?? 0,
    };
  } catch (deploymentError) {
    // Application-role cutover is forward-only. Upgrade must leave the failed
    // effect for reconciliation, never restart an older API or regrant its role.
    if (options.operationId) throw deploymentError;
    try {
      for (const [name, args] of buildCompensatingRollbackPlan({
        release: options.release,
        namespace: options.namespace,
        previousRelease,
        namespaceExisted: namespaceExists,
        helmTimeout: policy.helmTimeout,
      })) {
        execute(name, args, {
          timeout: durationMilliseconds(policy.helmTimeout) + 5 * 60_000,
        });
      }
      if (previousRelease) {
        const restored = kubectlHelmRelease(options.release, options.namespace);
        if (
          restored?.status !== "deployed" ||
          restored?.chart !== previousRelease.chart ||
          restored?.app_version !== previousRelease.app_version
        ) {
          throw new Error("compensating rollback did not restore the prior release identity");
        }
        const restoredResources = releaseResources(options.release, options.namespace);
        sameIdentities(
          pvcsBefore,
          snapshotPreservedPvcs(restoredResources, options.namespace),
          "rollback PVC",
        );
        sameIdentities(secretsBefore, snapshotSecrets(policy.requiredSecrets, options.namespace), "rollback Secret");
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [deploymentError, rollbackError],
        "post-deploy validation and compensating rollback both failed",
      );
    }
    throw new Error("post-deploy validation failed; the prior release state was restored", {
      cause: deploymentError,
    });
  }
}

const UPGRADE_SCHEMA = "codeops.upgrade/v1";
const UPGRADE_STAGES = ["verify", "preflight", "deploy", "notify"];

async function regularFileExists(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error("operation artifact must be a regular file");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Write-ahead receipts survive process interruption. This directory is local
// operator state, never a source artifact or a claim of deployment authority.
async function saveUpgrade(directory, state) {
  if (upgradeLog) recordUpgradeDiagnostic({ stage: state.stage, status: state.status });
  const temporary = path.join(directory, "state.next");
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path.join(directory, "state.json"));
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

export function upgradeBinding({ lockBytes, valuesBytes, policyBytes, target, notificationUrl }) {
  return sha256(JSON.stringify({
    lock: sha256(lockBytes), values: sha256(valuesBytes), policy: sha256(policyBytes),
    target, notificationUrl,
  }));
}

export function upgradeSummary(state) {
  const exitCode = state.status === "unknown" ? 4
    : state.event && !state.acknowledged ? 5
    : state.status === "failed" ? 3 : 0;
  return {
    schemaVersion: UPGRADE_SCHEMA, operationId: state.operationId,
    status: state.status, stage: state.stage, ok: exitCode === 0, exitCode,
    notification: state.event ? (state.acknowledged ? "acknowledged" : "pending") : "not-ready",
    ...(state.status !== "complete" || !state.acknowledged ? { diagnosticPath: state.logDirectory } : {}),
  };
}

export function validateUpgradeProof(report, lock, manifest) {
  const proof = report.artifactProof;
  if (report.version !== "codeops.golden-release-report/v2" || report.passed !== true ||
      report.sourceSha !== lock.release.sourceSha ||
      report.sourceProof?.evidence?.kind !== "simulated-provider" ||
      report.sourceProof?.evidence?.providerMode !== "fake" ||
      proof?.evidence?.kind !== "released-image" || proof.evidence.sourceCheckout !== false ||
      proof.evidence.immutableImageRefs !== true || proof.chartVersion !== lock.chart.version ||
      proof.chartDigest !== lock.chart.digest || proof.smokeStatus !== "passed" ||
      proof.rollbackStatus !== "passed" || proof.cleanupStatus !== "passed") {
    throw new Error("published release qualification does not match the lock");
  }
  const expected = Object.entries(manifest.images).map(([name, image]) => `${name}:${image.immutableRef}`).sort();
  const actual = (proof.images ?? []).map(({ name, immutableRef }) => `${name}:${immutableRef}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("qualified image digests differ");
}

// Only fixed Kubernetes reason codes leave the subprocess boundary. Messages,
// Pod specs, events and container logs can contain arbitrary credential values.
export function startupDiagnostics(pods) {
  const fatal = new Set(["CreateContainerConfigError", "InvalidImageName", "ErrImageNeverPull", "RunContainerError"]);
  const reasons = new Set([...fatal, "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "OOMKilled", "Error", "Completed", "ContainerCreating", "PodInitializing"]);
  return (pods.items ?? []).slice(0, 40).map((pod) => ({
    uid: /^[a-f0-9-]{36}$/.test(pod.metadata?.uid ?? "") ? pod.metadata.uid : null,
    containers: [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].slice(0, 20).map((container) => {
      const reason = container.state?.waiting?.reason ?? container.state?.terminated?.reason;
      return { reason: reasons.has(reason) ? reason : "Other", fatal: fatal.has(reason), ready: container.ready === true };
    }),
  }));
}

function captureStartup(options) {
  const pods = kubectlJson(["get", "pods", "--namespace", options.namespace,
    "--selector", `app.kubernetes.io/instance=${options.release}`, "--request-timeout=5s", "--output", "json"]);
  const diagnostics = startupDiagnostics(pods);
  if (upgradeLog) recordUpgradeDiagnostic({ startup: diagnostics });
  return diagnostics.some((pod) => !options.priorPodUids?.has(pod.uid) && pod.containers.some((container) => container.fatal));
}

async function executeUpgrade(name, args, { timeout, options }) {
  const priorPods = kubectlJson(["get", "pods", "--namespace", options.namespace,
    "--selector", `app.kubernetes.io/instance=${options.release}`, "--request-timeout=5s", "--output", "json"]);
  options = { ...options, priorPodUids: new Set((priorPods.items ?? []).map((pod) => pod.metadata?.uid)) };
  // Drain bounded chunks without retaining raw output or streaming to the agent.
  // Helm can print rendered Secret values even on its error path.
  await new Promise((resolve, reject) => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"], timeout });
    let bytes = 0;
    let fatal = false;
    let finished = false;
    child.stdout.on("data", (chunk) => { bytes += chunk.length; });
    child.stderr.on("data", (chunk) => { bytes += chunk.length; });
    const timer = setInterval(() => {
      try {
        if (captureStartup(options)) {
          fatal = true;
          child.kill("SIGTERM");
        }
      } catch { /* An API outage is unknown, never a confirmed startup failure. */ }
    }, 2_000);
    const finish = (error, code) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try { captureStartup(options); } catch { /* Preserve the existing diagnostic log. */ }
      recordCommand(name, code, bytes);
      if (error || code !== 0 || fatal) reject(new Error("upgrade effect requires reconciliation"));
      else resolve();
    };
    child.once("error", (error) => finish(error, null));
    child.once("close", (code) => finish(null, code));
  });
}

function upgradeTarget(options) {
  if (!process.env.KUBECONFIG) throw new Error("explicit KUBECONFIG is required");
  // Namespace UID prevents an operation from crossing cluster replacement.
  const namespace = kubectlJson(["get", "namespace", options.namespace, "--output", "json"]);
  const system = kubectlJson(["get", "namespace", "kube-system", "--output", "json"]);
  return { release: options.release, namespace: options.namespace,
    namespaceUid: namespace.metadata.uid, clusterUid: system.metadata.uid };
}

function upgradePreflight(options, policy, verification) {
  const apiIp = execute("kubectl", ["get", "service", "kubernetes", "--output", "jsonpath={.spec.clusterIP}"]).trim();
  if (!policy.cluster.kubernetesServiceCidrs.includes(`${apiIp}/32`)) throw new Error("cluster network policy mismatch");
  const nodes = kubectlJson(["get", "nodes", "--selector", policy.cluster.readyNodeSelector, "--output", "json"]);
  if (!(nodes.items ?? []).some((node) => node.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"))) throw new Error("no matching Ready node");
  for (const resource of ["secrets", "configmaps", "services", "deployments.apps", "statefulsets.apps", "jobs.batch", "serviceaccounts", "roles.rbac.authorization.k8s.io", "rolebindings.rbac.authorization.k8s.io", "networkpolicies.networking.k8s.io", "persistentvolumeclaims"]) {
    for (const verb of ["get", "list", "create", "update", "patch", "delete"]) {
      if (execute("kubectl", ["auth", "can-i", verb, resource, "--namespace", options.namespace]).trim() !== "yes") throw new Error("deployment RBAC prerequisite missing");
    }
  }
  snapshotSecrets(policy.requiredSecrets, options.namespace);
  const rendered = execute("helm", buildHelmRenderArguments(options, verification.prepared.chartPath));
  const list = JSON.parse(execute("kubectl", ["create", "--dry-run=client", "--validate=false", "--filename", "-", "--output", "json"], { input: rendered }));
  const resources = list.kind === "List" ? list.items : [list];
  const resourceNames = { Namespace: "namespaces", Secret: "secrets", ConfigMap: "configmaps", Service: "services",
    Deployment: "deployments.apps", StatefulSet: "statefulsets.apps", Job: "jobs.batch", ServiceAccount: "serviceaccounts",
    Role: "roles.rbac.authorization.k8s.io", RoleBinding: "rolebindings.rbac.authorization.k8s.io",
    NetworkPolicy: "networkpolicies.networking.k8s.io", PersistentVolumeClaim: "persistentvolumeclaims", Ingress: "ingresses.networking.k8s.io" };
  const permissions = new Set();
  for (const resource of resources) {
    const name = resourceNames[resource.kind];
    if (!name) throw new Error("unsupported upgrade resource kind");
    const scope = resource.kind === "Namespace" ? [] : ["--namespace", resource.metadata?.namespace ?? options.namespace];
    for (const verb of ["get", "create", "update", "patch", "delete"]) {
      const args = ["auth", "can-i", verb, name, ...scope];
      if (permissions.has(JSON.stringify(args))) continue;
      permissions.add(JSON.stringify(args));
      if (execute("kubectl", args).trim() !== "yes") throw new Error("rendered resource RBAC prerequisite missing");
    }
  }
  const supplied = new Map(resources.map((r) => [`${r.kind}/${r.metadata?.namespace ?? options.namespace}/${r.metadata?.name}`, r]));
  const lookup = (kind, name, namespace) => supplied.get(`${kind}/${namespace}/${name}`)
    ?? kubectlJson(["get", kind.toLowerCase(), name, "--namespace", namespace, "--output", "json"]);
  for (const resource of resources) {
    const namespace = resource.metadata?.namespace ?? options.namespace;
    const pod = resource.spec?.template?.spec ?? (resource.kind === "Pod" ? resource.spec : undefined);
    if (!pod) continue;
    lookup("ServiceAccount", pod.serviceAccountName ?? "default", namespace);
    const check = (kind, name, key) => {
      const referenced = lookup(kind, name, namespace);
      if (key && !(key in (referenced.data ?? {})) && !(key in (referenced.stringData ?? {}))) throw new Error("required credential or configuration key missing");
    };
    for (const volume of pod.volumes ?? []) {
      if (volume.secret && !volume.secret.optional) {
        check("Secret", volume.secret.secretName);
        for (const item of volume.secret.items ?? []) check("Secret", volume.secret.secretName, item.key);
      }
      if (volume.configMap && !volume.configMap.optional) {
        check("ConfigMap", volume.configMap.name);
        for (const item of volume.configMap.items ?? []) check("ConfigMap", volume.configMap.name, item.key);
      }
      for (const source of volume.projected?.sources ?? []) {
        for (const [field, kind] of [["secret", "Secret"], ["configMap", "ConfigMap"]]) {
          const ref = source[field];
          if (ref && !ref.optional) {
            check(kind, ref.name);
            for (const item of ref.items ?? []) check(kind, ref.name, item.key);
          }
        }
      }
    }
    for (const ref of pod.imagePullSecrets ?? []) check("Secret", ref.name);
    for (const container of [...(pod.initContainers ?? []), ...(pod.containers ?? [])]) {
      for (const env of container.env ?? []) {
        for (const [field, kind] of [["secretKeyRef", "Secret"], ["configMapKeyRef", "ConfigMap"]]) {
          const ref = env.valueFrom?.[field];
          if (ref && !ref.optional) check(kind, ref.name, ref.key);
        }
      }
      for (const env of container.envFrom ?? []) {
        if (env.secretRef && !env.secretRef.optional) check("Secret", env.secretRef.name);
        if (env.configMapRef && !env.configMapRef.optional) check("ConfigMap", env.configMapRef.name);
      }
    }
  }
  execute("helm", ["upgrade", "--install", options.release, verification.prepared.chartPath,
    "--namespace", options.namespace, "--reset-values", "--values", options.values, "--dry-run=server", "--hide-secret"]);
}

export function reconcileUpgradeIdentity(state, history) {
  const revision = Number(state.before.previousRelease?.revision ?? 0) + 1;
  const effect = history.find((item) => Number(item.revision) === revision);
  if (!effect || effect.description !== `codeops-upgrade:${state.operationId}`) return "unknown";
  if (effect.status === "failed" || effect.status === "superseded") return "failed";
  if (effect.status !== "deployed" || Number(history.at(-1)?.revision) !== revision) return "unknown";
  return "validate";
}

async function reconcileUpgrade(options, state, lock, policy) {
  const history = JSON.parse(execute("helm", ["history", options.release, "--namespace", options.namespace, "--output", "json"]));
  const result = reconcileUpgradeIdentity(state, history);
  if (result !== "validate") return result;
  const installed = kubectlHelmRelease(options.release, options.namespace);
  const resources = releaseResources(options.release, options.namespace);
  if (installed?.chart !== `codeops-${lock.chart.version}` || installed?.app_version !== lock.release.sourceSha ||
      !buildSmokeReport(options.release, options.namespace, resources, installed).ok) return "unknown";
  compareImageSets(new Set(state.expectedImages), actualCodeOpsImages(resources));
  sameIdentities(state.before.pvcsBefore, snapshotPreservedPvcs(resources, options.namespace), "PVC");
  sameIdentities(state.before.secretsBefore, snapshotSecrets(policy.requiredSecrets, options.namespace), "Secret");
  for (const check of policy.postDeployHttpChecks ?? []) {
    const response = await fetch(check.url, { redirect: "manual", signal: AbortSignal.timeout(policy.httpTimeoutMs) });
    await response.body?.cancel();
    if (!check.acceptedStatuses.includes(response.status)) return "unknown";
  }
  return "complete";
}

export async function deliverUpgradeEvent(url, event, send = fetch) {
  // The receiver deduplicates eventId and acknowledges only after durable storage.
  // A lost acknowledgement causes the same event, never another deployment.
  const response = await send(url, { method: "POST", redirect: "manual",
    signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json", "idempotency-key": event.eventId },
    body: JSON.stringify(event) });
  if (!response.ok) { await response.body?.cancel(); return false; }
  const bytes = await boundedResponseBytes(response, "notification", 4096);
  return JSON.parse(bytes).eventId === event.eventId;
}

export async function runUpgrade(options, adapters = {}) {
  // Fixed effect boundaries permit credential-free regression tests.
  const targetFor = adapters.target ?? upgradeTarget;
  const verifyRelease = adapters.verify ?? verify;
  const preflight = adapters.preflight ?? upgradePreflight;
  const applyRelease = adapters.deploy ?? deploy;
  const reconcile = adapters.reconcile ?? reconcileUpgrade;
  const getProof = adapters.downloadProof ?? downloadReleaseAsset;
  const deliver = adapters.deliver ?? deliverUpgradeEvent;
  const diagnostics = adapters.diagnostics ?? captureStartup;
  const directory = options.operation_dir && path.resolve(options.operation_dir);
  if (options.status) return upgradeSummary(JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")));
  const [lockBytes, valuesBytes, policyBytes] = await Promise.all([options.lock, options.values, options.policy].map((file) => readFile(file)));
  const lock = validateLock(JSON.parse(lockBytes));
  const policy = validatePolicy(JSON.parse(policyBytes));
  if (options.plan) return { schemaVersion: UPGRADE_SCHEMA, ok: true, status: "planned", stages: UPGRADE_STAGES,
    sourceSha: lock.release.sourceSha, chartDigest: lock.chart.digest,
    valuesSha256: sha256(valuesBytes), policySha256: sha256(policyBytes), release: options.release, namespace: options.namespace };
  const destination = new URL(options.notification_url);
  if (destination.protocol !== "https:" || destination.username || destination.password || destination.search || destination.hash) throw new Error("notification URL must be credential-free HTTPS");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error("operation directory must be private and operator-owned");
  const guard = await open(path.join(directory, "active"), "wx", 0o600);
  let state;
  try {
    await guard.writeFile(`${process.pid}\n`);
    try { state = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (state && !options.resume) throw new Error("existing operation requires --resume");
    if (!state && options.resume) throw new Error("cannot resume missing operation");
    if (!state) {
      state = { schemaVersion: UPGRADE_SCHEMA, operationId: null, status: "preparing", stage: "verify" };
    }
    if (!(state.status === "complete" && state.acknowledged)) {
      // Diagnostics belong to the durable operation, not the host's temporary
      // filesystem. Migrate legacy diagnostics without deleting their originals.
      const previous = state.logDirectory;
      const durable = previous && path.dirname(previous) === directory;
      if (!durable || !await regularFileExists(path.join(previous, "diagnostics.jsonl"))) {
        let history;
        if (previous) {
          const file = path.join(previous, "diagnostics.jsonl");
          if (await regularFileExists(file)) history = await readFile(file);
          else state.diagnosticHistoryMissing = true;
        }
        state.logDirectory = await mkdtemp(path.join(directory, "logs-"));
        await writeFile(path.join(state.logDirectory, "diagnostics.jsonl"), history ?? "", { mode: 0o600 });
      }
      const logStat = await lstat(state.logDirectory);
      if (!logStat.isDirectory() || (logStat.mode & 0o077) !== 0 || logStat.uid !== process.getuid()) throw new Error("diagnostic directory must be private and operator-owned");
      upgradeLog = path.join(state.logDirectory, "diagnostics.jsonl");
      upgradeStream = options.stream === true;
      if (state.diagnosticHistoryMissing) recordUpgradeDiagnostic({ diagnostics: "historical diagnostics unavailable", historyMissing: true });
    }
    // Notification-only recovery must survive a cluster outage. It has no
    // Kubernetes effects and remains bound to the recorded target and inputs.
    const target = state.event ? state.target : targetFor(options);
    const binding = upgradeBinding({ lockBytes, valuesBytes, policyBytes, target, notificationUrl: destination.href });
    if (state.operationId && state.operationId !== binding) throw new Error("operation input or cluster identity drift");
    state.operationId = binding;
    state.target = target;
    await saveUpgrade(directory, state);
    if (state.status === "complete" && state.acknowledged) {
      await rm(state.logDirectory, { recursive: true, force: true });
      return upgradeSummary(state);
    }
    const localOptions = { ...options, values: path.join(directory, "values.yaml"), operationId: binding };
    // Freeze bytes used by both rendering and Helm, rather than rereading the caller's path.
    await writeFile(localOptions.values, valuesBytes, { mode: 0o600 });
    try {
      if (state.before && !state.event) {
        state.status = await reconcile(localOptions, state, lock, policy);
      } else if (!state.event) {
        if (options.stage === "notify") throw new Error("notification requires a terminal effect");
        state.stage = "verify";
        const artifacts = path.join(directory, "artifacts");
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        const cached = state.verified ? { chart_path: path.join(artifacts, lock.chart.asset), manifest_path: path.join(artifacts, lock.release.manifestAsset) } : {};
        const verification = await verifyRelease({ ...localOptions, ...cached }, lock, artifacts);
        const proofPath = path.join(artifacts, "golden-release-report.json");
        if (!await regularFileExists(proofPath)) await getProof(lock, "golden-release-report.json", proofPath);
        const proofBytes = await readFile(proofPath);
        validateUpgradeProof(JSON.parse(proofBytes), lock, verification.prepared.manifest);
        if (state.proofSha256 && state.proofSha256 !== sha256(proofBytes)) throw new Error("qualification evidence drift");
        state.proofSha256 = sha256(proofBytes);
        state.expectedImages = verification.prepared.expectedImages;
        state.verified = true;
        state.status = "verified";
        await saveUpgrade(directory, state);
        if (options.stage === "verify") return upgradeSummary(state);
        state.stage = "preflight";
        await preflight(localOptions, policy, verification);
        state.status = "preflight-passed";
        await saveUpgrade(directory, state);
        if (options.stage === "preflight") return upgradeSummary(state);
        state.stage = "deploy";
        await applyRelease({ ...localOptions, upgradeVerification: verification,
          beforeUpgrade: async (before) => {
            // Repeat prerequisites immediately before the write-ahead intent and cutover.
            if (JSON.stringify(targetFor(localOptions)) !== JSON.stringify(target)) throw new Error("target drift before cutover");
            await preflight(localOptions, policy, verification);
            state.before = before;
            state.status = "unknown";
            await saveUpgrade(directory, state);
          },
        }, lock, policy, artifacts);
        state.status = "complete";
      }
    } catch {
      state.status = state.before ? "unknown" : "failed";
      try { diagnostics(localOptions); } catch { /* Never overwrite the original failure. */ }
      if (state.before) {
        try { state.status = await reconcile(localOptions, state, lock, policy); }
        catch { /* Ambiguous effects stay unknown; never retry Helm here. */ }
      }
    }
    if (["complete", "failed"].includes(state.status) && !state.event) {
      state.event = { schemaVersion: "codeops.upgrade-event/v1", eventId: `${binding}:${state.status}`,
        operationId: binding, status: state.status, sourceSha: lock.release.sourceSha, chartDigest: lock.chart.digest };
      state.acknowledged = false;
    }
    await saveUpgrade(directory, state);
    if (state.event && options.stage !== "deploy") {
      state.stage = "notify";
      for (let attempt = 0; attempt < 3 && !state.acknowledged; attempt += 1) {
        try { state.acknowledged = await deliver(destination.href, state.event); }
        catch { state.acknowledged = false; }
      }
      await saveUpgrade(directory, state);
    }
    if (state.status === "complete" && state.acknowledged) await rm(state.logDirectory, { recursive: true, force: true });
    return upgradeSummary(state);
  } catch (error) {
    // Do not expose provider errors, URLs, input bytes or subprocess output.
    if (state) error.upgradeResult = { schemaVersion: UPGRADE_SCHEMA, ok: false, exitCode: 2,
      status: "request-blocked", operationId: state.operationId, diagnosticPath: state.logDirectory };
    throw error;
  } finally {
    upgradeLog = undefined;
    upgradeStream = false;
    await guard.close();
    await rm(path.join(directory, "active"));
  }
}

export async function run(options) {
  if (options.help) return { help: usage() };
  if (options.command === "upgrade") return runUpgrade(options);
  if (options.command === "smoke") return smoke(options);
  const lock = validateLock(JSON.parse(await readFile(options.lock, "utf8")));
  const policy = options.policy
    ? validatePolicy(JSON.parse(await readFile(options.policy, "utf8")))
    : undefined;
  const ownedDirectory = !options.output_dir;
  const directory = options.output_dir
    ? path.resolve(options.output_dir)
    : await mkdtemp(path.join(tmpdir(), "codeopsctl-"));
  await mkdir(directory, { recursive: true });
  try {
    return options.command === "verify"
      ? await verify(options, lock, directory)
      : await deploy(options, lock, policy, directory);
  } finally {
    if (ownedDirectory) await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await run(options);
  if (result.help) process.stdout.write(result.help);
  else {
    const printable = structuredClone(result);
    if (printable.prepared) delete printable.prepared;
    process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
    if (printable.ok === false) process.exitCode = printable.exitCode ?? 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(process.argv[2] === "upgrade"
      ? `${JSON.stringify(error.upgradeResult ?? { schemaVersion: UPGRADE_SCHEMA, ok: false, status: "invalid-request", exitCode: 2 })}\n`
      : `${formatError(error)}\n`);
    process.exitCode = process.argv[2] === "upgrade" ? 2 : 1;
  });
}
