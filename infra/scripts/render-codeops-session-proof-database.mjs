import { readFile } from "node:fs/promises";
import { renderSessionProofDatabaseManifest } from "./codeops-session-proof-database-render.mjs";

const template = await readFile(new URL("../k8s/codeops/trial0/session-proof-database-template.yaml", import.meta.url), "utf8");
process.stdout.write(renderSessionProofDatabaseManifest(
  template,
  process.env.CODEOPS_SESSION_PROOF_POSTGRES_DIGEST ?? "",
));
