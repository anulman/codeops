import { readFile } from "node:fs/promises";
import {
  sessionIdentitySchema,
  workspaceManifestSchema,
  type SessionIdentity,
} from "@codeops/codeops-contracts";

const MAX_WORKSPACE_MANIFEST_BYTES = 32 * 1_024;

export async function loadRuntimeSessionIdentity(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly read?: typeof readFile;
}): Promise<SessionIdentity> {
  const required = (name: string): string => {
    const value = input.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const common = {
    workflowId: required("CODEOPS_SESSION_WORKFLOW_ID"),
    runId: required("CODEOPS_SESSION_RUN_ID"),
    ...(input.env.CODEOPS_SESSION_DISPLAY_NAME?.trim()
      ? { displayName: input.env.CODEOPS_SESSION_DISPLAY_NAME.trim() }
      : {}),
    parentSessionId: null,
    forkedAtCursor: null,
  } as const;
  const workspaceFile = input.env.CODEOPS_SESSION_WORKSPACE_FILE?.trim();
  const workspaceJson = input.env.CODEOPS_SESSION_WORKSPACE_JSON?.trim();
  if (
    (workspaceFile === undefined || workspaceFile === "") &&
    (workspaceJson === undefined || workspaceJson === "")
  ) {
    return sessionIdentitySchema.parse({
      repository: required("CODEOPS_SESSION_REPOSITORY"),
      branch: required("CODEOPS_SESSION_BRANCH"),
      baseSha: required("CODEOPS_SESSION_BASE_SHA"),
      ...common,
    });
  }
  if (workspaceFile && workspaceJson) {
    throw new Error("workspace identity must use one manifest input");
  }
  const contents = workspaceJson
    ? Buffer.from(workspaceJson)
    : await (input.read ?? readFile)(workspaceFile!);
  if (contents.byteLength < 1 || contents.byteLength > MAX_WORKSPACE_MANIFEST_BYTES) {
    throw new Error("workspace manifest must contain 1 to 32768 bytes");
  }
  return sessionIdentitySchema.parse({
    version: "codeops.session-workspace-identity/v1",
    workspace: workspaceManifestSchema.parse(JSON.parse(contents.toString("utf8"))),
    ...common,
  });
}
