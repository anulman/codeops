import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import https from "node:https";
import { canonicalJsonText } from "@codeops/codeops-contracts";

interface KubernetesResource {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly uid?: string;
    readonly resourceVersion?: string;
    readonly annotations?: Readonly<Record<string, string>>;
  };
}

const resourcePaths: Readonly<Record<string, string>> = {
  Secret: "api/v1/namespaces/{namespace}/secrets",
  PersistentVolumeClaim: "api/v1/namespaces/{namespace}/persistentvolumeclaims",
  ServiceAccount: "api/v1/namespaces/{namespace}/serviceaccounts",
  Job: "apis/batch/v1/namespaces/{namespace}/jobs",
  NetworkPolicy:
    "apis/networking.k8s.io/v1/namespaces/{namespace}/networkpolicies",
};

export interface KubernetesClient {
  ensure(resource: KubernetesResource, requestDigest: string,
    expectedUid?: string, expectedConfigDigest?: string):
    Promise<{ readonly uid: string; readonly configDigest: string }>;
  getJob(name: string): Promise<Record<string, unknown>>;
  listRunPods(runId: string, boundedIdentity?: boolean):
    Promise<readonly Record<string, unknown>[]>;
  getPodLogs(name: string, container: string): Promise<string>;
  delete(resource: KubernetesResource, requestDigest: string, expectedUid: string,
    expectedConfigDigest: string): Promise<void>;
  recoverOwned(resource: KubernetesResource, requestDigest: string):
    Promise<{ readonly uid: string; readonly configDigest: string;
      readonly resourceName?: string; readonly matchesExpectedConfiguration: boolean;
      readonly desiredConfigDigest?: string } | null>;
  readResourceUid(resource: KubernetesResource): Promise<string | null>;
}

export class KubernetesResourceIdentityDriftError extends Error {}

export type KubernetesOperation =
  | "ensure"
  | "get-job"
  | "list-pods"
  | "get-pod-logs"
  | "delete"
  | "recover";

export class KubernetesApiError extends Error {
  readonly operation: KubernetesOperation;
  readonly status: number | null;

  constructor(operation: KubernetesOperation, status: number | null, options?: ErrorOptions) {
    super(status === null
      ? `Kubernetes ${operation} request failed`
      : `Kubernetes ${operation} request returned HTTP ${status}`, options);
    this.operation = operation;
    this.status = status;
  }
}

export class KubernetesResponseError extends KubernetesApiError {
  constructor(operation: KubernetesOperation, status: number, options?: ErrorOptions) {
    super(operation, status, options);
    this.name = "KubernetesResponseError";
    this.message = `Kubernetes ${operation} returned an invalid HTTP ${status} response`;
  }
}

export function isTransientKubernetesError(error: unknown): boolean {
  return error instanceof KubernetesApiError &&
    (error.status === null || error.status === 408 || error.status === 429 ||
      (error.status >= 500 && error.status <= 599));
}

export function kubernetesIdentityLabel(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let encoded = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) encoded += alphabet[(accumulator << (5 - bits)) & 31];
  return encoded;
}

const resourceConfigurationAnnotation = "codeops.example/resource-configuration-digest";

function immutableResourceConfiguration(resource: KubernetesResource): Record<string, unknown> {
  const value = resource as unknown as Record<string, unknown>;
  const annotations = { ...(resource.metadata.annotations ?? {}) };
  delete annotations[resourceConfigurationAnnotation];
  // A Secret UID and its non-secret ownership metadata are the immutable
  // binding. Credential bytes and their derived source identity are neither
  // persisted nor reconstructed during replay after credential rotation.
  if (resource.kind === "Secret") {
    delete annotations["codeops.example/source-identity"];
  }
  const metadata = value.metadata as Record<string, unknown>;
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
      ...(metadata.labels === undefined ? {} : { labels: metadata.labels }),
      ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
    },
    ...(["type", "immutable", ...(resource.kind === "Secret" ? [] : ["data"]), "spec"] as const)
      .reduce<Record<string, unknown>>(
      (result, key) => value[key] === undefined ? result : { ...result, [key]: value[key] }, {},
    ),
  };
}

function secretProofConfiguration(resource: KubernetesResource): Record<string, unknown> {
  const value = resource as unknown as Record<string, unknown>;
  const annotations = { ...(resource.metadata.annotations ?? {}) };
  delete annotations[resourceConfigurationAnnotation];
  const data = value.data;
  if (value.type === undefined || typeof value.type !== "string" || value.type.length < 1 ||
      value.immutable !== true || data === null || typeof data !== "object" ||
      Array.isArray(data) || Object.keys(data).length < 1 ||
      !Object.values(data).every((item) => typeof item === "string" &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item))) {
    throw new KubernetesResourceIdentityDriftError(
      "Secret immutable configuration or payload is invalid",
    );
  }
  const metadata = value.metadata as Record<string, unknown>;
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
      ...(metadata.labels === undefined ? {} : { labels: metadata.labels }),
      ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
    },
    type: value.type,
    immutable: true,
    data,
  };
}

