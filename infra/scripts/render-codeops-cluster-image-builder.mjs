import { readFile } from "node:fs/promises";
import { renderClusterImageBuilderManifest } from "./codeops-cluster-build-render.mjs";

const template = await readFile(
  new URL(
    "../k8s/codeops/trial0/cluster-image-builder-template.yaml",
    import.meta.url,
  ),
  "utf8",
);

process.stdout.write(
  renderClusterImageBuilderManifest(template, {
    baseSha: process.env.CODEOPS_BASE_SHA ?? "",
    buildId: process.env.CODEOPS_BUILD_ID ?? "",
    imageKind: process.env.CODEOPS_IMAGE_KIND ?? "",
  }),
);
