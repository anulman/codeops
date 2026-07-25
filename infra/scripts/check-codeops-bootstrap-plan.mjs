import { readFile } from "node:fs/promises";
import { evaluateBootstrapDeployPlan } from "./codeops-bootstrap-policy.mjs";

const planIndex = process.argv.indexOf("--plan");
if (planIndex === -1 || !process.argv[planIndex + 1]) {
  console.error("usage: node infra/scripts/check-codeops-bootstrap-plan.mjs --plan <path>");
  process.exit(2);
}

const plan = JSON.parse(await readFile(process.argv[planIndex + 1], "utf8"));
const result = evaluateBootstrapDeployPlan(plan);
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);

