import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";

const temporalAddress = process.env.CODEOPS_TEMPORAL_ADDRESS;
if (!temporalAddress) {
  throw new Error("CODEOPS_TEMPORAL_ADDRESS is required");
}

const connection = await NativeConnection.connect({
  address: temporalAddress,
});

const worker = await Worker.create({
  connection,
  namespace: process.env.CODEOPS_TEMPORAL_NAMESPACE ?? "codeops",
  taskQueue: process.env.CODEOPS_TEMPORAL_TASK_QUEUE ?? "codeops-trial0",
  workflowsPath: fileURLToPath(new URL("./workflow.js", import.meta.url)),
  activities,
  maxConcurrentActivityTaskExecutions: 1,
  maxConcurrentWorkflowTaskExecutions: 4,
});

await worker.run();
