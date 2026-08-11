import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentJobDispatchRequest } from "@codeops/codeops-contracts";
import { z } from "zod";

const REPOSITORY_IDENTITY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REGISTRY_BYTES = 64 * 1_024;

type ReadTextFile = (filePath: string, encoding: "utf8") => Promise<string>;

const secretFilePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      !value.includes("\0"),
    "repository registry secret path must be an exact absolute path",
  );

const planeAuthorityReferenceSchema = z
  .object({
    apiOrigin: z.string().min(1).max(1_024),
    workspaceSlug: z.string().min(1).max(63),
    workspaceId: z.string().uuid(),
    projectId: z.string().uuid(),
    apiKeyFile: secretFilePathSchema,
    webhookSecretFile: secretFilePathSchema,
    stateIds: z
      .object({
        ready: z.string().uuid(),
        inProgress: z.string().uuid(),
        needsAttention: z.string().uuid(),
        complete: z.string().uuid(),
      })
      .strict(),
  })
  .strict();

const repositoryPolicyReferenceSchema = z
  .object({
    githubReviewerIds: z.array(z.number().int().positive()).min(1).max(100),
    planeHumanActorIds: z.array(z.string().uuid()).min(1).max(100),
    planePersonas: z
      .array(
        z
          .object({
            userId: z.string().uuid(),
            handle: z.enum([
              "@ai-web",
              "@ai-security",
              "@ai-database",
              "@ai-infra",
              "@ai-design",
              "@ai-product",
              "@ai-ml",
            ]),
          })
          .strict(),
      )
      .length(7),
    projectContextRoot: secretFilePathSchema,
  })
  .strict();

