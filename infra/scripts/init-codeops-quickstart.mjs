#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stringify } from "yaml";

function argumentsFor(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || !argv[index + 1]) throw new Error(`invalid argument: ${key}`);
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function discover(args, fallback = "") {
  try {
    return execFileSync(args[0], args.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return fallback;
  }
}

function credential(input, name) {
  const environmentName = input.credentialEnvironment?.[name];
  const value = environmentName ? process.env[environmentName]?.trim() : "";
  if (!value || value.length < 16 || /\s/.test(value)) {
    throw new Error(`required credential environment variable is missing or invalid: ${environmentName ?? name}`);
  }
  return value;
}

function repositoryFromGit() {
  const remote = discover(["git", "remote", "get-url", "origin"]);
  const match = remote.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : "";
}

function uuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value ?? "")) {
    throw new Error(`${label} must be one lowercase UUID`);
  }
  return value;
}

const args = argumentsFor(process.argv.slice(2));
if (!args.input || !args.output) throw new Error("usage: init-codeops-quickstart --input <json> --output <yaml>");
const input = JSON.parse(await readFile(resolve(args.input), "utf8"));
const output = resolve(args.output);
const repository = input.repository || repositoryFromGit();
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must be owner/name");
if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/?$/.test(input.accessIssuer ?? "")) throw new Error("accessIssuer must be one Cloudflare Access team-domain origin");
if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(input.host ?? "")) throw new Error("host must be one lowercase DNS host");
if (!Array.isArray(input.operatorEmails) || input.operatorEmails.length === 0 || input.operatorEmails.some((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) throw new Error("operatorEmails must contain at least one email address");

const reviewerIds = input.githubReviewerIds?.length
  ? input.githubReviewerIds
  : [Number(discover(["gh", "api", "user", "--jq", ".id"]))].filter(Number.isSafeInteger);
if (reviewerIds.length === 0 || reviewerIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
  throw new Error("githubReviewerIds must contain a positive numeric GitHub user ID");
}
const apiCidrs = input.kubernetesApiCidrs?.length
  ? input.kubernetesApiCidrs
  : [`${discover(["kubectl", "get", "service", "kubernetes", "-o", "jsonpath={.spec.clusterIP}"])}/32`];
if (apiCidrs.some((cidr) => !/^\d+(?:\.\d+){3}\/\d+$/.test(cidr))) throw new Error("kubernetesApiCidrs are missing or invalid");

const contextRoot = resolve(input.contextRoot);
const documents = {};
for (const name of ["AGENTS.md", "CURRENT-STATE.md", "DECISIONS.md", "DOMAIN.md", "PRODUCT.md", "SOUL.md", "SOURCE-MAP.md"]) {
  documents[name] = await readFile(resolve(contextRoot, name), "utf8");
}
const plane = input.plane ?? {};
if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/?$/.test(plane.apiOrigin ?? "")) throw new Error("plane.apiOrigin must be one HTTPS origin");
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(plane.workspaceSlug ?? "")) throw new Error("plane.workspaceSlug must be one slug");
for (const [name, value] of Object.entries({ workspaceId: plane.workspaceId, projectId: plane.projectId, ...plane.stateIds })) uuid(value, `plane.${name}`);
for (const value of plane.humanActorIds ?? []) uuid(value, "plane.humanActorIds");
for (const persona of plane.personas ?? []) uuid(persona.userId, `plane.personas.${persona.handle}`);
if ((plane.personas ?? []).length !== 7) throw new Error("plane.personas must contain seven entries");
const personaHandles = (plane.personas ?? []).map(({ handle }) => handle);
const expectedHandles = ["@ai-web", "@ai-security", "@ai-database", "@ai-infra", "@ai-design", "@ai-product", "@ai-ml"];
if (new Set(personaHandles).size !== 7 || expectedHandles.some((handle) => !personaHandles.includes(handle))) throw new Error("plane.personas must contain every supported handle exactly once");

const values = {
  profile: "custom",
  agentsUi: { access: { issuer: input.accessIssuer } },
  ingress: { host: input.host },
  controlGateway: { kubernetesApiCidrs: apiCidrs },
  plane: {
    enabled: false,
    deployment: "external",
    adapter: { enabled: true, onboardingRequired: false },
    apiOrigin: plane.apiOrigin,
  },
  quickstart: {
    enabled: true,
    openaiApiKey: credential(input, "openai"),
    registry: { enabled: false },
    access: { audience: credential(input, "accessAudience"), allowedEmails: input.operatorEmails },
    repository: {
      identity: repository,
      github: {
        readToken: credential(input, "githubRead"),
        writeToken: credential(input, "githubWrite"),
        webhookSecret: credential(input, "githubWebhook"),
        reviewerIds: reviewerIds.map(Number),
      },
      plane: {
        ...plane,
        apiKey: credential(input, "planeApi"),
        webhookSecret: credential(input, "planeWebhook"),
      },
      context: {
        directory: repository.split("/")[1].toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        agents: documents["AGENTS.md"],
        currentState: documents["CURRENT-STATE.md"],
        decisions: documents["DECISIONS.md"],
        domain: documents["DOMAIN.md"],
        product: documents["PRODUCT.md"],
        soul: documents["SOUL.md"],
        sourceMap: documents["SOURCE-MAP.md"],
      },
    },
  },
};

await writeFile(output, stringify(values, { lineWidth: 0 }), { encoding: "utf8", flag: "wx", mode: 0o600 });
await chmod(output, 0o600);
process.stdout.write(`created private quickstart values: ${output}\n`);
