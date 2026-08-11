import { readFile } from "node:fs/promises";
import { renderSessionProofGrantsManifest } from "./codeops-session-proof-grants-render.mjs";

const template = await readFile(new URL("../k8s/codeops/trial0/session-proof-grants-template.yaml", import.meta.url), "utf8");
process.stdout.write(renderSessionProofGrantsManifest(
  template,
  process.env.CODEOPS_SESSION_PROOF_POSTGRES_DIGEST ?? "",
));
