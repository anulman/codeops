import { readFile } from "node:fs/promises";
import { renderOrchestratorManifest } from "./codeops-runtime-render.mjs";

const templatePath = new URL(
  "../k8s/codeops/trial0/orchestrator-template.yaml",
  import.meta.url,
);
const template = await readFile(templatePath, "utf8");
process.stdout.write(
  renderOrchestratorManifest(
    template,
    process.env.CODEOPS_ORCHESTRATOR_DIGEST ?? "",
  ),
);
