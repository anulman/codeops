import { createHash, randomUUID } from "node:crypto";
import {
  workspaceLaunchRequestSchema,
  workspaceLaunchSchema,
  workspaceManifestSchema,
  type WorkspaceLaunch,
  type WorkspaceLaunchRequest,
  type WorkspaceManifest,
  type WorkspaceSource,
} from "@codeops/codeops-contracts";

const MAX_ACTIVE_PER_PRINCIPAL = 2;
const MAX_ACTIVE_GLOBAL = 8;

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function launchId(principalId: string, idempotencyKey: string): string {
  return `launch-${createHash("sha256")
    .update(canonical({ principalId, idempotencyKey }))
    .digest("hex")
    .slice(0, 24)}`;
}

export interface WorkspaceSourceResolver {
  resolve(catalogKey: string): Promise<WorkspaceSource>;
}

export interface WorkspaceLaunchStore {
  findByIdempotencyKey(
    principalId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceLaunch | null>;
  admit(input: {
    readonly launch: WorkspaceLaunch;
    readonly request: WorkspaceLaunchRequest;
    readonly maximumActivePerPrincipal: number;
    readonly maximumActiveGlobal: number;
  }): Promise<WorkspaceLaunch>;
}

export class WorkspaceLaunchConflictError extends Error {}
export class WorkspaceLaunchQuotaError extends Error {}
export class InvalidWorkspaceLaunchInputError extends Error {}

export async function admitWorkspaceLaunch(input: {
  readonly request: unknown;
  readonly principalId: string;
  readonly resolver: WorkspaceSourceResolver;
  readonly store: WorkspaceLaunchStore;
  readonly now?: () => Date;
}): Promise<WorkspaceLaunch> {
  const request = workspaceLaunchRequestSchema.parse(input.request);
  const principalId = input.principalId.trim();
  if (
    principalId.length < 3 ||
    principalId.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(principalId)
  ) {
    throw new Error("workspace launch principal is invalid");
  }
  const requestDigest = digest(request);
  const existing = await input.store.findByIdempotencyKey(
    principalId,
    request.idempotencyKey,
  );
  if (existing !== null) {
    if (existing.requestDigest !== requestDigest) {
      throw new WorkspaceLaunchConflictError(
        "workspace launch idempotency key belongs to another request",
      );
    }
    return existing;
  }
  const sources = await Promise.all(
    request.sources.map(({ catalogKey }) => input.resolver.resolve(catalogKey)),
  );
  const workspace = workspaceManifestSchema.parse({
    version: "codeops.workspace/v1",
    sources,
    scratchPath: "scratch",
  } satisfies WorkspaceManifest);
  const occurredAt = (input.now ?? (() => new Date()))().toISOString();
  const deadlineAt = new Date(
    Date.parse(occurredAt) + 6 * 60 * 60_000,
  ).toISOString();
  const launch = workspaceLaunchSchema.parse({
    version: "codeops.workspace-launch/v1",
    launchId: launchId(principalId, request.idempotencyKey),
    idempotencyKey: request.idempotencyKey,
    principalId,
    requestDigest,
    ...(request.title === undefined ? {} : { title: request.title }),
    promptDigest: digest(request.prompt),
    workspace,
    state: "queued",
    deadlineAt,
    attemptCount: 0,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
  return input.store.admit({
    launch,
    request,
    maximumActivePerPrincipal: MAX_ACTIVE_PER_PRINCIPAL,
    maximumActiveGlobal: MAX_ACTIVE_GLOBAL,
  });
}

export function createCatalogSourceResolver(input: {
  readonly entries: ReadonlyMap<
    string,
    {
      readonly repository: string;
      readonly defaultRef: string;
    }
  >;
  readonly resolveHead: (repository: string, reference: string) => Promise<string>;
}): WorkspaceSourceResolver {
  return {
    async resolve(catalogKey) {
      const entry = input.entries.get(catalogKey);
      if (entry === undefined) {
        throw new InvalidWorkspaceLaunchInputError(
          "workspace source is not admitted by the catalog",
        );
      }
      const resolvedSha = await input.resolveHead(
        entry.repository,
        entry.defaultRef,
      );
      return {
        catalogKey,
        repository: entry.repository,
        checkoutPath: `sources/${catalogKey}`,
        requestedRef: entry.defaultRef,
        resolvedSha,
      };
    },
  };
}

export function readyWorkspaceLaunch(
  launch: WorkspaceLaunch,
  input: {
    readonly sessionId: string;
    readonly initialPromptCommandId?: string;
    readonly now?: () => Date;
  },
): WorkspaceLaunch {
  if (launch.state !== "queued" && launch.state !== "provisioning") {
    throw new Error("only an active workspace launch can become ready");
  }
  return workspaceLaunchSchema.parse({
    ...launch,
    state: "ready",
    sessionId: input.sessionId,
    initialPromptCommandId: input.initialPromptCommandId ?? randomUUID(),
    nextAttemptAt: undefined,
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
}

export function provisioningWorkspaceLaunch(
  launch: WorkspaceLaunch,
  now: () => Date = () => new Date(),
): WorkspaceLaunch {
  if (launch.state !== "queued") {
    throw new Error("only a queued workspace launch can start provisioning");
  }
  return workspaceLaunchSchema.parse({
    ...launch,
    state: "provisioning",
    nextAttemptAt: undefined,
    updatedAt: now().toISOString(),
  });
}

export function failWorkspaceLaunch(
  launch: WorkspaceLaunch,
  failureCode:
    | "invalid-source"
    | "source-unavailable"
    | "quota-exceeded"
    | "provisioning-failed"
    | "provisioning-timeout"
    | "identity-conflict"
    | "initial-prompt-failed",
  now: () => Date = () => new Date(),
): WorkspaceLaunch {
  if (launch.state !== "queued" && launch.state !== "provisioning") {
    throw new Error("only an active workspace launch can fail");
  }
  return workspaceLaunchSchema.parse({
    ...launch,
    state: "failed",
    failureCode,
    nextAttemptAt: undefined,
    updatedAt: now().toISOString(),
  });
}

export function retryWorkspaceLaunch(
  launch: WorkspaceLaunch,
  now: () => Date = () => new Date(),
): WorkspaceLaunch {
  if (launch.state !== "queued" && launch.state !== "provisioning") {
    throw new Error("only an active workspace launch can retry");
  }
  const occurredAt = now();
  const attemptCount = launch.attemptCount + 1;
  const delayMs = Math.min(60_000, 2_000 * 2 ** Math.min(attemptCount - 1, 5));
  return workspaceLaunchSchema.parse({
    ...launch,
    attemptCount,
    nextAttemptAt: new Date(occurredAt.getTime() + delayMs).toISOString(),
    updatedAt: occurredAt.toISOString(),
  });
}

export function materializedWorkspaceLaunch(
  launch: WorkspaceLaunch,
  now: () => Date = () => new Date(),
): WorkspaceLaunch {
  if (launch.state !== "provisioning") {
    throw new Error("only a provisioning workspace launch can be materialized");
  }
  const occurredAt = now().toISOString();
  return workspaceLaunchSchema.parse({
    ...launch,
    materializedAt: occurredAt,
    nextAttemptAt: undefined,
    updatedAt: occurredAt,
  });
}
