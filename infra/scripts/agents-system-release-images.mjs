import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const requiredImages = {
  agents_ui: "codeops-agents-ui",
  gateway: "codeops-session-control-gateway",
  github_controller: "codeops-plane-controller",
  postgresql: "postgres",
  runtime_worker: "codeops-session-runtime-worker",
  runtime_agent: "codeops-agent",
};

export async function resolveAgentsSystemReleaseImages(plan, inspect) {
  const services = new Map((plan.services ?? []).map((service) => [service.name, service]));
  const resolved = {};
  for (const [key, name] of Object.entries(requiredImages)) {
    const service = services.get(name);
    if (
      !service ||
      typeof service.image !== "string" ||
      typeof service.inputRef !== "string" ||
      !service.image.startsWith("ghcr.io/anulman/renoconcierge/") ||
      !service.inputRef.startsWith(`${service.image}:input-`)
    ) {
      throw new Error(`release image plan is missing trusted ${name}`);
    }
    const descriptor = await inspect(service.inputRef);
    if (!DIGEST.test(descriptor?.digest ?? "")) {
      throw new Error(`${name} did not resolve to one lowercase SHA-256 digest`);
    }
    resolved[key] = {
      name,
      repository: service.image,
      sourceRef: service.inputRef,
      digest: descriptor.digest,
      immutableRef: `${service.image}@${descriptor.digest}`,
    };
  }
  return { version: "agents-system-release-images/v1", images: resolved };
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
  const planPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!planPath || !outputPath) throw new Error("usage: agents-system-release-images.mjs <image-plan.json> <output.json>");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const result = await resolveAgentsSystemReleaseImages(plan, inspectRegistry);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
