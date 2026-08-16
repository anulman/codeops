import { createHash } from "node:crypto";
import type {
  SessionRuntimeDispatch,
  SessionSnapshot,
  WorkspaceLaunch,
  WorkspaceLaunchRequest,
} from "@codeops/codeops-contracts";
import { workspaceLaunchSessionId } from "@codeops/codeops-contracts/workspace-launch";
import {
  failWorkspaceLaunch,
  materializedWorkspaceLaunch,
  provisioningWorkspaceLaunch,
  readyWorkspaceLaunch,
  retryWorkspaceLaunch,
} from "./workspace-launch.js";
import {
  assertWorkspaceResources,
  buildWorkspaceResources,
  type WorkspaceResourceConfig,
} from "./workspace-resources.js";
import {
  workspaceRuntimePodObservations,
  type RuntimeEgressPodObservation,
} from "./runtime-egress-audit.js";

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function workspaceLaunchRuntimeIdentity(launch: WorkspaceLaunch): {
  readonly sessionId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly promptIdempotencyKey: string;
} {
  const sessionId = workspaceLaunchSessionId(launch.launchId);
  const suffix = sessionId.slice("ses_".length);
  return {
    sessionId,
    workflowId: "workspace-launch",
    runId: launch.launchId,
    leaseId: deterministicUuid(`${launch.launchId}:lease`),
    promptIdempotencyKey: deterministicUuid(`${launch.launchId}:prompt`),
  };
}

export interface WorkspaceLaunchControllerDependencies {
  readonly load: (launchId: string) => Promise<{
    readonly launch: WorkspaceLaunch;
    readonly request: WorkspaceLaunchRequest;
  } | null>;
  readonly update: (launch: WorkspaceLaunch) => Promise<WorkspaceLaunch>;
  readonly ensureResource: (
    resource: Record<string, unknown>,
    requestDigest: string,
  ) => Promise<void>;
  readonly loadSession: (
    sessionId: string,
    ownerPrincipalId: string,
  ) => Promise<SessionSnapshot | null>;
  readonly loadJob: (name: string) => Promise<Record<string, unknown>>;
  readonly listRuntimePods: (
    runId: string,
  ) => Promise<readonly Record<string, unknown>[]>;
  readonly recordRuntimePodObservations: (
    observations: readonly RuntimeEgressPodObservation[],
  ) => Promise<void>;
  readonly removeResource: (resource: Record<string, unknown>) => Promise<void>;
  readonly enqueuePrompt: (input: {
    readonly command: Readonly<Record<string, unknown>>;
    readonly principalId: string;
    readonly dispatchId: () => string;
  }) => Promise<SessionRuntimeDispatch>;
  readonly resourceConfig: (
    launch: WorkspaceLaunch,
    identity: ReturnType<typeof workspaceLaunchRuntimeIdentity>,
  ) => WorkspaceResourceConfig;
  readonly now?: () => Date;
}

export class PermanentWorkspaceLaunchError extends Error {}

function resourceRole(resource: Record<string, unknown>): string | undefined {
  return ((resource.metadata as {
    readonly labels?: Readonly<Record<string, unknown>>;
  } | undefined)?.labels?.["codeops.example/resource-role"] as string | undefined);
}

function jobState(job: Record<string, unknown>): "active" | "complete" | "failed" {
  const status = job.status as {
    readonly succeeded?: unknown;
    readonly failed?: unknown;
    readonly conditions?: readonly {
      readonly type?: unknown;
      readonly status?: unknown;
    }[];
  } | undefined;
  if (
    (typeof status?.failed === "number" && status.failed > 0) ||
    status?.conditions?.some(
      (condition) => condition.type === "Failed" && condition.status === "True",
    ) === true
  ) {
    return "failed";
  }
  if (
    (typeof status?.succeeded === "number" && status.succeeded > 0) ||
    status?.conditions?.some(
      (condition) => condition.type === "Complete" && condition.status === "True",
    ) === true
  ) {
    return "complete";
  }
  return "active";
}

