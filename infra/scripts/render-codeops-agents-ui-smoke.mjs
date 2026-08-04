import { readFile } from "node:fs/promises";
import { renderAgentsUiSmokeManifest } from "./codeops-agents-ui-smoke-render.mjs";

const template = await readFile(
  new URL("../k8s/codeops/trial0/agents-ui-smoke-template.yaml", import.meta.url),
  "utf8",
);
process.stdout.write(
  renderAgentsUiSmokeManifest(
    template,
    process.env.CODEOPS_ACCEPTANCE_RUNNER_DIGEST ?? "",
  ),
);
