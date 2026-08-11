import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const imageNames = [
  "agent",
  "agents-ui",
  "control-gateway",
  "model-proxy",
  "orchestrator",
  "plane-controller",
  "session-control-gateway",
  "session-gateway",
  "session-runtime-worker",
];

const valuePaths = {
  agent: ["runtime", "agentImage"],
  "agents-ui": ["agentsUi", "image"],
  "control-gateway": ["controlGateway", "image"],
  "model-proxy": ["modelProxy", "image"],
  orchestrator: ["orchestrator", "image"],
  "plane-controller": ["githubController", "image"],
  "session-control-gateway": ["gateway", "image"],
  "session-gateway": ["runtime", "sessionGatewayImage"],
  "session-runtime-worker": ["runtime", "workerImage"],
};

function setPath(target, path, value) {
  let cursor = target;
  for (const part of path.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[path.at(-1)] = value;
}

export async function resolveCodeOpsReleaseImages(plan, inspect) {
  if (plan?.version !== "codeops.image-publication-plan/v1" || !SHA.test(plan.sourceSha ?? "")) {
    throw new Error("release image plan identity is invalid");
  }
  if (plan?.upstream?.postgresql?.repository !== "postgres" || !DIGEST.test(plan.upstream.postgresql.digest ?? "")) {
    throw new Error("release image plan must pin the PostgreSQL digest");
  }
  const services = new Map();
  for (const service of plan.services ?? []) {
    if (services.has(service?.name)) throw new Error("release image plan contains a duplicate operand");
    services.set(service?.name, service);
  }
  if (services.size !== imageNames.length) throw new Error("release image plan operand count is invalid");

  const images = {};
  const values = {};
  for (const name of imageNames) {
    const repository = `ghcr.io/anulman/codeops/${name}`;
    const sourceRef = `${repository}:sha-${plan.sourceSha}`;
    const service = services.get(name);
    if (service?.repository !== repository || service?.sourceRef !== sourceRef) {
      throw new Error(`release image plan is missing trusted ${name}`);
    }
    const descriptor = await inspect(sourceRef);
    if (!DIGEST.test(descriptor?.digest ?? "")) {
      throw new Error(`${name} did not resolve to one lowercase SHA-256 digest`);
    }
    images[name] = {
      repository,
      sourceRef,
      digest: descriptor.digest,
      immutableRef: `${repository}@${descriptor.digest}`,
    };
    setPath(values, valuePaths[name], { repository, digest: descriptor.digest });
    if (name === "control-gateway") {
      setPath(values, ["lifecycleRelay", "image"], {
        repository,
        digest: descriptor.digest,
      });
    }
  }
  values.postgresql = { image: plan.upstream.postgresql };
  values.githubController ??= {};
  values.githubController.controlPlaneSha = plan.sourceSha;
  return { version: "codeops.release-images/v1", sourceSha: plan.sourceSha, images, values };
}

function inspectRegistry(ref) {
  const output = execFileSync(
    "docker",
    ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(output);
}

async function main() {
  const [planPath, manifestPath, valuesPath] = process.argv.slice(2);
  if (!planPath || !manifestPath || !valuesPath) {
    throw new Error("usage: codeops-release-images.mjs <plan.json> <manifest.json> <values.yaml>");
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const result = await resolveCodeOpsReleaseImages(plan, inspectRegistry);
  await writeFile(manifestPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  await writeFile(valuesPath, stringify(result.values), { flag: "wx" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