export async function reconcileWorkspaceLaunch(
  launchId: string,
  dependencies: WorkspaceLaunchControllerDependencies,
): Promise<WorkspaceLaunch | null> {
  const stored = await dependencies.load(launchId);
  if (stored === null) return null;
  let launch = stored.launch;
  if (launch.state === "ready" || launch.state === "failed") return launch;
  const identity = workspaceLaunchRuntimeIdentity(launch);
  let resources: readonly Record<string, unknown>[];
  try {
    resources = buildWorkspaceResources(
      dependencies.resourceConfig(launch, identity),
    );
    assertWorkspaceResources(resources);
  } catch (error) {
    return dependencies.update(
      failWorkspaceLaunch(launch, "identity-conflict", dependencies.now),
    );
  }
  const sourceSecret = resources.find(
    (resource) => resourceRole(resource) === "source-authority",
  );
  const workspaceStorage = resources.find(
    (resource) => resourceRole(resource) === "workspace-storage",
  );
  const materializerJob = resources.find(
    (resource) => resourceRole(resource) === "source-materializer",
  );
  const runtimeJob = resources.find(
    (resource) => resourceRole(resource) === "workspace-runtime",
  );
  if (!sourceSecret || !workspaceStorage || !materializerJob || !runtimeJob) {
    throw new Error("workspace launch resource roles are incomplete");
  }
  const terminate = async (
    code: Parameters<typeof failWorkspaceLaunch>[1],
  ): Promise<WorkspaceLaunch> => {
    // Keep the launch active until credential cleanup succeeds. A transient
    // Kubernetes failure therefore retries cleanup instead of leaking a
    // credential after the launch becomes terminal.
    await dependencies.removeResource(sourceSecret);
    return dependencies.update(
      failWorkspaceLaunch(launch, code, dependencies.now),
    );
  };
  const retry = async (): Promise<WorkspaceLaunch> => {
    const now = (dependencies.now ?? (() => new Date()))();
    if (now.getTime() >= Date.parse(launch.deadlineAt)) {
      return terminate("provisioning-timeout");
    }
    return dependencies.update(retryWorkspaceLaunch(launch, () => now));
  };

  let failureCode: Parameters<typeof failWorkspaceLaunch>[1] =
    launch.state === "queued" ? "identity-conflict" : "provisioning-failed";
  try {
    if (launch.state === "queued") {
      for (const resource of [sourceSecret, workspaceStorage, materializerJob]) {
        await dependencies.ensureResource(resource, launch.requestDigest);
      }
      launch = await dependencies.update(
        provisioningWorkspaceLaunch(launch, dependencies.now),
      );
      failureCode = "provisioning-failed";
    }

    const session = await dependencies.loadSession(
      identity.sessionId,
      launch.principalId,
    );
    if (session === null) {
      if (launch.materializedAt === undefined) {
        const materializerName = (materializerJob.metadata as { readonly name: string }).name;
        const materializerState = jobState(await dependencies.loadJob(materializerName));
        if (materializerState === "failed") {
          return terminate("provisioning-failed");
        }
        if (materializerState !== "complete") return launch;
        launch = await dependencies.update(
          materializedWorkspaceLaunch(launch, dependencies.now),
        );
      }
      await dependencies.removeResource(sourceSecret);
      await dependencies.removeResource(materializerJob);
      await dependencies.ensureResource(runtimeJob, launch.requestDigest);
      const runtimeName = (runtimeJob.metadata as { readonly name: string }).name;
      if (jobState(await dependencies.loadJob(runtimeName)) === "failed") {
        return terminate("provisioning-failed");
      }
      return launch;
    }

    if (
      session.generation !== 1 ||
      session.lease?.status !== "active" ||
      session.lease.leaseId !== identity.leaseId ||
      !("version" in session.identity) ||
      JSON.stringify(session.identity.policy) !== JSON.stringify(launch.policy) ||
      JSON.stringify(session.identity.contextAttachments ?? []) !==
        JSON.stringify(launch.contextAttachments) ||
      session.identity.displayName !== launch.title ||
      JSON.stringify(session.identity.workspace) !== JSON.stringify(launch.workspace)
    ) {
      throw new PermanentWorkspaceLaunchError(
        "workspace launch session identity drifted from provisioning",
      );
    }
    const runtimeName = (runtimeJob.metadata as { readonly name: string }).name;
    const observedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    await dependencies.recordRuntimePodObservations(
      workspaceRuntimePodObservations({
        pods: await dependencies.listRuntimePods(identity.runId),
        sessionId: session.sessionId,
        generation: session.generation,
        runId: identity.runId,
        jobName: runtimeName,
        observedAt,
      }),
    );
    await dependencies.removeResource(sourceSecret);
    failureCode = "initial-prompt-failed";
    const dispatch = await dependencies.enqueuePrompt({
      principalId: launch.principalId,
      dispatchId: () => deterministicUuid(`${launch.launchId}:dispatch`),
      command: {
        version: "codeops.session-command/v1",
        sessionId: session.sessionId,
        generation: session.generation,
        leaseId: session.lease.leaseId,
        idempotencyKey: identity.promptIdempotencyKey,
        type: "prompt",
        prompt: stored.request.prompt,
        ...(stored.request.contextAttachments === undefined
          ? {}
          : { contextAttachments: stored.request.contextAttachments }),
      },
    });
    if (dispatch.command.idempotencyKey !== identity.promptIdempotencyKey) {
      throw new PermanentWorkspaceLaunchError(
        "workspace initial prompt dispatch identity drifted",
      );
    }
    return dependencies.update(
      readyWorkspaceLaunch(launch, {
        sessionId: session.sessionId,
        initialPromptCommandId: identity.promptIdempotencyKey,
        now: dependencies.now,
      }),
    );
  } catch (error) {
    return error instanceof PermanentWorkspaceLaunchError
      ? terminate(failureCode)
      : retry();
  }
}
