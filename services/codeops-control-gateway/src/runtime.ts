import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentJobDispatchRequest,
  AgentJobDispatchResult,
  RuntimeLaunchBinding,
  RuntimeRequirements,
} from "@codeops/codeops-contracts";
import {
  createRunIdentity,
  claimRequest,
  completeAgentJobSecretReplacement,
  parseCheckpointLogs,
  readAgentJobResourceBindings,
  readAgentJobSecretReplacements,
  readCandidatePatch,
  readRetainedResult,
  removeAgentJobResourceBinding,
  retainCheckpoint,
  retainAgentJobResourceBinding,
  retainAgentJobSecretReplacement,
  retainFailure,
} from "./core.js";
import { sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import type { KubernetesClient } from "./kubernetes.js";
import {
  assertRunResources,
  buildRunResources,
} from "./resources.js";
import {
  dispatchRepositoryIdentity,
  type RepositoryRegistry,
} from "./repository-registry.js";

interface RuntimeConfig {
  readonly namespace: string;
  readonly repositoryRegistry: RepositoryRegistry;
  readonly agentImage: string;
  readonly runtimeRequirements: RuntimeRequirements;
  readonly runtimeLaunchBinding: RuntimeLaunchBinding;
  readonly imagePullSecrets?: readonly { readonly name: string }[];
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly evidenceClaimName?: string;
  readonly deliverCandidatePatch?: boolean;
  readonly serviceNamespace?: string;
  readonly modelProxyServiceName?: string;
  readonly modelProxyPodName?: string;
  readonly modelAuth: {
    readonly mode: "proxy";
    readonly origin: string;
    readonly signingKey: string;
  };
  readonly evidenceRoot: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly sessionProjection?: {
    started(
      request: AgentJobDispatchRequest,
      runId: string,
      runtimeOwner: {
        readonly requirements: RuntimeRequirements;
        readonly launchBinding: RuntimeLaunchBinding;
      },
    ): Promise<void>;
    terminal(input: {
      request: AgentJobDispatchRequest;
      runId: string;
      response: string;
      state: "completed" | "failed";
      source: "live" | "retained-reconciliation";
    }): Promise<void>;
  };
}

async function retainedResponse(rootDirectory: string, runId: string): Promise<string> {
  const checkpoint = JSON.parse(
    await readFile(
      path.join(rootDirectory, "agent-runs", runId, "checkpoint.json"),
      "utf8",
    ),
  ) as { response?: unknown };
  if (typeof checkpoint.response !== "string") {
    throw new Error("retained Agent Job checkpoint omitted its response");
  }
  return checkpoint.response;
}

function jobState(job: Record<string, unknown>): "running" | "succeeded" | "failed" {
  const status = (job.status ?? {}) as {
    succeeded?: unknown;
    failed?: unknown;
    conditions?: unknown;
  };
  if (Number(status.succeeded ?? 0) > 0) return "succeeded";
  if (Number(status.failed ?? 0) > 0) return "failed";
  if (Array.isArray(status.conditions)) {
    for (const condition of status.conditions as {
      type?: unknown;
      status?: unknown;
    }[]) {
      if (condition.status === "True" && condition.type === "Complete") {
        return "succeeded";
      }
      if (condition.status === "True" && condition.type === "Failed") {
        return "failed";
      }
    }
  }
  return "running";
}

function podName(pod: Record<string, unknown>): string | null {
  const metadata = (pod.metadata ?? {}) as { name?: unknown };
  return typeof metadata.name === "string" ? metadata.name : null;
}

export function createAgentJobRunner(input: {
  kubernetes: KubernetesClient;
  config: RuntimeConfig;
}): (
  request: AgentJobDispatchRequest,
  signal?: AbortSignal,
) => Promise<AgentJobDispatchResult> {
  return async (request, signal) => {
    signal?.throwIfAborted();
    const identity = createRunIdentity(request);
    const retained = await readRetainedResult({
      rootDirectory: input.config.evidenceRoot,
      request,
      ...identity,
    });
    const runtimeLaunchBinding = retained === null
      ? await claimRequest({
          rootDirectory: input.config.evidenceRoot,
          request,
          ...identity,
          runtimeLaunchBinding: input.config.runtimeLaunchBinding,
        })
      : input.config.runtimeLaunchBinding;
    if (
      runtimeLaunchBinding.requirementDigest !== input.config.runtimeLaunchBinding.requirementDigest ||
      runtimeLaunchBinding.requirementDigest !== sha256CanonicalJsonDigest(input.config.runtimeRequirements)
    ) {
      throw new Error("durable Agent Job runtime requirement drift");
    }
    const repository = input.config.repositoryRegistry.resolve(
      dispatchRepositoryIdentity(request),
    );
    const retainedCandidate = await readCandidatePatch({
      rootDirectory: input.config.evidenceRoot,
      request,
    });
    const resources = buildRunResources(
      {
        namespace: input.config.namespace,
        ...identity,
        repositoryUrl: repository.repositoryUrl,
        agentImage: runtimeLaunchBinding.profile.images.agent,
        runtimeProfile: runtimeLaunchBinding.profile,
        runtimeRequirements: input.config.runtimeRequirements,
        imagePullSecrets: input.config.imagePullSecrets,
        nodeSelector: input.config.nodeSelector,
        evidenceClaimName: input.config.evidenceClaimName,
        modelProxyServiceName: input.config.modelProxyServiceName,
        modelProxyPodName: input.config.modelProxyPodName,
        repositoryReadToken: repository.readToken,
        modelAuth: input.config.modelAuth,
        candidate: retainedCandidate?.candidate,
        candidatePatch: input.config.deliverCandidatePatch ? retainedCandidate?.patch : undefined,
        serviceNamespace: input.config.serviceNamespace,
      },
      request,
    );
    assertRunResources(resources, {
      serviceName: input.config.modelProxyServiceName,
      podName: input.config.modelProxyPodName,
    });
    await claimRequest({
      rootDirectory: input.config.evidenceRoot,
      request,
      ...identity,
    });
    const resourceKey = (resource: Record<string, unknown>): string => {
      const metadata = resource.metadata as { readonly name?: unknown } | undefined;
      if (typeof resource.kind !== "string" || typeof metadata?.name !== "string") {
        throw new Error("Agent Job Kubernetes resource identity is invalid");
      }
      return `${resource.kind}/${metadata.name}`;
    };
    const resourceBindings = { ...await readAgentJobResourceBindings({
      rootDirectory: input.config.evidenceRoot,
      ...identity,
    }) };
    const resourceReplacements = { ...await readAgentJobSecretReplacements({
      rootDirectory: input.config.evidenceRoot,
      ...identity,
    }) };
    const cleanup = async (): Promise<void> => {
      let firstError: unknown;
      for (const resource of [...resources].reverse()) {
        const binding = resourceBindings[resourceKey(resource)];
        // Results retained before exact cleanup bindings were introduced remain
        // successful. Without the original UID, deleting a same-name resource
        // would weaken the replacement-identity guard.
        if (binding === undefined) continue;
        try {
          const cleanupResource = resource.kind === "Secret"
            ? { apiVersion: resource.apiVersion, kind: resource.kind,
                metadata: structuredClone(resource.metadata) }
            : resource;
          await input.kubernetes.delete(
            cleanupResource as unknown as Parameters<KubernetesClient["delete"]>[0],
            identity.requestDigest,
            binding.uid,
            binding.configDigest,
          );
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    };
    if (retained !== null) {
      await cleanup();
      await input.config.sessionProjection?.terminal({
        request,
        runId: identity.runId,
        response: await retainedResponse(input.config.evidenceRoot, identity.runId),
        state: "completed",
        source: "retained-reconciliation",
      });
      return retained;
    }
    await input.config.sessionProjection?.started(request, identity.runId, {
      requirements: input.config.runtimeRequirements,
      launchBinding: runtimeLaunchBinding,
    });
    let logs = "";
    let completedResponse: string | null = null;
    try {
      for (const resource of resources) {
        signal?.throwIfAborted();
        const key = resourceKey(resource);
        const continueSecretReplacement = async () => {
          const replacement = resourceReplacements[key];
          if (resource.kind !== "Secret" || replacement === undefined) return undefined;
          const metadata = resource.metadata as Record<string, unknown>;
          const cleanupIdentity = { apiVersion: resource.apiVersion, kind: resource.kind,
            metadata: { ...metadata, name: replacement.resourceName ?? metadata.name } };
          await input.kubernetes.delete(
            cleanupIdentity as unknown as Parameters<KubernetesClient["delete"]>[0],
            identity.requestDigest,
            replacement.uid,
            replacement.configDigest,
          );
          const oldBinding = resourceBindings[key];
          if (oldBinding !== undefined) {
            if (oldBinding.uid !== replacement.uid ||
                oldBinding.configDigest !== replacement.configDigest) {
              throw new Error("durable Agent Job Secret replacement binding drift");
            }
            await removeAgentJobResourceBinding({
              rootDirectory: input.config.evidenceRoot,
              ...identity,
              resourceKey: key,
              binding: oldBinding,
            });
            delete resourceBindings[key];
          }
          const recovered = await input.kubernetes.recoverOwned?.(
            resource as unknown as Parameters<KubernetesClient["recoverOwned"]>[0],
            identity.requestDigest,
          ) ?? null;
          let binding;
          if (recovered === null) {
            binding = await input.kubernetes.ensure(
              resource as unknown as Parameters<KubernetesClient["ensure"]>[0],
              identity.requestDigest,
              undefined,
              replacement.desiredConfigDigest,
            );
          } else {
            const { matchesExpectedConfiguration, resourceName, desiredConfigDigest,
              ...recoveredBinding } = recovered;
            if (!matchesExpectedConfiguration || resourceName !== undefined ||
                desiredConfigDigest !== replacement.desiredConfigDigest ||
                recoveredBinding.configDigest !== replacement.desiredConfigDigest) {
              throw new Error("recreated Agent Job Secret configuration drifted");
            }
            binding = recoveredBinding;
          }
          await completeAgentJobSecretReplacement({
            rootDirectory: input.config.evidenceRoot,
            ...identity,
            resourceKey: key,
            replacement,
            binding,
          });
          resourceBindings[key] = binding;
          delete resourceReplacements[key];
          return binding;
        };
        const replacementBinding = await continueSecretReplacement();
        if (replacementBinding !== undefined) continue;
        let expected = resourceBindings[key];
        if (expected === undefined) {
          const recovered = await input.kubernetes.recoverOwned?.(
            resource as unknown as Parameters<KubernetesClient["recoverOwned"]>[0],
            identity.requestDigest,
          ) ?? null;
          if (recovered !== null) {
            const { matchesExpectedConfiguration, resourceName, desiredConfigDigest,
              ...binding } = recovered;
            resourceBindings[key] = binding;
            await retainAgentJobResourceBinding({
              rootDirectory: input.config.evidenceRoot,
              ...identity,
              resourceKey: key,
              binding,
            });
            expected = binding;
            if (!matchesExpectedConfiguration) {
              if (resource.kind !== "Secret") {
                throw new Error("recovered Agent Job Kubernetes resource configuration drifted");
              }
              if (desiredConfigDigest === undefined) {
                throw new Error("Agent Job Secret replacement proof is missing");
              }
              const replacement = { ...binding, desiredConfigDigest,
                ...(resourceName === undefined ? {} : { resourceName }) };
              await retainAgentJobSecretReplacement({
                rootDirectory: input.config.evidenceRoot,
                ...identity,
                resourceKey: key,
                replacement,
              });
              resourceReplacements[key] = replacement;
              await continueSecretReplacement();
              continue;
            } else if (resourceName !== undefined) {
              throw new Error("recovered Agent Job Kubernetes resource name drifted");
            }
          }
        }
        const binding = await input.kubernetes.ensure(
          resource as unknown as Parameters<KubernetesClient["ensure"]>[0],
          identity.requestDigest,
          expected?.uid,
          expected?.configDigest,
        );
        if (expected !== undefined && (binding.uid !== expected.uid ||
            binding.configDigest !== expected.configDigest)) {
          throw new Error("Agent Job Kubernetes resource binding drifted");
        }
        if (expected === undefined) {
          resourceBindings[key] = binding;
          await retainAgentJobResourceBinding({
            rootDirectory: input.config.evidenceRoot,
            ...identity,
            resourceKey: key,
            binding,
          });
        }
      }

      const jobName = `codeops-agent-${identity.runId}`;
      const deadline = Date.now() + (input.config.timeoutMs ?? 65 * 60 * 1_000);
      let terminal: "succeeded" | "failed" | null = null;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const state = jobState(await input.kubernetes.getJob(jobName));
        if (state !== "running") {
          terminal = state;
          break;
        }
        await delay(input.config.pollIntervalMs ?? 2_000, undefined, {
          signal,
        });
      }
      if (!terminal) throw new Error("Agent Job reconciliation timed out");

      const pods = await input.kubernetes.listRunPods(identity.runId);
      const names = pods
        .map(podName)
        .filter((value): value is string => value !== null);
      if (names.length !== 1) {
        throw new Error("Agent Job must reconcile to exactly one Pod");
      }
      logs = await input.kubernetes.getPodLogs(
        names[0]!,
        "session-gateway",
      );
      const checkpoint = parseCheckpointLogs({
        logs,
        request,
        runId: identity.runId,
      });
      if (terminal !== "succeeded") {
        throw new Error(
          "Agent Job failed despite a syntactically valid checkpoint",
        );
      }
      const result = await retainCheckpoint({
        rootDirectory: input.config.evidenceRoot,
        request,
        ...identity,
        retained: checkpoint,
      });
      completedResponse = checkpoint.checkpoint.response;
      await input.config.sessionProjection?.terminal({
        request,
        runId: identity.runId,
        response: completedResponse,
        state: "completed",
        source: "live",
      });
      return result;
    } catch (error) {
      if (!signal?.aborted) {
        await retainFailure({
          rootDirectory: input.config.evidenceRoot,
          ...identity,
          error,
          logs,
        });
      }
      if (completedResponse === null) {
        await input.config.sessionProjection?.terminal({
          request,
          runId: identity.runId,
          response: error instanceof Error ? error.message : "Agent Job failed",
          state: "failed",
          source: "live",
        });
      }
      throw error;
    } finally {
      await cleanup();
    }
  };
}
