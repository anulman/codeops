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
    baseSha: process.env.CODEOPS_BASE_SHA ?? "",
  }),
);
