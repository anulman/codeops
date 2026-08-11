#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const cluster = process.argv.slice(2).includes("--cluster");
const json = process.argv.slice(2).includes("--json");

function command(name, args = ["--version"], required = true) {
  try {
    const value = execFileSync(name, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().split("\n")[0];
    return { name, ok: true, value };
  } catch {
    return { name, ok: !required, required, value: "unavailable" };
  }
}

const checks = [
  { name: "node", ok: Number(process.versions.node.split(".")[0]) === 24, value: process.versions.node, required: true },
  command("nub"),
  command("git"),
  command("helm", ["version", "--short"]),
  command("kubectl", ["version", "--client=true"], cluster),
  command("docker", ["version", "--format", "{{.Client.Version}}"], false),
  command("gh", ["--version"], false),
];

if (cluster) {
  try {
    const ip = execFileSync("kubectl", ["get", "service", "kubernetes", "-o", "jsonpath={.spec.clusterIP}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    checks.push({ name: "kubernetes-api-service", ok: /^\d+\.\d+\.\d+\.\d+$/.test(ip), value: ip || "unavailable", required: true });
  } catch {
    checks.push({ name: "kubernetes-api-service", ok: false, value: "unavailable", required: true });
  }
}

if (json) {
  process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "ok" : "fail"}\t${check.name}\t${check.value}\n`);
  }
}

if (checks.some((check) => check.required !== false && !check.ok)) process.exitCode = 1;