export function kubernetesResourceConfigurationDigest(resource: KubernetesResource,
  secretProofKey?: string | Buffer): string {
  if (resource.kind === "Secret") {
    if (secretProofKey === undefined || secretProofKey.length < 32) {
      throw new KubernetesResourceIdentityDriftError("Secret proof key is missing or invalid");
    }
    return `sha256:${createHmac("sha256", secretProofKey)
      .update("codeops.kubernetes-secret-proof/v1\0")
      .update(canonicalJsonText(secretProofConfiguration(resource))).digest("hex")}`;
  }
  return `sha256:${createHash("sha256")
    .update(canonicalJsonText(immutableResourceConfiguration(resource))).digest("hex")}`;
}

function bindResourceConfiguration(resource: KubernetesResource,
  expectedConfigDigest = kubernetesResourceConfigurationDigest(resource)): KubernetesResource {
  return { ...resource, metadata: { ...resource.metadata, annotations: {
    ...(resource.metadata.annotations ?? {}), [resourceConfigurationAnnotation]: expectedConfigDigest,
  } } };
}

function containsExpected(existing: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(existing) && existing.length === expected.length &&
      expected.every((item, index) => containsExpected(existing[index], item));
  }
  if (expected !== null && typeof expected === "object") {
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) return false;
    return Object.entries(expected).every(([key, value]) =>
      containsExpected((existing as Record<string, unknown>)[key], value));
  }
  return Object.is(existing, expected);
}

