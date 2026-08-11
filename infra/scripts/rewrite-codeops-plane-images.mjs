import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { rewritePlaneImages } from "./codeops-plane-images.mjs";

const lockIndex = process.argv.indexOf("--lock");
const lockPath =
  lockIndex === -1
    ? "infra/k8s/codeops/trial0/plane-images.lock.json"
    : process.argv[lockIndex + 1];
if (!lockPath) {
  console.error("usage: rewrite-codeops-plane-images.mjs [--lock <path>]");
  process.exit(2);
}

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const manifests = Buffer.concat(chunks).toString("utf8");
const imageLock = JSON.parse(await readFile(lockPath, "utf8"));
const result = rewritePlaneImages(manifests, imageLock);
stdout.write(result.manifests);
