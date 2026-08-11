import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { evaluateCodeOpsCapacity } from "./codeops-capacity.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function kubectl(...args) {
  return JSON.parse(execFileSync("kubectl", args, { encoding: "utf8" }));
}

const snapshotPath = option("--snapshot");
let snapshot;
if (snapshotPath) {
  snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
} else {
  const nodes = kubectl(
    "get",
    "nodes",
    "-l",
    "codeops.example/codeops=true",
    "-o",
    "json",
  ).items;
  if (nodes.length !== 1) {
    console.error(`expected exactly one CodeOps node; found ${nodes.length}`);
    process.exit(1);
  }
  snapshot = {
    node: nodes[0],
    metrics: kubectl(
      "get",
      "--raw",
      `/apis/metrics.k8s.io/v1beta1/nodes/${nodes[0].metadata.name}`,
    ),
  };
}

const result = evaluateCodeOpsCapacity(snapshot, {
  requiredCpuMillis: Number(option("--required-cpu-millis", 2_500)),
  requiredMemoryBytes: Number(option("--required-memory-bytes", 8 * 2 ** 30)),
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
