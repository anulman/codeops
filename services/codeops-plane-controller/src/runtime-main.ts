import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Client, Connection } from "@temporalio/client";
import {
  createFileResearchDedupLedger,
  createFileResearchPacketStore,
  createPlaneApiClient,
  loadProjectContextDocuments,
  projectResearchPacket,
  processPlaneReadyWebhook,
  processPlaneResearchWebhook,
} from "./index.js";
import {
  createPlaneWebhookRequestListener,
  createTemporalCodingEnqueuer,
  createTemporalResearchEnqueuer,
} from "./runtime.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

async function secretFile(name: string): Promise<string> {
  const value = (await readFile(required(name), "utf8")).trim();
  if (value.length === 0) throw new Error(`${name} is empty`);
  return value;
}

const temporalConnection = await Connection.connect({
  address: required("CODEOPS_TEMPORAL_ADDRESS"),
});
const temporalClient = new Client({
  connection: temporalConnection,
  namespace: process.env.CODEOPS_TEMPORAL_NAMESPACE ?? "codeops",
});
const planeClient = createPlaneApiClient({
  baseUrl: required("CODEOPS_PLANE_API_ORIGIN"),
  workspaceSlug: required("CODEOPS_PLANE_WORKSPACE_SLUG"),
  apiKey: await secretFile("CODEOPS_PLANE_API_KEY_FILE"),
});
const webhookSecret = await secretFile("CODEOPS_PLANE_WEBHOOK_SECRET_FILE");
const projectionToken = await secretFile(
  "CODEOPS_RESEARCH_PROJECTION_TOKEN_FILE",
);
if (projectionToken.length < 32 || projectionToken.length > 4_096) {
  throw new Error("CodeOps research projection token is invalid");
}
const allowedHumanActorIds = new Set(
  required("CODEOPS_ALLOWED_HUMAN_ACTOR_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
if (
  allowedHumanActorIds.size === 0 ||
  [...allowedHumanActorIds].some(
    (value) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      ),
  )
) {
  throw new Error("CODEOPS_ALLOWED_HUMAN_ACTOR_IDS must contain UUIDs");
}
const rawPersonaEntries = required("CODEOPS_PERSONA_USER_IDS")
  .split(",")
  .map((entry) => entry.split("="));
if (rawPersonaEntries.some((entry) => entry.length !== 2)) {
  throw new Error(
    "CODEOPS_PERSONA_USER_IDS must map all seven unique persona UUIDs",
  );
}
const personaEntries = rawPersonaEntries.map(
  (entry) => [entry[0]!, entry[1]!] as const,
);
const personaUserIds = new Map(
  personaEntries.map(([id, handle]) => [id, handle]),
);
const allowedPersonaHandles = new Set([
  "@ai-web",
  "@ai-security",
  "@ai-database",
  "@ai-infra",
  "@ai-design",
  "@ai-product",
  "@ai-ml",
]);
if (
  personaUserIds.size !== 7 ||
  [...personaUserIds].some(
    ([id, handle]) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      ) || !allowedPersonaHandles.has(handle),
  ) ||
  new Set(personaUserIds.values()).size !== allowedPersonaHandles.size
) {
  throw new Error(
    "CODEOPS_PERSONA_USER_IDS must map all seven unique persona UUIDs",
  );
}
const repository = {
  owner: required("CODEOPS_REPOSITORY_OWNER"),
  name: required("CODEOPS_REPOSITORY_NAME"),
};
if (
  !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.owner) ||
  !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.name)
) {
  throw new Error("CodeOps repository identity is invalid");
}
const baseSha = required("CODEOPS_BASE_SHA");
if (!/^[0-9a-f]{40}$/.test(baseSha)) {
  throw new Error("CODEOPS_BASE_SHA must be an exact lowercase Git SHA");
}
const projectContextDocuments = await loadProjectContextDocuments(
  process.env.CODEOPS_PROJECT_CONTEXT_ROOT ?? "/app/project-context",
);
const dedupRoot = required("CODEOPS_DEDUP_ROOT");
const ledger = createFileResearchDedupLedger({
  rootDirectory: dedupRoot,
  leaseDurationMs: 5 * 60 * 1_000,
});
const packetStore = createFileResearchPacketStore({
  rootDirectory: `${dedupRoot}/research-packets`,
});
const enqueue = createTemporalResearchEnqueuer({
  client: temporalClient,
  taskQueue: process.env.CODEOPS_TEMPORAL_TASK_QUEUE ?? "codeops-trial0",
});
const enqueueCoding = createTemporalCodingEnqueuer({
  client: temporalClient,
  taskQueue: process.env.CODEOPS_TEMPORAL_TASK_QUEUE ?? "codeops-trial0",
});
const readyStateId = required("CODEOPS_READY_STATE_ID");

const listener = createPlaneWebhookRequestListener({
  projection: {
    token: projectionToken,
    process: (packet) =>
      projectResearchPacket({
        packet,
        ledger,
        packetStore,
        client: planeClient,
      }),
  },
  process: async ({ rawBody, headers }) => {
    const shared = {
      rawBody,
      headers,
      webhookSecret,
      allowedHumanActorIds,
      repository,
      baseSha,
      receivedAt: new Date().toISOString(),
      projectContextDocuments,
      loadResearchPacket: (identity: {
        projectId: string;
        workItemId: string;
      }) => packetStore.getLatest(identity),
      loadSource: async ({
        projectId,
        workItemId,
      }: {
        projectId: string | undefined;
        workItemId: string;
      }) => {
        if (projectId === undefined) {
          throw new Error("Plane event omitted project identity");
        }
        return {
          project: await planeClient.getProjectSnapshot(projectId),
          workItem: await planeClient.getWorkItemSnapshot(
            projectId,
            workItemId,
          ),
          comments: await planeClient.getWorkItemComments(projectId, workItemId),
          relations: await planeClient.getWorkItemRelations(
            projectId,
            workItemId,
          ),
          projectWorkItems:
            await planeClient.listProjectWorkItemSnapshots(projectId),
        };
      },
      ledger,
    };
    const ready = await processPlaneReadyWebhook({
      ...shared,
      readyStateId,
      enqueue: enqueueCoding,
    });
    if (ready.status !== "ignored") return ready;
    return processPlaneResearchWebhook({
      ...shared,
      personaUserIds,
      enqueue,
    });
  },
});

const port = Number(process.env.CODEOPS_HTTP_PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CODEOPS_HTTP_PORT must be a valid TCP port");
}
const server = createServer((request, response) => {
  void listener(request, response);
});
server.listen(port, process.env.CODEOPS_HTTP_HOST ?? "0.0.0.0");

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await temporalConnection.close();
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
