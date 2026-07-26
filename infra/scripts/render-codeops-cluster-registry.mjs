import { readFile } from "node:fs/promises";
import { renderClusterRegistryManifest } from "./codeops-cluster-build-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/cluster-registry-template.yaml", import.meta.url),
  "utf8",
);

process.stdout.write(
  renderClusterRegistryManifest(template, {
    baseSha: process.env.CODEOPS_BASE_SHA ?? "",
    registryHost: process.env.CODEOPS_REGISTRY_HOST ?? "",
  }),
);
