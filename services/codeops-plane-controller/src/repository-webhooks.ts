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

const repositoryWebhookRegistrySchema = z
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
            githubWebhookSecretFile: secretFilePathSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export interface GitHubWebhookRegistry {
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
    throw new Error("repository webhook registry file size is invalid");
  }
  return value;
}

function validateSecret(value: string): string {
  if (value.length < 16 || value.length > 4_096 || /\s/.test(value)) {
    throw new Error("repository GitHub webhook secret is invalid");
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
      "repository webhook registry requires an exact GitHub HTTPS URL",
    );
  }
  return `${match[1]}/${match[2]}`;
}

export function createGitHubWebhookRegistry(
  entries: readonly {
    readonly repository: string;
    readonly secret: string;
  }[],
): GitHubWebhookRegistry {
  if (entries.length === 0 || entries.length > 100) {
    throw new Error(
      "repository webhook registry must contain between 1 and 100 repositories",
    );
  }
  const byRepository = new Map<string, string>();
  const secrets = new Set<string>();
  for (const entry of entries) {
    if (!REPOSITORY_IDENTITY.test(entry.repository)) {
      throw new Error("repository webhook registry identity is invalid");
    }
    const secret = validateSecret(entry.secret);
    if (byRepository.has(entry.repository) || secrets.has(secret)) {
      throw new Error(
        "repository GitHub webhook authorities must be repository-scoped",
      );
    }
    byRepository.set(entry.repository, secret);
    secrets.add(secret);
  }
  return {
    repositories: [...byRepository.keys()],
    resolve(repository) {
      const secret = byRepository.get(repository);
      if (secret === undefined) {
        throw new Error(
          "repository is not admitted by the GitHub webhook registry",
        );
      }
      return secret;
    },
  };
}

export async function loadGitHubWebhookRegistryFile(
  filePath: string,
  readTextFile: ReadTextFile = readFile,
): Promise<GitHubWebhookRegistry> {
  const normalizedPath = secretFilePathSchema.parse(filePath);
  const manifest = repositoryWebhookRegistrySchema.parse(
    JSON.parse(
      await readBoundedText(
        normalizedPath,
        MAX_REGISTRY_BYTES,
        readTextFile,
      ),
    ) as unknown,
  );
  const allSecretFiles = new Set<string>();
  for (const entry of manifest.repositories) {
    if (repositoryFromUrl(entry.repositoryUrl) !== entry.repository) {
      throw new Error(
        "repository webhook registry URL does not match its identity",
      );
    }
    for (const secretPath of [
      entry.readTokenFile,
      entry.writeTokenFile,
      entry.githubWebhookSecretFile,
    ]) {
      if (allSecretFiles.has(secretPath)) {
        throw new Error(
          "repository registry secret files must be repository-scoped",
        );
      }
      allSecretFiles.add(secretPath);
    }
  }
  return createGitHubWebhookRegistry(
    await Promise.all(
      manifest.repositories.map(async (entry) => ({
        repository: entry.repository,
        secret: (
          await readBoundedText(
            entry.githubWebhookSecretFile,
            4_098,
            readTextFile,
          )
        ).trim(),
      })),
    ),
  );
}
