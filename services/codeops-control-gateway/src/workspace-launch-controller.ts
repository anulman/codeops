import { createHash } from "node:crypto";
import type {
  SessionRuntimeDispatch,
  SessionSnapshot,
  WorkspaceLaunch,
  WorkspaceLaunchRequest,
} from "@codeops/codeops-contracts";
import { workspaceLaunchSessionId } from "@codeops/codeops-contracts/workspace-launch";
import {
  bindWorkspaceLaunchRuntime,
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
  RuntimeWorkerImageDriftError,
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
  if (launch.retryRuntime !== undefined) return launch.retryRuntime;
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
    expectedUid?: string,
    expectedConfigDigest?: string,
  ) => Promise<{ readonly uid: string; readonly configDigest: string }>;
  readonly recoverResource?: (
    resource: Record<string, unknown>, requestDigest: string,
  ) => Promise<{ readonly uid: string; readonly configDigest: string;
    readonly resourceName?: string; readonly matchesExpectedConfiguration: boolean;
    readonly desiredConfigDigest?: string } | null>;
  readonly readResourceUid: (resource: Record<string, unknown>) => Promise<string | null>;
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
  readonly removeResource: (resource: Record<string, unknown>, requestDigest: string,
    expectedUid: string, expectedConfigDigest: string) => Promise<void>;
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

export class WorkspaceRuntimeWorkerImageDriftError extends PermanentWorkspaceLaunchError {}

export function workspaceLaunchRuntimeWorkerImage(
  launch: WorkspaceLaunch,
  configuredRuntimeWorkerImage: string,
): string {
  const stored = launch.retryRuntime?.runtimeWorkerImage;
  if (stored !== undefined && stored !== configuredRuntimeWorkerImage) {
    throw new WorkspaceRuntimeWorkerImageDriftError(
      "workspace retry runtime worker image drifted from live configuration",
    );
  }
  return stored ?? configuredRuntimeWorkerImage;
}

function resourceRole(resource: Record<string, unknown>): string | undefined {
  return ((resource.metadata as {
    readonly labels?: Readonly<Record<string, unknown>>;
  } | undefined)?.labels?.["codeops.example/resource-role"] as string | undefined);
}

function cleanupResourceIdentity(resource: Record<string, unknown>): Record<string, unknown> {
  return resource.kind === "Secret" ? { apiVersion: resource.apiVersion, kind: resource.kind,
    metadata: structuredClone(resource.metadata) } : resource;
}

type WorkspaceResourceKey = "sourceAuthority" | "workspaceStorage" |
  "sourceMaterializer" | "workspaceRuntime";

