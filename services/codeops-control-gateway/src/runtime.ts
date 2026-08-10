import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentJobDispatchRequest,
  AgentJobDispatchResult,
} from "@renoconcierge/codeops-contracts";
import {
  createRunIdentity,
  claimRequest,
  parseCheckpointLogs,
  readCandidatePatch,
  readRetainedResult,
  retainCheckpoint,
  retainFailure,
} from "./core.js";
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
  readonly sessionGatewayImage: string;
  readonly modelAuth: {
    readonly mode: "proxy";
    readonly origin: string;
    readonly signingKey: string;
  };
  readonly evidenceRoot: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
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
    const repository = input.config.repositoryRegistry.resolve(
      dispatchRepositoryIdentity(request),
    );
    const identity = createRunIdentity(request);
    const retainedCandidate = await readCandidatePatch({
      rootDirectory: input.config.evidenceRoot,
      request,
    });
    const resources = buildRunResources(
      {
        namespace: input.config.namespace,
        ...identity,
        repositoryUrl: repository.repositoryUrl,
        agentImage: input.config.agentImage,
        sessionGatewayImage: input.config.sessionGatewayImage,
        repositoryReadToken: repository.readToken,
        modelAuth: input.config.modelAuth,
        candidate: retainedCandidate?.candidate,
      },
      request,
    );
    assertRunResources(resources);
    await claimRequest({
      rootDirectory: input.config.evidenceRoot,
      request,
      ...identity,
    });
    const cleanup = async (): Promise<void> => {
      let firstError: unknown;
      for (const resource of [...resources].reverse()) {
        try {
          await input.kubernetes.delete(
            resource as unknown as Parameters<KubernetesClient["delete"]>[0],
          );
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    };
    const retained = await readRetainedResult({
      rootDirectory: input.config.evidenceRoot,
      ...identity,
    });
    if (retained) {
      await cleanup();
      return retained;
    }
    let logs = "";
    try {
      for (const resource of resources) {
        signal?.throwIfAborted();
        await input.kubernetes.ensure(
          resource as unknown as Parameters<KubernetesClient["ensure"]>[0],
          identity.requestDigest,
        );
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
      return await retainCheckpoint({
        rootDirectory: input.config.evidenceRoot,
        request,
        ...identity,
        retained: checkpoint,
      });
    } catch (error) {
      if (!signal?.aborted) {
        await retainFailure({
          rootDirectory: input.config.evidenceRoot,
          ...identity,
          error,
          logs,
        });
      }
      throw error;
    } finally {
      await cleanup();
    }
  };
}
