import type {
  SessionCheckpoint,
  LegacySessionIdentity,
  WorkspaceSessionIdentity,
} from "@codeops/codeops-contracts/session-broker";

type DisplaySessionIdentity = LegacySessionIdentity | WorkspaceSessionIdentity;

export function isWorkspaceIdentity(
  identity: DisplaySessionIdentity,
): identity is WorkspaceSessionIdentity {
  return "version" in identity &&
    identity.version === "codeops.session-workspace-identity/v1";
}

export function sessionWorkspaceLabel(identity: DisplaySessionIdentity): string {
  if (!isWorkspaceIdentity(identity)) return identity.branch;
  const count = identity.workspace.sources.length;
  if (count === 0) return "Scratch workspace";
  if (count === 1) return identity.workspace.sources[0]?.repository ?? "Workspace";
  return `${count} repositories`;
}

export function sessionWorkspaceDetail(identity: DisplaySessionIdentity): string {
  if (!isWorkspaceIdentity(identity)) {
    return `${identity.branch} · ${identity.baseSha.slice(0, 7)}`;
  }
  if (identity.workspace.sources.length === 0) return "Scratch workspace";
  return identity.workspace.sources
    .map((source) => `${source.catalogKey}@${source.resolvedSha.slice(0, 7)}`)
    .join(" · ");
}

export function sessionSearchText(identity: DisplaySessionIdentity): string {
  const common = `${identity.workflowId} ${identity.runId}`;
  if (!isWorkspaceIdentity(identity)) {
    return `${common} ${identity.repository} ${identity.branch} ${identity.baseSha}`;
  }
  return `${common} ${identity.workspace.sources
    .map((source) =>
      `${source.catalogKey} ${source.repository} ${source.requestedRef} ${source.resolvedSha}`,
    )
    .join(" ")} scratch`;
}

export function checkpointPatchLabel(
  checkpoint: SessionCheckpoint | null,
): string {
  if (!checkpoint) return "Not checkpointed";
  if (checkpoint.version === "codeops.session-checkpoint/v1") {
    return checkpoint.patchDigest.slice(0, 18);
  }
  const count = checkpoint.sourcePatches.length;
  return count === 0 ? "Scratch artifact" : `${count} source patch${count === 1 ? "" : "es"}`;
}
