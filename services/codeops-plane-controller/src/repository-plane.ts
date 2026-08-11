import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const REPOSITORY_IDENTITY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_REGISTRY_BYTES = 64 * 1_024;
const uuid = z.string().uuid();
const personaHandle = z.enum([
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
]);

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

const planeAuthoritySchema = z
  .object({
    apiOrigin: z.string().min(1).max(1_024),
    workspaceSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    workspaceId: uuid,
    projectId: uuid,
    apiKeyFile: secretFilePathSchema,
    webhookSecretFile: secretFilePathSchema,
    stateIds: z
      .object({
        ready: uuid,
        inProgress: uuid,
        needsAttention: uuid,
        complete: uuid,
      })
      .strict(),
  })
  .strict();

const repositoryPolicySchema = z
  .object({
    githubReviewerIds: z.array(z.number().int().positive()).min(1).max(100),
    planeHumanActorIds: z.array(uuid).min(1).max(100),
    planePersonas: z
      .array(
        z
          .object({
            userId: uuid,
            handle: personaHandle,
          })
          .strict(),
      )
      .length(7),
    projectContextRoot: secretFilePathSchema,
  })
  .strict();

const planeRegistrySchema = z
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
            plane: planeAuthoritySchema,
            policy: repositoryPolicySchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export interface RepositoryPlaneAuthority {
  readonly repository: string;
  readonly apiOrigin: string;
  readonly workspaceSlug: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly stateIds: {
    readonly ready: string;
    readonly inProgress: string;
    readonly needsAttention: string;
    readonly complete: string;
  };
  readonly policy: {
    readonly githubReviewerIds: readonly number[];
    readonly planeHumanActorIds: readonly string[];
    readonly planePersonas: readonly {
      readonly userId: string;
      readonly handle: z.infer<typeof personaHandle>;
    }[];
    readonly projectContextRoot: string;
  };
}

export interface RepositoryPlaneRegistry {
  readonly repositories: readonly string[];
  resolve(repository: string): RepositoryPlaneAuthority;
  resolveProject(projectId: string): RepositoryPlaneAuthority;
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
      "repository Plane registry requires an exact GitHub HTTPS URL",
    );
  }
  return `${match[1]}/${match[2]}`;
}

function planeOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(
      "repository Plane API origin must be credential-free HTTPS",
    );
  }
  return origin.href;
}

function credential(value: string, label: string): string {
  if (value.length < 16 || value.length > 4_096 || /\s/.test(value)) {
    throw new Error(`repository Plane ${label} is invalid`);
  }
  return value;
}

