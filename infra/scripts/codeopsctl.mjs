#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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

The verify and deploy commands emit ${EVIDENCE_SCHEMA} JSON.
The smoke command emits ${SMOKE_SCHEMA} JSON.
`;
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command || !["verify", "deploy", "smoke"].includes(command)) {
    throw new Error("command must be verify, deploy, or smoke");
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
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
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
  if (command !== "smoke") {
    if (!options.lock) throw new Error("--lock is required");
    if (!options.values) throw new Error("--values is required");
  }
  if (command === "deploy" && !options.policy) {
    throw new Error("--policy is required for deploy");
  }
  return options;
}

function execute(name, args, { env = process.env, input, timeout = 120_000 } = {}) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    env,
    input,
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
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
  if (!/^v\d+\.\d+\.\d+$/.test(lock.release.tag)) throw new Error("release tag must be exact SemVer");
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
  if (options.manifest_path) await copyFile(options.manifest_path, manifestPath);
  else await downloadReleaseAsset(lock, lock.release.manifestAsset, manifestPath);

  let pulledDigest = lock.chart.digest;
  if (options.chart_path) {
    await copyFile(options.chart_path, chartPath);
  } else {
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
  execute("helm", ["lint", prepared.chartPath, "--values", options.values]);
  const rendered = execute("helm", [
    "template",
    options.release,
    prepared.chartPath,
    "--namespace",
    options.namespace,
    "--values",
    options.values,
  ]);
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

async function deploy(options, lock, policy, directory) {
  const verification = await verify(options, lock, directory);
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
  const pvcsBefore = snapshotPvcs(beforeResources);
  const secretsBefore = snapshotSecrets(policy.requiredSecrets, options.namespace);
  execute(
    "helm",
    [
      "upgrade",
      "--install",
      options.release,
      verification.prepared.chartPath,
      "--namespace",
      options.namespace,
      "--create-namespace",
      "--values",
      options.values,
      "--atomic",
      "--wait",
      "--wait-for-jobs",
      "--timeout",
      policy.helmTimeout,
    ],
    { timeout: durationMilliseconds(policy.helmTimeout) + 5 * 60_000 },
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
    sameIdentities(pvcsBefore, snapshotPvcs(afterResources), "PVC");
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
    try {
      for (const [name, args] of buildCompensatingRollbackPlan({
        release: options.release,
        namespace: options.namespace,
        previousRelease,
        namespaceExisted,
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
        sameIdentities(pvcsBefore, snapshotPvcs(restoredResources), "rollback PVC");
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

export async function run(options) {
  if (options.help) return { help: usage() };
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
    if (printable.ok === false) process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
