import { readFile } from "node:fs/promises";
import path from "node:path";
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

const steeringRegistrySchema = z
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
            githubSteeringTokenFile: secretFilePathSchema,
            plane: planeAuthorityReferenceSchema.optional(),
            policy: repositoryPolicyReferenceSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export interface GitHubSteeringRegistry {
  readonly repositories: readonly string[];
  resolve(repository: string): string;
}

async function readBoundedText(
  filePath: string,
  maxBytes: number,
  readTextFile: ReadTextFile,
): Promise<string> {
  const value = await readTextFile(filePath, "utf8");
  const bytes = Buffer.byteLength(value);
  if (bytes === 0 || bytes > maxBytes) {
    throw new Error("repository steering registry file size is invalid");
  }
  return value;
}

function validateToken(value: string): string {
  if (value.length < 32 || value.length > 4_096 || /\s/.test(value)) {
    throw new Error("repository GitHub steering token is invalid");
  }
  return value;
}

function repositoryFromUrl(value: string): string {
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
    throw new Error(
      "repository steering registry requires an exact GitHub HTTPS URL",
    );
  }
  return `${match[1]}/${match[2]}`;
}

export function createGitHubSteeringRegistry(
  entries: readonly {
    readonly repository: string;
    readonly token: string;
  }[],
): GitHubSteeringRegistry {
  if (entries.length === 0 || entries.length > 100) {
    throw new Error(
      "repository steering registry must contain between 1 and 100 repositories",
    );
  }
  const byRepository = new Map<string, string>();
  const tokens = new Set<string>();
  for (const entry of entries) {
    if (!REPOSITORY_IDENTITY.test(entry.repository)) {
      throw new Error("repository steering registry identity is invalid");
    }
    const token = validateToken(entry.token);
    if (byRepository.has(entry.repository) || tokens.has(token)) {
      throw new Error(
        "repository GitHub steering authorities must be repository-scoped",
      );
    }
    byRepository.set(entry.repository, token);
    tokens.add(token);
  }
  return {
    repositories: [...byRepository.keys()],
    resolve(repository) {
      const token = byRepository.get(repository);
      if (token === undefined) {
        throw new Error(
          "repository is not admitted by the GitHub steering registry",
        );
      }
      return token;
    },
  };
}

export async function loadGitHubSteeringRegistryFile(
  filePath: string,
  readTextFile: ReadTextFile = readFile,
): Promise<GitHubSteeringRegistry> {
  const normalizedPath = secretFilePathSchema.parse(filePath);
  const manifest = steeringRegistrySchema.parse(
    JSON.parse(
      await readBoundedText(normalizedPath, MAX_REGISTRY_BYTES, readTextFile),
    ) as unknown,
  );
  const allSecretFiles = new Set<string>();
  for (const entry of manifest.repositories) {
    if (repositoryFromUrl(entry.repositoryUrl) !== entry.repository) {
      throw new Error(
        "repository steering registry URL does not match its identity",
      );
    }
    for (const secretPath of [
      entry.readTokenFile,
      entry.writeTokenFile,
      ...(entry.githubWebhookSecretFile === undefined
        ? []
        : [entry.githubWebhookSecretFile]),
      entry.githubSteeringTokenFile,
      ...(entry.plane === undefined
        ? []
        : [entry.plane.apiKeyFile, entry.plane.webhookSecretFile]),
    ]) {
      if (allSecretFiles.has(secretPath)) {
        throw new Error(
          "repository registry secret files must be repository-scoped",
        );
      }
      allSecretFiles.add(secretPath);
    }
  }
  return createGitHubSteeringRegistry(
    await Promise.all(
      manifest.repositories.map(async (entry) => ({
        repository: entry.repository,
        token: (
          await readBoundedText(
            entry.githubSteeringTokenFile,
            4_098,
            readTextFile,
          )
        ).trim(),
      })),
    ),
  );
}