const repositoryRegistryFileSchema = z
  .object({
    version: z.literal("codeops.repository-registry/v1"),
    repositories: z
      .array(
        z
          .object({
            repository: z.string().regex(REPOSITORY_IDENTITY),
            repositoryUrl: z.string().min(1).max(1_024),
            readTokenFile: secretFilePathSchema,
            writeTokenFile: secretFilePathSchema,
            githubWebhookSecretFile: secretFilePathSchema.optional(),
            githubSteeringTokenFile: secretFilePathSchema.optional(),
            plane: planeAuthorityReferenceSchema.optional(),
            policy: repositoryPolicyReferenceSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export interface RepositoryAuthority {
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly readToken: string;
  readonly writeToken: string;
  readonly githubWebhookSecret?: string;
  readonly githubSteeringToken?: string;
}

export interface RepositoryRegistry {
  readonly repositories: readonly string[];
  resolve(repository: string): RepositoryAuthority;
}

export interface ResolvedRepositoryRoute {
  readonly authority: RepositoryAuthority;
  readonly path: string;
}

export async function loadConfiguredRepositoryRegistry(input: {
  readonly registryFile?: string;
  readonly loadRegistryFile?: (filePath: string) => Promise<RepositoryRegistry>;
  readonly loadLegacy: () => Promise<RepositoryRegistry>;
}): Promise<RepositoryRegistry> {
  const registryFile = input.registryFile?.trim();
  if (registryFile !== undefined && registryFile !== "") {
    return (input.loadRegistryFile ?? loadRepositoryRegistryFile)(registryFile);
  }
  return input.loadLegacy();
}

function parseRepositoryUrl(value: string): string {
  const repositoryUrl = new URL(value);
  const match = repositoryUrl.pathname.match(
    /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/,
  );
  if (
    repositoryUrl.protocol !== "https:" ||
    repositoryUrl.hostname !== "github.com" ||
    repositoryUrl.username !== "" ||
    repositoryUrl.password !== "" ||
    repositoryUrl.search !== "" ||
    repositoryUrl.hash !== "" ||
    match === null
  ) {
    throw new Error("repository registry requires an exact GitHub HTTPS URL");
  }
  return `${match[1]}/${match[2]}`;
}

function validateCredential(value: string, label: string): string {
  if (value.length < 16 || value.length > 4_096 || /\s/.test(value)) {
    throw new Error(`repository registry ${label} is invalid`);
  }
  return value;
}

export function createRepositoryRegistry(
  entries: readonly RepositoryAuthority[],
): RepositoryRegistry {
  if (entries.length === 0 || entries.length > 100) {
    throw new Error(
      "repository registry must contain between 1 and 100 repositories",
    );
  }
  const byRepository = new Map<string, RepositoryAuthority>();
  const credentials = new Set<string>();
  for (const entry of entries) {
    if (!REPOSITORY_IDENTITY.test(entry.repository)) {
      throw new Error("repository registry identity is invalid");
    }
    if (parseRepositoryUrl(entry.repositoryUrl) !== entry.repository) {
      throw new Error("repository registry URL does not match its identity");
    }
    if (byRepository.has(entry.repository)) {
      throw new Error("repository registry identities must be unique");
    }
    const readToken = validateCredential(entry.readToken, "read token");
    const writeToken = validateCredential(entry.writeToken, "write token");
    const githubWebhookSecret =
      entry.githubWebhookSecret === undefined
        ? undefined
        : validateCredential(
            entry.githubWebhookSecret,
            "GitHub webhook secret",
          );
    const githubSteeringToken =
      entry.githubSteeringToken === undefined
        ? undefined
        : validateCredential(
            entry.githubSteeringToken,
            "GitHub steering token",
          );
    const repositoryCredentials = [
      readToken,
      writeToken,
      ...(githubWebhookSecret === undefined ? [] : [githubWebhookSecret]),
      ...(githubSteeringToken === undefined ? [] : [githubSteeringToken]),
    ];
    if (
      new Set(repositoryCredentials).size !== repositoryCredentials.length ||
      repositoryCredentials.some((credential) => credentials.has(credential))
    ) {
      throw new Error(
        "repository registry credentials must be repository-scoped",
      );
    }
    for (const credential of repositoryCredentials) credentials.add(credential);
    byRepository.set(entry.repository, {
      repository: entry.repository,
      repositoryUrl: entry.repositoryUrl,
      readToken,
      writeToken,
      ...(githubWebhookSecret === undefined ? {} : { githubWebhookSecret }),
      ...(githubSteeringToken === undefined ? {} : { githubSteeringToken }),
    });
  }
  return {
    repositories: [...byRepository.keys()],
    resolve(repository) {
      const authority = byRepository.get(repository);
      if (authority === undefined) {
        throw new Error(
          "repository is not admitted by the repository registry",
        );
      }
      return authority;
    },
  };
}

async function readBoundedText(
  filePath: string,
  maxBytes: number,
  readTextFile: ReadTextFile,
): Promise<string> {
  const value = await readTextFile(filePath, "utf8");
  const bytes = Buffer.byteLength(value);
  if (bytes === 0 || bytes > maxBytes) {
    throw new Error("repository registry file size is invalid");
  }
  return value;
}

export async function loadRepositoryRegistryFile(
  filePath: string,
  readTextFile: ReadTextFile = readFile,
): Promise<RepositoryRegistry> {
  const normalizedPath = secretFilePathSchema.parse(filePath);
  const manifest = repositoryRegistryFileSchema.parse(
    JSON.parse(
      await readBoundedText(normalizedPath, MAX_REGISTRY_BYTES, readTextFile),
    ) as unknown,
  );
  const secretFiles = new Set<string>();
  for (const entry of manifest.repositories) {
    const paths = [
      entry.readTokenFile,
      entry.writeTokenFile,
      ...(entry.githubWebhookSecretFile === undefined
        ? []
        : [entry.githubWebhookSecretFile]),
      ...(entry.githubSteeringTokenFile === undefined
        ? []
        : [entry.githubSteeringTokenFile]),
      ...(entry.plane === undefined
        ? []
        : [entry.plane.apiKeyFile, entry.plane.webhookSecretFile]),
    ];
    if (
      entry.readTokenFile === entry.writeTokenFile ||
      new Set(paths).size !== paths.length ||
      paths.some((secretPath) => secretFiles.has(secretPath))
    ) {
      throw new Error(
        "repository registry secret files must be repository-scoped",
      );
    }
    for (const secretPath of paths) secretFiles.add(secretPath);
  }
  return createRepositoryRegistry(
    await Promise.all(
      manifest.repositories.map(async (entry) => ({
        repository: entry.repository,
        repositoryUrl: entry.repositoryUrl,
        readToken: (
          await readBoundedText(entry.readTokenFile, 4_098, readTextFile)
        ).trim(),
        writeToken: (
          await readBoundedText(entry.writeTokenFile, 4_098, readTextFile)
        ).trim(),
        ...(entry.githubWebhookSecretFile === undefined
          ? {}
          : {
              githubWebhookSecret: (
                await readBoundedText(
                  entry.githubWebhookSecretFile,
                  4_098,
                  readTextFile,
                )
              ).trim(),
            }),
        ...(entry.githubSteeringTokenFile === undefined
          ? {}
          : {
              githubSteeringToken: (
                await readBoundedText(
                  entry.githubSteeringTokenFile,
                  4_098,
                  readTextFile,
                )
              ).trim(),
            }),
      })),
    ),
  );
}

export function dispatchRepositoryIdentity(
  request: AgentJobDispatchRequest,
): string {
  const repository =
    request.role === "qa-contract-researcher"
      ? request.researchRequest.repository
      : request.codingRequest.workItem.repository;
  return `${repository.owner}/${repository.name}`;
}

export function resolveRepositoryRoute(
  registry: RepositoryRegistry,
  requestUrl: string | undefined,
): ResolvedRepositoryRoute | null {
  if (requestUrl === undefined) return null;
  const match = requestUrl.match(
    /^\/v1\/repositories\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(\/[^?#]*)$/,
  );
  if (match === null) return null;
  return {
    authority: registry.resolve(`${match[1]}/${match[2]}`),
    path: match[3]!,
  };
}
