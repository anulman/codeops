import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentJobDispatchRequest,
  AgentJobDispatchResult,
} from "@codeops/codeops-contracts";
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
  readonly imagePullSecrets?: readonly { readonly name: string }[];
  readonly nodeSelector?: Readonly<Record<string, string>>;
  readonly evidenceClaimName?: string;
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
    started(request: AgentJobDispatchRequest, runId: string): Promise<void>;
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
        imagePullSecrets: input.config.imagePullSecrets,
        nodeSelector: input.config.nodeSelector,
        evidenceClaimName: input.config.evidenceClaimName,
        modelProxyServiceName: input.config.modelProxyServiceName,
        modelProxyPodName: input.config.modelProxyPodName,
        repositoryReadToken: repository.readToken,
        modelAuth: input.config.modelAuth,
        candidate: retainedCandidate?.candidate,
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
    await input.config.sessionProjection?.started(request, identity.runId);
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
      await input.config.sessionProjection?.terminal({
        request,
        runId: identity.runId,
        response: await retainedResponse(input.config.evidenceRoot, identity.runId),
        state: "completed",
        source: "retained-reconciliation",
      });
      await cleanup();
      return retained;
    }
    let logs = "";
    let completedResponse: string | null = null;
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