function workspaceResourceKey(resource: Record<string, unknown>): WorkspaceResourceKey {
  const keys: Record<string, WorkspaceResourceKey> = {
    "source-authority": "sourceAuthority",
    "workspace-storage": "workspaceStorage",
    "source-materializer": "sourceMaterializer",
    "workspace-runtime": "workspaceRuntime",
  };
  const key = keys[resourceRole(resource) ?? ""];
  if (key === undefined) throw new Error("workspace launch resource role is invalid");
  return key;
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
  let resourceConfig: WorkspaceResourceConfig;
  let resources: readonly Record<string, unknown>[];
  try {
    resourceConfig = dependencies.resourceConfig(launch, identity);
    launch = await dependencies.update(bindWorkspaceLaunchRuntime(
      launch,
      resourceConfig.runtimeLaunchBinding,
      dependencies.now,
      resourceConfig.runtimeRequirements,
    ));
    resources = buildWorkspaceResources(resourceConfig);
    assertWorkspaceResources(resources, resourceConfig.modelProxyServiceName);
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
  const ensureBound = async (resource: Record<string, unknown>) => {
    const key = workspaceResourceKey(resource);
    const continueSecretReplacement = async () => {
      const replacement = key === "sourceAuthority"
        ? launch.resourceReplacements?.sourceAuthority : undefined;
      if (replacement === undefined) return undefined;
      const oldBinding = launch.resourceBindings?.sourceAuthority;
      if (resource.kind !== "Secret" || oldBinding === undefined ||
          oldBinding.uid !== replacement.uid ||
          oldBinding.configDigest !== replacement.configDigest ||
          (oldBinding.resourceName ??
            (resource.metadata as { readonly name: string }).name) !== replacement.resourceName) {
        throw new PermanentWorkspaceLaunchError(
          "durable workspace Secret replacement binding drifted",
        );
      }
      const cleanupIdentity = cleanupResourceIdentity(resource);
      const oldResource = { ...cleanupIdentity, metadata: {
        ...(cleanupIdentity.metadata as Record<string, unknown>),
        name: replacement.resourceName,
      } };
      let observedUid = await dependencies.readResourceUid(oldResource);
      if (observedUid === replacement.uid) {
        await dependencies.removeResource(oldResource, launch.requestDigest,
          replacement.uid, replacement.configDigest);
        observedUid = await dependencies.readResourceUid(oldResource);
        if (observedUid === replacement.uid) {
          throw new Error("workspace Secret replacement deletion is still pending");
        }
      }
      const desiredName = (resource.metadata as { readonly name: string }).name;
      if (observedUid !== null && replacement.resourceName !== desiredName) {
        throw new PermanentWorkspaceLaunchError(
          "workspace Secret replacement encountered a stale identity",
        );
      }
      const recovered = await dependencies.recoverResource?.(
        resource, launch.requestDigest,
      ) ?? null;
      let binding: { readonly uid: string; readonly configDigest: string };
      if (recovered === null) {
        if (observedUid !== null) {
          throw new PermanentWorkspaceLaunchError(
            "workspace Secret replacement identity is not recoverable",
          );
        }
        binding = await dependencies.ensureResource(
          resource, launch.requestDigest, undefined, replacement.desiredConfigDigest,
        );
      } else {
        const { matchesExpectedConfiguration, resourceName, desiredConfigDigest,
          ...recoveredBinding } = recovered;
        if (!matchesExpectedConfiguration || resourceName !== undefined ||
            desiredConfigDigest !== replacement.desiredConfigDigest ||
            recoveredBinding.configDigest !== replacement.desiredConfigDigest ||
            (observedUid !== null && observedUid !== recoveredBinding.uid)) {
          throw new PermanentWorkspaceLaunchError(
            "recreated workspace Secret configuration drifted",
          );
        }
        binding = recoveredBinding;
      }
      if (binding.configDigest !== replacement.desiredConfigDigest) {
        throw new PermanentWorkspaceLaunchError(
          "recreated workspace Secret digest drifted",
        );
      }
      const replacements = { ...(launch.resourceReplacements ?? {}) };
      delete replacements.sourceAuthority;
      launch = await dependencies.update({ ...launch,
        resourceBindings: { ...(launch.resourceBindings ?? {}), sourceAuthority: binding },
        resourceReplacements: replacements });
      return binding;
    };
    const replacementBinding = await continueSecretReplacement();
    if (replacementBinding !== undefined) return replacementBinding;
    let expected = launch.resourceBindings?.[key];
    if (expected === undefined) {
      const recovered = await dependencies.recoverResource?.(resource, launch.requestDigest) ?? null;
      if (recovered !== null) {
        const { matchesExpectedConfiguration, desiredConfigDigest, ...binding } = recovered;
        launch = await dependencies.update({ ...launch,
          resourceBindings: { ...(launch.resourceBindings ?? {}), [key]: binding } });
        expected = binding;
        if (!matchesExpectedConfiguration) {
          if (resourceRole(resource) !== "source-authority") {
            throw new PermanentWorkspaceLaunchError(
              "recovered Kubernetes resource configuration drifted",
            );
          }
          if (desiredConfigDigest === undefined) {
            throw new PermanentWorkspaceLaunchError(
              "workspace Secret replacement proof is missing",
            );
          }
          const replacement = { ...binding,
            resourceName: binding.resourceName ??
              (resource.metadata as { readonly name: string }).name,
            desiredConfigDigest };
          launch = await dependencies.update({ ...launch,
            resourceReplacements: { ...(launch.resourceReplacements ?? {}),
              sourceAuthority: replacement } });
          expected = binding;
          return (await continueSecretReplacement())!;
        }
      }
    }
    const target = expected?.resourceName === undefined ? resource : { ...resource,
      metadata: { ...(resource.metadata as Record<string, unknown>),
        name: expected.resourceName } };
    const binding = await dependencies.ensureResource(
      target, launch.requestDigest, expected?.uid, expected?.configDigest,
    );
    if (expected !== undefined &&
        (binding.uid !== expected.uid || binding.configDigest !== expected.configDigest)) {
      throw new PermanentWorkspaceLaunchError(
        "workspace Kubernetes resource binding drifted",
      );
    }
    if (expected === undefined) {
      launch = {
        ...launch,
        resourceBindings: { ...(launch.resourceBindings ?? {}), [key]: binding },
      };
      launch = await dependencies.update(launch);
    }
    return binding;
  };
  const removeBound = async (resource: Record<string, unknown>): Promise<void> => {
    const binding = launch.resourceBindings?.[workspaceResourceKey(resource)];
    if (binding === undefined) return;
    const cleanupIdentity = cleanupResourceIdentity(resource);
    const target = binding.resourceName === undefined ? cleanupIdentity : { ...cleanupIdentity,
      metadata: { ...(cleanupIdentity.metadata as Record<string, unknown>),
        name: binding.resourceName } };
    await dependencies.removeResource(
      target, launch.requestDigest, binding.uid, binding.configDigest,
    );
  };
  const terminate = async (
    code: Parameters<typeof failWorkspaceLaunch>[1],
  ): Promise<WorkspaceLaunch> => {
    // Keep the launch active until credential cleanup succeeds. A transient
    // Kubernetes failure therefore retries cleanup instead of leaking a
    // credential after the launch becomes terminal.
    await removeBound(sourceSecret);
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
    workspaceLaunchRuntimeWorkerImage(
      launch,
      resourceConfig.configuredRuntimeWorkerImage,
    );
    if (launch.state === "queued") {
      for (const resource of [sourceSecret, workspaceStorage, materializerJob]) {
        await ensureBound(resource);
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
    if (session === null || launch.retryRuntime !== undefined) {
      if (launch.materializedAt === undefined) {
        for (const resource of [sourceSecret, workspaceStorage, materializerJob]) {
          await ensureBound(resource);
        }
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
      await removeBound(sourceSecret);
      await removeBound(materializerJob);
      await ensureBound(runtimeJob);
      const runtimeName = (runtimeJob.metadata as { readonly name: string }).name;
      if (jobState(await dependencies.loadJob(runtimeName)) === "failed") {
        return terminate("provisioning-failed");
      }
      if (session === null) return launch;
    }

    if (
      session.generation !== 1 ||
      session.lease?.status !== "active" ||
      session.lease.leaseId !== identity.leaseId ||
      !("version" in session.identity) ||
      session.identity.version !== "codeops.session-workspace-identity/v1" ||
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
    await ensureBound(runtimeJob);
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
        ...(launch.retryRuntime === undefined ? {} : {
          expectedRuntimeWorkerImage: launch.retryRuntime.runtimeWorkerImage,
        }),
      }),
    );
    await removeBound(sourceSecret);
    failureCode = "initial-prompt-failed";
    const promptIdempotencyKey = launch.retryRuntime === undefined
      ? (await dependencies.enqueuePrompt({
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
        })).command.idempotencyKey
      : identity.promptIdempotencyKey;
    if (promptIdempotencyKey !== identity.promptIdempotencyKey) {
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
    return error instanceof PermanentWorkspaceLaunchError ||
        error instanceof RuntimeWorkerImageDriftError
      ? terminate(failureCode)
      : retry();
  }
}
