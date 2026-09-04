import { isIP } from "node:net";

import type { TransactionClient } from "./session-broker-repository.js";

export class RuntimeWorkerImageDriftError extends Error {}

export class RuntimeWorkerImagePendingError extends Error {}

export interface RuntimeEgressPodObservation {
  readonly sessionId: string;
  readonly generation: number;
  readonly podUid: string;
  readonly podIp: string;
  readonly observedAt: string;
}

interface RuntimePodMetadata {
  readonly uid?: unknown;
  readonly labels?: Readonly<Record<string, unknown>>;
  readonly ownerReferences?: readonly {
    readonly apiVersion?: unknown;
    readonly kind?: unknown;
    readonly name?: unknown;
    readonly controller?: unknown;
  }[];
}

export function workspaceRuntimePodObservations(input: {
  readonly pods: readonly Record<string, unknown>[];
  readonly sessionId: string;
  readonly generation: number;
  readonly runId: string;
  readonly jobName: string;
  readonly observedAt: string;
  readonly expectedRuntimeWorkerImage?: string;
}): readonly RuntimeEgressPodObservation[] {
  if (
    !/^ses_[0-9a-f]{24}$/.test(input.sessionId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !/^launch-[0-9a-f]{24}$/.test(input.runId) ||
    !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(input.jobName) ||
    !Number.isFinite(Date.parse(input.observedAt))
  ) {
    throw new Error("workspace runtime Pod observation identity is invalid");
  }
  const observations = new Map<string, RuntimeEgressPodObservation>();
  for (const pod of input.pods) {
    const metadata = pod.metadata as RuntimePodMetadata | undefined;
    const status = pod.status as { readonly podIP?: unknown } | undefined;
    if (
      metadata?.labels?.["codeops.example/run-id"] !== input.runId ||
      metadata.ownerReferences?.some(
        (owner) =>
          owner.apiVersion === "batch/v1" &&
          owner.kind === "Job" &&
          owner.name === input.jobName &&
          owner.controller === true,
      ) !== true
    ) {
      throw new Error("workspace runtime Pod owner identity drifted");
    }
    if (status?.podIP === undefined) continue;
    if (input.expectedRuntimeWorkerImage !== undefined) {
      if (!/^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(input.expectedRuntimeWorkerImage)) {
        throw new Error("workspace retry runtime worker image is not immutable");
      }
      const containers = Array.isArray((pod.spec as { readonly containers?: unknown } | undefined)?.containers)
        ? (pod.spec as { readonly containers: unknown[] }).containers : [];
      const runtime = containers.find((raw) =>
        (raw as { readonly name?: unknown }).name === "runtime-worker"
      ) as { readonly image?: unknown } | undefined;
      const statuses = Array.isArray((pod.status as { readonly containerStatuses?: unknown } | undefined)?.containerStatuses)
        ? (pod.status as { readonly containerStatuses: unknown[] }).containerStatuses : [];
      const status = statuses.find((raw) =>
        (raw as { readonly name?: unknown }).name === "runtime-worker"
      ) as {
        readonly imageID?: unknown;
        readonly state?: { readonly terminated?: unknown };
      } | undefined;
      const digest = input.expectedRuntimeWorkerImage.slice(
        input.expectedRuntimeWorkerImage.indexOf("@") + 1,
      );
      if (runtime?.image !== input.expectedRuntimeWorkerImage) {
        throw new RuntimeWorkerImageDriftError("workspace retry runtime Pod image drifted");
      }
      if (typeof status?.imageID !== "string") {
        const phase = (pod.status as { readonly phase?: unknown } | undefined)?.phase;
        if (phase === "Pending" && status?.state?.terminated === undefined) {
          throw new RuntimeWorkerImagePendingError(
            "workspace retry runtime Pod image is not yet attestable",
          );
        }
        throw new RuntimeWorkerImageDriftError("workspace retry runtime Pod image drifted");
      }
      if (!status.imageID.endsWith(`@${digest}`)) {
        throw new RuntimeWorkerImageDriftError("workspace retry runtime Pod image drifted");
      }
    }
    if (
      typeof metadata.uid !== "string" ||
      metadata.uid.length < 1 ||
      metadata.uid.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(metadata.uid) ||
      typeof status.podIP !== "string" ||
      isIP(status.podIP) === 0
    ) {
      throw new Error("workspace runtime Pod network identity is invalid");
    }
    const observation = {
      sessionId: input.sessionId,
      generation: input.generation,
      podUid: metadata.uid,
      podIp: status.podIP,
      observedAt: new Date(input.observedAt).toISOString(),
    };
    observations.set(`${observation.podUid}\u0000${observation.podIp}`, observation);
  }
  if (observations.size === 0) {
    throw new Error("workspace runtime Pod has no assigned network identity");
  }
  return [...observations.values()].sort((left, right) =>
    `${left.podUid}\u0000${left.podIp}`.localeCompare(`${right.podUid}\u0000${right.podIp}`),
  );
}

export async function recordRuntimeEgressPodObservations(
  client: TransactionClient,
  observations: readonly RuntimeEgressPodObservation[],
): Promise<void> {
  if (observations.length < 1 || observations.length > 16) {
    throw new Error("runtime egress Pod observation count is invalid");
  }
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    for (const observation of observations) {
      await client.query(
        `INSERT INTO codeops.runtime_egress_pod_observations
           (session_id, generation, pod_uid, pod_ip, observed_at)
         VALUES ($1, $2, $3, $4::inet, $5)
         ON CONFLICT (session_id, generation, pod_uid, pod_ip) DO NOTHING`,
        [
          observation.sessionId,
          observation.generation,
          observation.podUid,
          observation.podIp,
          observation.observedAt,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
