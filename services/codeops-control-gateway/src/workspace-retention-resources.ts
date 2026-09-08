import { canonicalJsonText } from "@codeops/codeops-contracts";
import { retainedResourceSchema, workspaceRetentionTargetSchema,
  nextWorkspaceReclamationStep,
  type WorkspaceRetentionTarget, type WorkspaceRetentionResources,
  type WorkspaceRetentionInventory } from "./workspace-retention.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Kubernetes object");
  return value as ObjectValue;
}
function equal(a: unknown, b: unknown): void {
  if (canonicalJsonText(a) !== canonicalJsonText(b)) throw new Error("retention resource identity drift");
}
const annotation = "codeops.example/";

/** Uses the authenticated control-gateway Kubernetes transport. get returns
 * null ONLY for an authoritative 404; errors and incomplete lists must throw.
 * No provider mutation method exists on this adapter. */
export function createWorkspaceRetentionResources(input: {
  readonly namespace: string;
  readonly verifyOwned: (raw: unknown, target: WorkspaceRetentionTarget,
    resource: WorkspaceRetentionTarget["job"]) => void;
  readonly get: (path: string) => Promise<unknown | null>;
  readonly remove: (path: string, options: {
    propagationPolicy: "Foreground"; preconditions: { uid: string; resourceVersion: string };
  }) => Promise<void>;
  readonly providerInventory: (volume: WorkspaceRetentionTarget["pv"]) => Promise<{
    observedAt: string; state: "present" | "absent" | "unknown";
    providerVolumes: number; volumeQuota: number;
  }>;
}): WorkspaceRetentionResources {
  const namespaced = `api/v1/namespaces/${encodeURIComponent(input.namespace)}`;
  const jobsPath = `apis/batch/v1/namespaces/${encodeURIComponent(input.namespace)}/jobs`;
  const path = (resource: { kind: string; name: string }) => `${resource.kind === "Job" ? jobsPath
    : `${namespaced}/${resource.kind === "Pod" ? "pods" : "persistentvolumeclaims"}`}/${encodeURIComponent(resource.name)}`;
  const checkTarget = (target: WorkspaceRetentionTarget) => {
    workspaceRetentionTargetSchema.parse(target);
    if (target.namespace !== input.namespace) throw new Error("retention namespace drift");
  };
  async function list(pathname: string, apiVersion: string, kind: string): Promise<ObjectValue[]> {
    const response = object(await input.get(`${pathname}?limit=1000`));
    equal(response.apiVersion, apiVersion);
    equal(response.kind, `${kind}List`);
    const metadata = object(response.metadata);
    if (metadata.continue || !Array.isArray(response.items) || response.items.length > 1000) {
      throw new Error("retention inventory incomplete");
    }
    return response.items.map(raw => {
      // Typed collections can omit item TypeMeta. Only the verified collection
      // supplies defaults; explicit item mismatches remain invalid.
      const item = { apiVersion, kind, ...object(raw) };
      equal(item.apiVersion, apiVersion);
      equal(item.kind, kind);
      return item;
    });
  }
  function reference(resource: ObjectValue, kind: string, target: WorkspaceRetentionTarget) {
    const meta = object(resource.metadata);
    equal(meta.namespace, target.namespace);
    const annotations = object(meta.annotations ?? {});
    const labels = object(meta.labels ?? {});
    equal(labels[`${annotation}launch-id`], target.launchId);
    equal(annotations[`${annotation}request-digest`], target.requestDigest);
    if (kind === "Pod") {
      if (!Array.isArray(meta.ownerReferences) || meta.ownerReferences.length !== 1) throw new Error("ambiguous Pod owner");
      const owner = object(meta.ownerReferences[0]);
      if (owner.kind !== "Job" || owner.uid !== target.job.uid || owner.name !== target.job.name || owner.controller !== true) {
        throw new Error("Pod owner drift");
      }
    }
    const retained = retainedResourceSchema.parse({ kind, name: meta.name, uid: meta.uid,
      configDigest: kind === "Pod" ? target.job.configDigest : annotations[`${annotation}resource-configuration-digest`] });
    if (kind !== "Pod") input.verifyOwned(resource, target, retained);
    return retained;
  }
  function referencesPvc(resource: ObjectValue, job: boolean, claimName: string): boolean {
    const spec = object(job ? object(object(resource.spec).template).spec : resource.spec);
    if (spec.volumes === undefined) return false;
    if (!Array.isArray(spec.volumes)) throw new Error("invalid volume references");
    return spec.volumes.some(raw => {
      const volume = object(raw);
      return volume.persistentVolumeClaim !== undefined && object(volume.persistentVolumeClaim).claimName === claimName;
    });
  }
  return {
    async observe(target): Promise<WorkspaceRetentionInventory> {
      checkTarget(target);
      const jobs = await list(jobsPath, "batch/v1", "Job");
      const pods = await list(`${namespaced}/pods`, "v1", "Pod");
      const claims = await list(`${namespaced}/persistentvolumeclaims`, "v1", "PersistentVolumeClaim");
      const volumes = await list("api/v1/persistentvolumes", "v1", "PersistentVolume");
      const rawJob = jobs.find(r => object(r.metadata).name === target.job.name);
      const referencingJobs = jobs.filter(r => r === rawJob || referencesPvc(r, true, target.pvc.name));
      const referencingPods = pods.filter(r => referencesPvc(r, false, target.pvc.name) ||
        target.pods.some(p => p.name === object(r.metadata).name));
      const rawPvc = claims.find(r => object(r.metadata).name === target.pvc.name);
      const rawPv = volumes.find(r => object(r.metadata).name === target.pv.name);
      if (rawPvc && object(rawPvc.spec).volumeName !== target.pv.name) throw new Error("PVC volume binding drift");
      let pv: WorkspaceRetentionTarget["pv"] | null = null;
      if (rawPv) {
        const metadata = object(rawPv.metadata);
        const spec = object(rawPv.spec);
        const claim = object(spec.claimRef);
        if (claim.uid !== target.pvc.uid || claim.name !== target.pvc.name || claim.namespace !== target.namespace ||
            spec.persistentVolumeReclaimPolicy !== "Delete") throw new Error("PV ownership or reclaim policy drift");
        const csi = object(spec.csi);
        pv = { name: String(metadata.name), uid: String(metadata.uid), driver: String(csi.driver), volumeHandle: String(csi.volumeHandle) };
      }
      // A second PV with this handle is ambiguity, including a replacement name.
      if (volumes.some(v => v !== rawPv && object(v.spec).csi !== undefined &&
          object(object(v.spec).csi).volumeHandle === target.pv.volumeHandle)) throw new Error("provider volume has another PV");
      const provider = await input.providerInventory(target.pv);
      const all = [...referencingJobs, ...referencingPods, ...(rawPvc ? [rawPvc] : []), ...(rawPv ? [rawPv] : [])];
      const pvcMetadata = rawPvc ? object(rawPvc.metadata) : null;
      return { observedAt: provider.observedAt, jobs: referencingJobs.map(j => reference(j, "Job", target)),
        pods: referencingPods.map(p => reference(p, "Pod", target)),
        pvc: rawPvc ? reference(rawPvc, "PersistentVolumeClaim", target) : null, pv,
        providerVolume: provider.state,
        capacity: { workspaceVolumes: claims.filter(c => object(object(c.metadata).labels ?? {})[`${annotation}resource-role`] === "workspace-storage").length,
          providerVolumes: provider.providerVolumes, volumeQuota: provider.volumeQuota,
          releasedPvs: volumes.filter(v => object(v.status ?? {}).phase === "Released").length },
        pvcProtected: Boolean(pvcMetadata?.deletionTimestamp && Array.isArray(pvcMetadata.finalizers) && pvcMetadata.finalizers.includes("kubernetes.io/pvc-protection")),
        explicitKeep: all.some(r => {
          const a = object(object(r.metadata).annotations ?? {});
          return a[`${annotation}keep`] !== undefined || a[`${annotation}retention-hold`] !== undefined;
        }),
        successorAttached: referencingJobs.some(j => object(j.metadata).uid !== target.job.uid),
      };
    },
    async deleteExact(target, resource) {
      checkTarget(target);
      const expected = resource.kind === "Job" ? target.job : resource.kind === "Pod"
        ? target.pods.find(p => p.uid === resource.uid) : target.pvc;
      if (!expected) throw new Error("resource is not in retention receipt");
      equal(resource, expected);
      // Reobserve all references and keeps immediately before the conditional
      // delete. UID/version conditions fence changes to the object itself.
      const fresh = await this.observe(target);
      const step = nextWorkspaceReclamationStep(target, fresh);
      if (step.type !== "delete") return;
      equal(step.resource, resource);
      const raw = await input.get(path(resource));
      if (raw === null) return;
      const live = object(raw);
      equal(reference(live, resource.kind, target), resource);
      const metadata = object(live.metadata);
      const annotations = object(metadata.annotations ?? {});
      if (annotations[`${annotation}keep`] !== undefined || annotations[`${annotation}retention-hold`] !== undefined) throw new Error("resource keep added");
      if (typeof metadata.resourceVersion !== "string" || !/^\d+$/.test(metadata.resourceVersion)) throw new Error("resource version missing");
      await input.remove(path(resource), { propagationPolicy: "Foreground",
        preconditions: { uid: resource.uid, resourceVersion: metadata.resourceVersion } });
    },
  };
}