export function createRepositoryPlaneRegistry(
  entries: readonly RepositoryPlaneAuthority[],
): RepositoryPlaneRegistry {
  if (entries.length === 0 || entries.length > 100) {
    throw new Error(
      "repository Plane registry must contain 1 to 100 repositories",
    );
  }
  const byRepository = new Map<string, RepositoryPlaneAuthority>();
  const byProject = new Map<string, RepositoryPlaneAuthority>();
  const secrets = new Set<string>();
  const contextRoots = new Set<string>();
  for (const entry of entries) {
    if (!REPOSITORY_IDENTITY.test(entry.repository)) {
      throw new Error("repository Plane registry identity is invalid");
    }
    const apiKey = credential(entry.apiKey, "API key");
    const webhookSecret = credential(entry.webhookSecret, "webhook secret");
    const stateIds = Object.values(entry.stateIds).map((id) => uuid.parse(id));
    const githubReviewerIds = entry.policy.githubReviewerIds.map((id) =>
      z.number().int().positive().parse(id),
    );
    const planeHumanActorIds = entry.policy.planeHumanActorIds.map((id) =>
      uuid.parse(id),
    );
    const planePersonas = entry.policy.planePersonas.map((persona) => ({
      userId: uuid.parse(persona.userId),
      handle: personaHandle.parse(persona.handle),
    }));
    const projectContextRoot = secretFilePathSchema.parse(
      entry.policy.projectContextRoot,
    );
    if (
      byRepository.has(entry.repository) ||
      byProject.has(uuid.parse(entry.projectId)) ||
      secrets.has(apiKey) ||
      secrets.has(webhookSecret) ||
      apiKey === webhookSecret ||
      new Set(stateIds).size !== stateIds.length ||
      new Set(githubReviewerIds).size !== githubReviewerIds.length ||
      new Set(planeHumanActorIds).size !== planeHumanActorIds.length ||
      planePersonas.length !== 7 ||
      new Set(planePersonas.map(({ userId }) => userId)).size !== 7 ||
      new Set(planePersonas.map(({ handle }) => handle)).size !== 7 ||
      contextRoots.has(projectContextRoot)
    ) {
      throw new Error("repository Plane authorities must be repository-scoped");
    }
    const authority = {
      ...entry,
      apiOrigin: planeOrigin(entry.apiOrigin),
      workspaceId: uuid.parse(entry.workspaceId),
      projectId: uuid.parse(entry.projectId),
      apiKey,
      webhookSecret,
      policy: {
        githubReviewerIds,
        planeHumanActorIds,
        planePersonas,
        projectContextRoot,
      },
    };
    byRepository.set(entry.repository, authority);
    byProject.set(authority.projectId, authority);
    secrets.add(apiKey);
    secrets.add(webhookSecret);
    contextRoots.add(projectContextRoot);
  }
  return {
    repositories: [...byRepository.keys()],
    resolve(repository) {
      const authority = byRepository.get(repository);
      if (authority === undefined) {
        throw new Error("repository is not admitted by the Plane registry");
      }
      return authority;
    },
    resolveProject(projectId) {
      const authority = byProject.get(projectId);
      if (authority === undefined) {
        throw new Error(
          "Plane project is not admitted by the repository registry",
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
    throw new Error("repository Plane registry file size is invalid");
  }
  return value;
}

export async function loadRepositoryPlaneRegistryFile(
  filePath: string,
  readTextFile: ReadTextFile = readFile,
): Promise<RepositoryPlaneRegistry> {
  const normalizedPath = secretFilePathSchema.parse(filePath);
  const manifest = planeRegistrySchema.parse(
    JSON.parse(
      await readBoundedText(normalizedPath, MAX_REGISTRY_BYTES, readTextFile),
    ) as unknown,
  );
  const secretFiles = new Set<string>();
  for (const entry of manifest.repositories) {
    if (repositoryFromUrl(entry.repositoryUrl) !== entry.repository) {
      throw new Error(
        "repository Plane registry URL does not match its identity",
      );
    }
    const paths = [
      entry.readTokenFile,
      entry.writeTokenFile,
      ...(entry.githubWebhookSecretFile === undefined
        ? []
        : [entry.githubWebhookSecretFile]),
      ...(entry.githubSteeringTokenFile === undefined
        ? []
        : [entry.githubSteeringTokenFile]),
      entry.plane.apiKeyFile,
      entry.plane.webhookSecretFile,
    ];
    if (
      new Set(paths).size !== paths.length ||
      paths.some((secretPath) => secretFiles.has(secretPath))
    ) {
      throw new Error(
        "repository registry secret files must be repository-scoped",
      );
    }
    for (const secretPath of paths) secretFiles.add(secretPath);
  }
  return createRepositoryPlaneRegistry(
    await Promise.all(
      manifest.repositories.map(async (entry) => ({
        repository: entry.repository,
        apiOrigin: entry.plane.apiOrigin,
        workspaceSlug: entry.plane.workspaceSlug,
        workspaceId: entry.plane.workspaceId,
        projectId: entry.plane.projectId,
        apiKey: (
          await readBoundedText(entry.plane.apiKeyFile, 4_098, readTextFile)
        ).trim(),
        webhookSecret: (
          await readBoundedText(
            entry.plane.webhookSecretFile,
            4_098,
            readTextFile,
          )
        ).trim(),
        stateIds: entry.plane.stateIds,
        policy: entry.policy,
      })),
    ),
  );
}