function normalizedSubmittedResource(resource: KubernetesResource): Record<string, unknown> {
  const value = structuredClone(resource) as unknown as Record<string, unknown>;
  delete value.status;
  const metadata = value.metadata as Record<string, unknown>;
  for (const key of ["uid", "resourceVersion", "generation", "creationTimestamp",
    "deletionTimestamp", "deletionGracePeriodSeconds", "managedFields", "selfLink"]) {
    delete metadata[key];
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function omitIfUnsubmitted(existing: Record<string, unknown>,
  expected: Record<string, unknown> | undefined, key: string,
  accepted?: (value: unknown) => boolean): void {
  if (expected?.[key] === undefined && (accepted === undefined || accepted(existing[key]))) {
    delete existing[key];
  }
}

function omitControllerAnnotation(existing: Record<string, unknown>,
  expected: Record<string, unknown>, key: string): void {
  const existingMetadata = record(existing.metadata);
  const expectedMetadata = record(expected.metadata);
  const existingAnnotations = record(existingMetadata?.annotations);
  const expectedAnnotations = record(expectedMetadata?.annotations);
  if (existingAnnotations !== undefined && expectedAnnotations?.[key] === undefined) {
    delete existingAnnotations[key];
  }
}

function exactKubernetesQuantity(value: unknown, resourceName: string): bigint | undefined {
  // The API server serializes whole CPU cores and binary byte quantities in a
  // shorter spelling. Compare only the fixed resource classes emitted by the
  // workspace builder; unknown Kubernetes quantity forms remain exact.
  if (typeof value !== "string") return undefined;
  if (resourceName === "cpu") {
    const millicores = /^(\d+)m$/.exec(value);
    if (millicores !== null) return BigInt(millicores[1]!);
    const cores = /^(\d+)$/.exec(value);
    return cores === null ? undefined : BigInt(cores[1]!) * 1_000n;
  }
  if (resourceName !== "memory" && resourceName !== "ephemeral-storage") return undefined;
  const binary = /^(\d+)(Ki|Mi|Gi|Ti)$/.exec(value);
  if (binary === null) return undefined;
  const exponent = { Ki: 10n, Mi: 20n, Gi: 30n, Ti: 40n }[binary[2] as
    "Ki" | "Mi" | "Gi" | "Ti"];
  return BigInt(binary[1]!) << exponent;
}

function canonicalizeSubmittedContainerResources(existing: Record<string, unknown>,
  expected: Record<string, unknown> | undefined): void {
  const existingResources = record(existing.resources);
  const expectedResources = record(expected?.resources);
  if (existingResources === undefined || expectedResources === undefined) return;
  for (const category of ["requests", "limits"]) {
    const current = record(existingResources[category]);
    const submitted = record(expectedResources[category]);
    if (current === undefined || submitted === undefined) continue;
    for (const [resourceName, submittedValue] of Object.entries(submitted)) {
      const currentValue = current[resourceName];
      if (currentValue === submittedValue) continue;
      const currentQuantity = exactKubernetesQuantity(currentValue, resourceName);
      const submittedQuantity = exactKubernetesQuantity(submittedValue, resourceName);
      if (currentQuantity !== undefined && currentQuantity === submittedQuantity) {
        current[resourceName] = submittedValue;
      }
    }
  }
}

function submittedQuantityAlternative(value: unknown, resourceName: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (resourceName === "cpu") {
    const cores = /^(\d+)$/.exec(value);
    return cores === null ? undefined : `${BigInt(cores[1]!) * 1_000n}m`;
  }
  if (resourceName !== "memory" && resourceName !== "ephemeral-storage") return undefined;
  const gibibytes = /^(\d+)Gi$/.exec(value);
  return gibibytes === null ? undefined : `${BigInt(gibibytes[1]!) * 1_024n}Mi`;
}

function reviewedQuantityVariants(resource: Record<string, unknown>): Record<string, unknown>[] {
  // Identity-only replay has the stored desired digest but not the submitted
  // body. Enumerate a bounded set of semantically identical builder spellings
  // so cleanup remains possible without accepting a changed resource amount.
  let variants = [structuredClone(resource)];
  const podSpec = record(record(record(resource.spec)?.template)?.spec);
  const containers = podSpec?.containers;
  if (!Array.isArray(containers)) return variants;
  for (let containerIndex = 0; containerIndex < containers.length; containerIndex += 1) {
    for (const category of ["requests", "limits"]) {
      const quantities = record(record(record(containers[containerIndex])?.resources)?.[category]);
      if (quantities === undefined) continue;
      for (const [resourceName, value] of Object.entries(quantities)) {
        const alternative = submittedQuantityAlternative(value, resourceName);
        if (alternative === undefined || alternative === value) continue;
        if (variants.length >= 256) return variants;
        const additions: Record<string, unknown>[] = [];
        for (const variant of variants) {
          const variantContainers = record(record(record(variant.spec)?.template)?.spec)?.containers;
          if (!Array.isArray(variantContainers)) continue;
          const variantQuantities = record(record(
            record(variantContainers[containerIndex])?.resources)?.[category]);
          if (variantQuantities === undefined) continue;
          const changed = structuredClone(variant);
          const changedContainers = record(record(record(changed.spec)?.template)?.spec)?.containers;
          if (!Array.isArray(changedContainers)) continue;
          const changedQuantities = record(record(
            record(changedContainers[containerIndex])?.resources)?.[category]);
          if (changedQuantities === undefined) continue;
          changedQuantities[resourceName] = alternative;
          additions.push(changed);
        }
        variants = [...variants, ...additions];
      }
    }
  }
  return variants;
}

function canonicalizeServerOwnedFields(existing: Record<string, unknown>,
  expected: Record<string, unknown>, kind: string): void {
  const existingMetadata = record(existing.metadata);
  const expectedMetadata = record(expected.metadata);
  if (kind === "PersistentVolumeClaim") {
    for (const key of [
      "pv.kubernetes.io/bind-completed",
      "pv.kubernetes.io/bound-by-controller",
      "volume.beta.kubernetes.io/storage-provisioner",
      "volume.kubernetes.io/storage-provisioner",
      "volume.kubernetes.io/selected-node",
    ]) omitControllerAnnotation(existing, expected, key);
    if (existingMetadata !== undefined && expectedMetadata?.finalizers === undefined &&
        Array.isArray(existingMetadata.finalizers)) {
      const finalizers = existingMetadata.finalizers.filter(
        (item) => item !== "kubernetes.io/pvc-protection",
      );
      if (finalizers.length === 0) delete existingMetadata.finalizers;
      else existingMetadata.finalizers = finalizers;
    }
    const existingSpec = record(existing.spec);
    const expectedSpec = record(expected.spec);
    if (existingSpec !== undefined) {
      omitIfUnsubmitted(existingSpec, expectedSpec, "storageClassName", (value) =>
        typeof value === "string" && value.length > 0);
      omitIfUnsubmitted(existingSpec, expectedSpec, "volumeName", (value) =>
        typeof value === "string" && value.length > 0);
      omitIfUnsubmitted(existingSpec, expectedSpec, "volumeMode", (value) =>
        value === "Filesystem");
    }
    return;
  }
  if (kind !== "Job") return;
  if (existingMetadata !== undefined && expectedMetadata?.finalizers === undefined &&
      Array.isArray(existingMetadata.finalizers)) {
    const finalizers = existingMetadata.finalizers.filter(
      (item) => item !== "batch.kubernetes.io/job-tracking",
    );
    if (finalizers.length === 0) delete existingMetadata.finalizers;
    else existingMetadata.finalizers = finalizers;
  }
  const existingSpec = record(existing.spec);
  const expectedSpec = record(expected.spec);
  if (existingSpec === undefined) return;
  omitIfUnsubmitted(existingSpec, expectedSpec, "selector", (value) => record(value) !== undefined);
  for (const [key, value] of [
    ["completionMode", "NonIndexed"], ["completions", 1], ["parallelism", 1],
    ["suspend", false], ["manualSelector", false],
    ["managedBy", "kubernetes.io/job-controller"],
    ["podReplacementPolicy", "TerminatingOrFailed"],
  ] as const) omitIfUnsubmitted(existingSpec, expectedSpec, key, (item) => item === value);
  const existingTemplate = record(existingSpec.template);
  const expectedTemplate = record(expectedSpec?.template);
  const existingTemplateMetadata = record(existingTemplate?.metadata);
  const expectedTemplateMetadata = record(expectedTemplate?.metadata);
  const existingLabels = record(existingTemplateMetadata?.labels);
  const expectedLabels = record(expectedTemplateMetadata?.labels);
  if (existingLabels !== undefined) {
    for (const key of ["batch.kubernetes.io/controller-uid", "batch.kubernetes.io/job-name",
      "controller-uid", "job-name"]) {
      if (expectedLabels?.[key] === undefined) delete existingLabels[key];
    }
  }
  const existingPodSpec = record(existingTemplate?.spec);
  const expectedPodSpec = record(expectedTemplate?.spec);
  if (existingPodSpec === undefined) return;
  // The Kubernetes API omits an explicitly submitted empty imagePullSecrets
  // list from Job Pod templates. Preserve exact comparison semantics by
  // reconstructing only that reviewed empty value; a non-empty observed or
  // submitted list remains identity-bearing configuration.
  if (existingPodSpec.imagePullSecrets === undefined &&
      Array.isArray(expectedPodSpec?.imagePullSecrets) &&
      expectedPodSpec.imagePullSecrets.length === 0) {
    existingPodSpec.imagePullSecrets = [];
  }
  for (const [key, value] of [["dnsPolicy", "ClusterFirst"],
    ["schedulerName", "default-scheduler"]] as const) {
    omitIfUnsubmitted(existingPodSpec, expectedPodSpec, key, (item) => item === value);
  }
  omitIfUnsubmitted(existingPodSpec, expectedPodSpec, "serviceAccount", (value) =>
    typeof value === "string" && value === existingPodSpec.serviceAccountName);
  const existingContainers = existingPodSpec.containers;
  const expectedContainers = expectedPodSpec?.containers;
  if (Array.isArray(existingContainers) && Array.isArray(expectedContainers)) {
    for (let index = 0; index < existingContainers.length; index += 1) {
      const current = record(existingContainers[index]);
      const submitted = record(expectedContainers[index]);
      if (current === undefined) continue;
      omitIfUnsubmitted(current, submitted, "terminationMessagePath", (value) =>
        value === "/dev/termination-log");
      omitIfUnsubmitted(current, submitted, "terminationMessagePolicy", (value) =>
        value === "File");
      canonicalizeSubmittedContainerResources(current, submitted);
      const currentVolumeMounts = current.volumeMounts;
      const submittedVolumeMounts = submitted?.volumeMounts;
      if (Array.isArray(currentVolumeMounts) && Array.isArray(submittedVolumeMounts)) {
        for (let mountIndex = 0; mountIndex < currentVolumeMounts.length; mountIndex += 1) {
          const currentMount = record(currentVolumeMounts[mountIndex]);
          const submittedMount = record(submittedVolumeMounts[mountIndex]);
          if (currentMount !== undefined && currentMount.readOnly === undefined &&
              submittedMount?.readOnly === false) currentMount.readOnly = false;
        }
      }
      const currentReadinessProbe = record(current.readinessProbe);
      const submittedReadinessProbe = record(submitted?.readinessProbe);
      if (currentReadinessProbe !== undefined && submittedReadinessProbe !== undefined) {
        omitIfUnsubmitted(currentReadinessProbe, submittedReadinessProbe,
          "failureThreshold", (value) => value === 3);
        omitIfUnsubmitted(currentReadinessProbe, submittedReadinessProbe,
          "successThreshold", (value) => value === 1);
      }
    }
  }
  const existingVolumes = existingPodSpec.volumes;
  const expectedVolumes = expectedPodSpec?.volumes;
  if (Array.isArray(existingVolumes) && Array.isArray(expectedVolumes)) {
    for (let index = 0; index < existingVolumes.length; index += 1) {
      const current = record(existingVolumes[index]);
      const submitted = record(expectedVolumes[index]);
      for (const source of ["persistentVolumeClaim", "secret", "configMap"]) {
        const currentSource = record(current?.[source]);
        const submittedSource = record(submitted?.[source]);
        if (currentSource !== undefined) omitIfUnsubmitted(
          currentSource, submittedSource, source === "persistentVolumeClaim" ? "readOnly" : "optional",
          (value) => value === false,
        );
      }
    }
  }
}

function observedResourceConfigurationMatches(resource: KubernetesResource,
  expectedDigest: string): boolean {
  const configuration = structuredClone(immutableResourceConfiguration(resource));
  const existingSpec = record(configuration.spec);
  const existingTemplate = record(existingSpec?.template);
  const existingPodSpec = record(existingTemplate?.spec);
  const emptyArrayShape = (value: unknown) => Array.isArray(value)
    ? value.map(() => ({})) : undefined;
  const comparisonShape = {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {},
    spec: { template: { metadata: { labels: {} }, spec: {
      containers: emptyArrayShape(existingPodSpec?.containers),
      volumes: emptyArrayShape(existingPodSpec?.volumes),
    } } },
  };
  canonicalizeServerOwnedFields(configuration, comparisonShape, resource.kind);
  const digest = (value: Record<string, unknown>) => `sha256:${createHash("sha256")
    .update(canonicalJsonText(value)).digest("hex")}`;
  if (digest(configuration) === expectedDigest) return true;
  // For an identity-only replay or cleanup request, the desired Job body is
  // unavailable. Check only reviewed API-server omissions as alternate
  // canonical shapes without weakening non-empty registry or probe identity.
  if (resource.kind === "Job") {
    const reviewedVariants: Record<string, unknown>[] = [];
    const withEmptyPullSecrets = structuredClone(configuration);
    const pullSecretsPodSpec = record(record(record(withEmptyPullSecrets.spec)?.template)?.spec);
    if (pullSecretsPodSpec !== undefined && pullSecretsPodSpec.imagePullSecrets === undefined) {
      pullSecretsPodSpec.imagePullSecrets = [];
      reviewedVariants.push(withEmptyPullSecrets);
    }
    for (const base of [configuration, ...reviewedVariants]) {
      const withoutProbeDefaults = structuredClone(base);
      const podSpec = record(record(record(withoutProbeDefaults.spec)?.template)?.spec);
      const containers = podSpec?.containers;
      let changed = false;
      if (Array.isArray(containers)) {
        for (const value of containers) {
          const probe = record(record(value)?.readinessProbe);
          if (probe?.failureThreshold === 3) {
            delete probe.failureThreshold;
            changed = true;
          }
          if (probe?.successThreshold === 1) {
            delete probe.successThreshold;
            changed = true;
          }
        }
      }
      if (changed) reviewedVariants.push(withoutProbeDefaults);
    }
    for (const base of [configuration, ...reviewedVariants]) {
      const withWritableSubPaths = structuredClone(base);
      const podSpec = record(record(record(withWritableSubPaths.spec)?.template)?.spec);
      const containers = podSpec?.containers;
      let changed = false;
      if (Array.isArray(containers)) {
        for (const value of containers) {
          const mounts = record(value)?.volumeMounts;
          if (!Array.isArray(mounts)) continue;
          for (const mountValue of mounts) {
            const mount = record(mountValue);
            if (typeof mount?.subPath === "string" && mount.subPath.length > 0 &&
                mount.readOnly === undefined) {
              mount.readOnly = false;
              changed = true;
            }
          }
        }
      }
      if (changed) reviewedVariants.push(withWritableSubPaths);
    }
    return [configuration, ...reviewedVariants].some((base) =>
      reviewedQuantityVariants(base).some((value) => digest(value) === expectedDigest));
  }
  return false;
}

function isExactNormalizedResource(existing: KubernetesResource,
  expected: KubernetesResource): boolean {
  const normalizedExisting = normalizedSubmittedResource(existing);
  const normalizedExpected = normalizedSubmittedResource(expected);
  canonicalizeServerOwnedFields(normalizedExisting, normalizedExpected, expected.kind);
  return canonicalJsonText(normalizedExisting) === canonicalJsonText(normalizedExpected);
}

function isOwnershipIdentity(resource: KubernetesResource): boolean {
  const value = resource as unknown as Record<string, unknown>;
  return Object.keys(value).every((key) =>
    key === "apiVersion" || key === "kind" || key === "metadata");
}

export function assertKubernetesResourceOwnership(
  existing: KubernetesResource,
  expected: KubernetesResource,
  requestDigest: string,
  expectedUid?: string,
  expectedConfigDigest?: string,
  secretProofKey?: string | Buffer,
): string {
  const configDigest = expectedConfigDigest ??
    kubernetesResourceConfigurationDigest(expected, secretProofKey);
  const boundExpected = bindResourceConfiguration(expected, configDigest);
  const expectedOwner = expected.metadata.annotations?.[
    "codeops.example/materialization-owner"
  ];
  if (
    existing.apiVersion !== boundExpected.apiVersion ||
    existing.kind !== boundExpected.kind ||
    existing.metadata.name !== boundExpected.metadata.name ||
    existing.metadata.namespace !== boundExpected.metadata.namespace ||
    existing.metadata.annotations?.["codeops.example/request-digest"] !== requestDigest ||
    ((existing.kind === "Secret" || expectedOwner !== undefined) &&
      existing.metadata.annotations?.["codeops.example/materialization-owner"] !== expectedOwner) ||
    typeof existing.metadata.uid !== "string" ||
    existing.metadata.uid.length < 1 ||
    (expectedUid !== undefined && existing.metadata.uid !== expectedUid) ||
    existing.metadata.annotations?.[resourceConfigurationAnnotation] !== configDigest ||
    (existing.kind === "Secret" &&
      (typeof existing.metadata.resourceVersion !== "string" ||
        !/^[^\s]{1,256}$/.test(existing.metadata.resourceVersion) ||
        kubernetesResourceConfigurationDigest(existing, secretProofKey) !== configDigest)) ||
    (existing.kind !== "Secret" && isOwnershipIdentity(expected) &&
      !observedResourceConfigurationMatches(existing, configDigest)) ||
    !(isOwnershipIdentity(expected)
      ? containsExpected(
        immutableResourceConfiguration(existing),
        immutableResourceConfiguration(boundExpected),
      )
      : isExactNormalizedResource(existing, boundExpected))
  ) {
    throw new KubernetesResourceIdentityDriftError(
      "existing Kubernetes resource is not owned by the admitted materialization",
    );
  }
  return existing.metadata.uid;
}

export function createInClusterKubernetesClient(input: {
  namespace: string;
  host: string;
  port: number;
  token: string | (() => Promise<string>);
  ca: Buffer;
  secretProofKey?: string | Buffer;
  request?: (method: string, requestPath: string, body?: unknown,
    expected?: readonly number[], contentType?: string, token?: string) =>
      Promise<{ status: number; text: string }>;
}): KubernetesClient {
  class KubernetesHttpStatusError extends Error {
    constructor(readonly status: number) { super(`Kubernetes API returned ${status}`); }
  }
  const token = async (): Promise<string> => {
    const value = (typeof input.token === "string" ? input.token : await input.token()).trim();
    if (value.length < 1 || value.length > 4_096 || /\s/.test(value)) {
      throw new Error("projected Kubernetes service account token is invalid");
    }
    return value;
  };
  const networkRequest = async (
    method: string,
    requestPath: string,
    body?: unknown,
    expected: readonly number[] = [200],
    contentType = "application/json",
    bearer?: string,
  ): Promise<{ status: number; text: string }> => {
    const authorization = bearer ?? await token();
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: input.host,
          port: input.port,
          method,
          path: `/${requestPath}`,
          ca: input.ca,
          headers: {
            Authorization: `Bearer ${authorization}`,
            Accept: "application/json",
            ...(encoded
              ? {
                  "Content-Type": contentType,
                  "Content-Length": String(encoded.length),
                }
              : {}),
          },
          timeout: 30_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk) => {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 4_000_000) {
              req.destroy(new Error("Kubernetes response exceeded 4 MiB"));
              return;
            }
            chunks.push(buffer);
          });
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            if (!expected.includes(status)) {
              reject(new KubernetesHttpStatusError(status));
              return;
            }
            resolve({ status, text });
          });
        },
      );
      req.once("timeout", () => req.destroy(new Error("Kubernetes API timeout")));
      req.once("error", reject);
      if (encoded) req.write(encoded);
      req.end();
    });
  };
  const request = input.request ?? networkRequest;
  const call = async <Result = { status: number; text: string }>(
    operation: KubernetesOperation, method: string, requestPath: string,
    body?: unknown, expected?: readonly number[], contentType?: string,
    validate?: (response: { status: number; text: string }) => Result,
  ): Promise<Result> => {
    try {
      const response = await request(
        method, requestPath, body, expected, contentType, await token(),
      );
      if (validate === undefined) return response as Result;
      try {
        return validate(response);
      } catch (error) {
        if (error instanceof KubernetesResourceIdentityDriftError) throw error;
        throw new KubernetesResponseError(operation, response.status, { cause: error });
      }
    } catch (error) {
      if (error instanceof KubernetesApiError ||
          error instanceof KubernetesResourceIdentityDriftError) throw error;
      throw new KubernetesApiError(operation,
        error instanceof KubernetesHttpStatusError && error.status > 0 ? error.status : null,
        { cause: error });
    }
  };

  const jsonRecord = (text: string): Record<string, unknown> => {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Kubernetes JSON response must be an object");
    }
    return value as Record<string, unknown>;
  };
  const validResourceName = (value: unknown): value is string => typeof value === "string" &&
    value.length >= 1 && value.length <= 253 &&
    /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value);
  const validNamespace = (value: unknown): value is string => typeof value === "string" &&
    value.length >= 1 && value.length <= 63 &&
    /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);
  const validUid = (value: unknown): value is string => typeof value === "string" &&
    value.length >= 1 && value.length <= 128 && /^[!-~]+$/.test(value);
  const resourceRecord = (value: Record<string, unknown>): KubernetesResource => {
    const metadata = record(value.metadata);
    if (typeof value.apiVersion !== "string" || typeof value.kind !== "string" ||
        metadata === undefined || !validResourceName(metadata.name) ||
        !validNamespace(metadata.namespace) || !validUid(metadata.uid)) {
      throw new Error("Kubernetes resource response shape is invalid");
    }
    return value as unknown as KubernetesResource;
  };
  const resourceResponse = (text: string): KubernetesResource =>
    resourceRecord(jsonRecord(text));
  const exactResourceResponse = (text: string, expected: KubernetesResource): KubernetesResource => {
    const value = resourceResponse(text);
    if (value.apiVersion !== expected.apiVersion || value.kind !== expected.kind ||
        value.metadata.namespace !== expected.metadata.namespace ||
        value.metadata.name !== expected.metadata.name) {
      throw new Error("Kubernetes resource response identity is invalid");
    }
    return value;
  };
  const exactResourceListResponse = (text: string, expected: KubernetesResource): KubernetesResource[] => {
    const value = jsonRecord(text);
    const listApiVersion = expected.apiVersion;
    const listKind = `${expected.kind}List`;
    if (value.apiVersion !== listApiVersion || value.kind !== listKind || !Array.isArray(value.items)) {
      throw new Error("Kubernetes resource list response identity is invalid");
    }
    return value.items.map((item) => {
      const itemRecord = record(item);
      if (itemRecord === undefined) throw new Error("Kubernetes resource list item is invalid");
      const resource = resourceRecord(itemRecord);
      if (resource.apiVersion !== expected.apiVersion || resource.kind !== expected.kind ||
          resource.metadata.namespace !== expected.metadata.namespace) {
        throw new Error("Kubernetes resource list item identity is invalid");
      }
      return resource;
    });
  };
  const deleteResponse = (text: string, expected: KubernetesResource, expectedUid: string): void => {
    const value = jsonRecord(text);
    if (value.kind === "Status") {
      const details = record(value.details);
      const expectedGroup = expected.apiVersion.includes("/")
        ? expected.apiVersion.slice(0, expected.apiVersion.indexOf("/")) : "";
      const expectedStatusKind = resourcePaths[expected.kind]?.split("/").at(-1);
      if (value.apiVersion !== "v1" || value.status !== "Success" || details === undefined ||
          details.kind !== expectedStatusKind || details.name !== expected.metadata.name ||
          details.uid !== expectedUid ||
          (details.group === undefined ? "" : details.group) !== expectedGroup) {
        throw new Error("Kubernetes delete Status response identity is invalid");
      }
      return;
    }
    const deleted = exactResourceResponse(text, expected);
    if (deleted.metadata.uid !== expectedUid) {
      throw new Error("Kubernetes deleted resource UID is invalid");
    }
  };

  const collectionPath = (resource: KubernetesResource): string => {
    const template = resourcePaths[resource.kind];
    if (!template) throw new Error(`unsupported Kubernetes kind ${resource.kind}`);
    return template.replace("{namespace}", input.namespace);
  };

  return {
    async ensure(resource, requestDigest, expectedUid, persistedConfigDigest) {
      const collection = collectionPath(resource);
      const configDigest = persistedConfigDigest ??
        kubernetesResourceConfigurationDigest(resource, input.secretProofKey);
      const expected = bindResourceConfiguration(resource, configDigest);
      if (expectedUid !== undefined) {
        const loaded = await call("ensure",
          "GET",
          `${collection}/${encodeURIComponent(resource.metadata.name)}`,
          undefined,
          [200, 404],
          undefined,
          (response) => ({ ...response, resource: response.status === 404
            ? null : exactResourceResponse(response.text, expected) }),
        );
        if (loaded.status === 404) {
          throw new KubernetesResourceIdentityDriftError(
            "persisted Kubernetes resource is missing",
          );
        }
        const uid = assertKubernetesResourceOwnership(
          loaded.resource!,
          expected,
          requestDigest,
          expectedUid,
          configDigest,
          input.secretProofKey,
        );
        return { uid, configDigest };
      }
      const created = await call("ensure", "POST", collection, expected, [201, 409], undefined,
        (response) => ({ ...response, resource: response.status === 201
          ? exactResourceResponse(response.text, expected) : null }));
      if (created.status === 201) {
        const createdResource = created.resource!;
        if (!isExactNormalizedResource(createdResource, expected)) {
          throw new KubernetesResourceIdentityDriftError(
            "created Kubernetes resource drifted from the exact submitted configuration",
          );
        }
        const uid = assertKubernetesResourceOwnership(
          createdResource, expected, requestDigest, undefined, configDigest, input.secretProofKey,
        );
        return { uid, configDigest };
      }
      const existing = await call("ensure", "GET",
        `${collection}/${encodeURIComponent(resource.metadata.name)}`, undefined, undefined,
        undefined, (response) => exactResourceResponse(response.text, expected));
      if (existing.metadata.annotations?.[resourceConfigurationAnnotation] === undefined) {
        const expectedAnnotations = resource.metadata.annotations ?? {};
        const existingAnnotations = existing.metadata.annotations ?? {};
        const expectedLabels = (resource.metadata as unknown as {
          labels?: Readonly<Record<string, string>>;
        }).labels ?? {};
        const existingLabels = (existing.metadata as unknown as {
          labels?: Readonly<Record<string, string>>;
        }).labels ?? {};
        const uid = existing.metadata.uid;
        const resourceVersion = existing.metadata.resourceVersion;
        if (typeof uid !== "string" || uid.length < 1 ||
            typeof resourceVersion !== "string" || resourceVersion.length < 1 ||
            canonicalJsonText(existingAnnotations) !== canonicalJsonText(expectedAnnotations) ||
            canonicalJsonText(existingLabels) !== canonicalJsonText(expectedLabels) ||
            !isExactNormalizedResource(existing, resource)) {
          throw new KubernetesResourceIdentityDriftError(
            "existing Kubernetes resource is not an exact legacy resource",
          );
        }
        const adoptedResponse = await call("ensure",
          "PATCH",
          `${collection}/${encodeURIComponent(resource.metadata.name)}`,
          { metadata: { uid, resourceVersion, annotations: {
            [resourceConfigurationAnnotation]: configDigest,
          } } },
          [200],
          "application/merge-patch+json",
          (response) => exactResourceResponse(response.text, expected),
        );
        const adoptedUid = assertKubernetesResourceOwnership(
          adoptedResponse,
          expected,
          requestDigest,
          uid,
          configDigest,
          input.secretProofKey,
        );
        return { uid: adoptedUid, configDigest };
      }
      const uid = assertKubernetesResourceOwnership(
        existing, expected, requestDigest, undefined, configDigest, input.secretProofKey,
      );
      return { uid, configDigest };
    },
    async getJob(name) {
      return await call("get-job",
        "GET",
        `apis/batch/v1/namespaces/${input.namespace}/jobs/${encodeURIComponent(name)}`,
        undefined, undefined, undefined, (response) => {
          const job = exactResourceResponse(response.text, { apiVersion: "batch/v1", kind: "Job",
            metadata: { namespace: input.namespace, name } });
          return job as unknown as Record<string, unknown>;
        },
      );
    },
    async listRunPods(runId, boundedIdentity = false) {
      const selector = encodeURIComponent(
        `codeops.example/run-id=${boundedIdentity ? kubernetesIdentityLabel(runId) : runId}`,
      );
      return await call("list-pods",
        "GET",
        `api/v1/namespaces/${input.namespace}/pods?labelSelector=${selector}`,
        undefined, undefined, undefined, (response) => {
          const list = jsonRecord(response.text);
          if (list.apiVersion !== "v1" || list.kind !== "PodList" || !Array.isArray(list.items)) {
            throw new Error("Kubernetes Pod list response shape is invalid");
          }
          return list.items.map((item) => {
            const podRecord = record(item);
            if (podRecord === undefined) throw new Error("Kubernetes Pod response shape is invalid");
            const pod = resourceRecord(podRecord);
            if (pod.apiVersion !== "v1" || pod.kind !== "Pod" ||
                pod.metadata.namespace !== input.namespace) {
              throw new Error("Kubernetes Pod response identity is invalid");
            }
            return pod as unknown as Record<string, unknown>;
          });
        },
      );
    },
    async getPodLogs(name, container) {
      return (
        await call("get-pod-logs",
          "GET",
          `api/v1/namespaces/${input.namespace}/pods/${encodeURIComponent(name)}/log?container=${encodeURIComponent(container)}`,
        )
      ).text;
    },
    async delete(resource, requestDigest, expectedUid, expectedConfigDigest) {
      if (requestDigest === undefined || expectedUid === undefined ||
          expectedConfigDigest === undefined) {
        throw new KubernetesResourceIdentityDriftError(
          "Kubernetes cleanup requires an exact persisted resource binding",
        );
      }
      let body: Record<string, unknown> = { propagationPolicy: "Background" };
      {
        const collection = collectionPath(resource);
        const loaded = await call("delete",
          "GET",
          `${collection}/${encodeURIComponent(resource.metadata.name)}`,
          undefined,
          [200, 404],
          undefined,
          (response) => ({ ...response, resource: response.status === 404
            ? null : exactResourceResponse(response.text, resource) }),
        );
        if (loaded.status === 404) return;
        const uid = assertKubernetesResourceOwnership(
          loaded.resource!,
          resource,
          requestDigest,
          expectedUid,
          expectedConfigDigest,
          input.secretProofKey,
        );
        body = { ...body, preconditions: { uid } };
      }
      await call("delete",
        "DELETE",
        `${collectionPath(resource)}/${encodeURIComponent(resource.metadata.name)}`,
        body,
        [200, 202, 404],
        undefined,
        (response) => {
          if (response.status !== 404) deleteResponse(response.text, resource, expectedUid);
        },
      );
    },
    async recoverOwned(resource, requestDigest) {
      const collection = collectionPath(resource);
      let loaded = await call("recover", "GET",
        `${collection}/${encodeURIComponent(resource.metadata.name)}`, undefined, [200, 404],
        undefined, (response) => ({ ...response, resource: response.status === 404
          ? null : exactResourceResponse(response.text, resource) }));
      if (resource.kind === "Secret" && resource.metadata.name.endsWith("-source")) {
        const prefix = `${resource.metadata.name}-`;
        const labels = (resource.metadata as unknown as {
          readonly labels?: Readonly<Record<string, string>>;
        }).labels;
        const selector = labels === undefined ? "" : encodeURIComponent(Object.entries(labels)
          .filter(([key]) => key === "codeops.example/launch-id" ||
            key === "codeops.example/admission-id" || key === "codeops.example/resource-role")
          .map(([key, value]) => `${key}=${value}`).join(","));
        if (selector !== "") {
          const listed = await call("recover", "GET", `${collection}?labelSelector=${selector}`,
            undefined, [200], undefined,
            (response) => exactResourceListResponse(response.text, resource));
          const legacy = listed.filter((item) =>
            item.metadata.name.startsWith(prefix) &&
            /^[0-9a-f]{10}$/.test(item.metadata.name.slice(prefix.length)));
          if (legacy.length > 1 || (legacy.length === 1 && loaded.status !== 404)) {
            throw new KubernetesResourceIdentityDriftError(
              "multiple current or legacy resource identities exist",
            );
          }
          if (legacy.length === 1) loaded = { status: 200, text: "", resource: legacy[0]! };
        }
      }
      if (loaded.status === 404) return null;
      const existing = loaded.resource!;
      const configDigest = existing.metadata.annotations?.[resourceConfigurationAnnotation];
      if (typeof configDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(configDigest)) {
        // An unbound caller must pass this same-name object through ensure(),
        // which performs exact legacy comparison and a UID/resourceVersion-
        // fenced annotation patch. Recovery must not reject it first.
        if (existing.metadata.name === resource.metadata.name) return null;
        throw new KubernetesResourceIdentityDriftError("recoverable resource binding is missing");
      }
      const recoveryIdentity = resource.kind === "Secret"
        ? { apiVersion: resource.apiVersion, kind: resource.kind, metadata: {
            ...resource.metadata, name: existing.metadata.name,
          } }
        : { ...resource, metadata: { ...resource.metadata, name: existing.metadata.name } };
      const uid = assertKubernetesResourceOwnership(
        existing, recoveryIdentity, requestDigest, undefined, configDigest,
        input.secretProofKey,
      );
      const expectedValue = resource as unknown as Record<string, unknown>;
      const canCompareExpected = resource.kind !== "Secret" || expectedValue.data !== undefined;
      const desiredConfigDigest = canCompareExpected
        ? kubernetesResourceConfigurationDigest(resource, input.secretProofKey)
        : undefined;
      return { uid, configDigest,
        ...(existing.metadata.name === resource.metadata.name ? {} : {
          resourceName: existing.metadata.name,
        }),
        matchesExpectedConfiguration: canCompareExpected &&
          existing.metadata.name === resource.metadata.name &&
          desiredConfigDigest === configDigest &&
          isExactNormalizedResource(existing, bindResourceConfiguration(resource, configDigest)),
        ...(desiredConfigDigest === undefined ? {} : { desiredConfigDigest }),
      };
    },
    async readResourceUid(resource) {
      const collection = collectionPath(resource);
      return await call("recover", "GET",
        `${collection}/${encodeURIComponent(resource.metadata.name)}`, undefined, [200, 404],
        undefined, (response) => response.status === 404 ? null :
          exactResourceResponse(response.text, resource).metadata.uid!);
    },
  };
}

export async function loadInClusterKubernetesClient(
  namespace: string,
  secretProofKey?: string | Buffer,
): Promise<KubernetesClient> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443");
  if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("in-cluster Kubernetes service identity is invalid");
  }
  return createInClusterKubernetesClient({
    namespace,
    host,
    port,
    token: async () => (
      await readFile(
        "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8",
      )
    ).trim(),
    ca: await readFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
    secretProofKey,
  });
}
