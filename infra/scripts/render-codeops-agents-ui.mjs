import { readFile } from "node:fs/promises";
import { renderAgentsUiManifest } from "./codeops-agents-ui-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agents-ui-template.yaml", import.meta.url),
  "utf8",
);
process.stdout.write(
  renderAgentsUiManifest(
    template,
    process.env.CODEOPS_AGENTS_UI_DIGEST ?? "",
  ),
);
