import { readFile } from "node:fs/promises";
import { renderPlaneControllerManifest } from "./codeops-plane-controller-render.mjs";

const template = await readFile(
  new URL(
    "../k8s/codeops/trial0/plane-controller-template.yaml",
    import.meta.url,
  ),
  "utf8",
);

process.stdout.write(
  renderPlaneControllerManifest(template, {
    controllerDigest: process.env.CODEOPS_PLANE_CONTROLLER_DIGEST ?? "",
    controllerHost: process.env.CODEOPS_PLANE_CONTROLLER_HOST ?? "",
    workspaceSlug: process.env.CODEOPS_PLANE_WORKSPACE_SLUG ?? "",
    allowedHumanActorIds: process.env.CODEOPS_ALLOWED_HUMAN_ACTOR_IDS ?? "",
    allowedGithubReviewerIds:
      process.env.CODEOPS_ALLOWED_GITHUB_REVIEWER_IDS ?? "",
    personaUserIds: process.env.CODEOPS_PERSONA_USER_IDS ?? "",
    readyStateId: process.env.CODEOPS_READY_STATE_ID ?? "",
    inProgressStateId: process.env.CODEOPS_IN_PROGRESS_STATE_ID ?? "",
    needsAttentionStateId:
      process.env.CODEOPS_NEEDS_ATTENTION_STATE_ID ?? "",
    completeStateId: process.env.CODEOPS_COMPLETE_STATE_ID ?? "",
    controlPlaneSha: process.env.CODEOPS_CONTROL_PLANE_SHA ?? "",
  }),
);
