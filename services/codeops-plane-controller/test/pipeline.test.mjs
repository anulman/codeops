import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compileProjectContext,
  createFileResearchDedupLedger,
  processPlaneReadyWebhook,
  processPlaneResearchWebhook,
} from "../dist/index.js";
import { upgradeResearchPacket } from "./research-fixture.mjs";

const actorId = "88fc36c8-73b0-4547-81c7-96b70f61835e";
const secret = "plane_wh_test-secret";
const baseSha = "8f3d2c033f70be04b4b2dc8a005683806e84e209";
const controlPlaneSha = "bd8072b349424e4af7fabfd986dc133b53400603";
const aiAssigneeId = "98d2dd94-8b56-4d68-bce9-774fc6d4bb2c";
const projectContextDocuments = [
  {
    path: "AGENTS.md",
    purpose: "Repository guidance",
    digest:
      "sha256:bce2d710d7649d7175f3dcf1ef4705b5cd16a3ba674788ab17ca03164cb8be85",
    content: "# Repository guidance\n",
  },
];
const payload = {
  version: "v2",
  delivery_id: "01ab9316-f978-4449-bad6-dce958be8454",
  event_id: "0afa042d-92a9-4326-bdca-5ff5490dbf09",
  entity_id: "088a83b9-a53f-4dda-b2bc-c860cf455997",
  entity_type: "issue",
  event: "workitem.comment.created",
  webhook_id: "285f087b-e1e0-4f90-b9f4-0b720acfac04",
  workspace_id: "d250cd44-fa71-42c2-b2b5-3c73227288fc",
  data: {
    id: "088a83b9-a53f-4dda-b2bc-c860cf455997",
    project_id: "45b87d89-0ce0-4d6f-8903-4070f1c67f1b",
    comment: {
      id: "4797f841-c731-4e55-971f-d9cfe1938dfb",
      actor_id: actorId,
      issue_id: "088a83b9-a53f-4dda-b2bc-c860cf455997",
      comment_stripped: "@ai-security Inspect the signed auth boundary.",
    },
  },
  previous_attributes: {},
};
const source = {
  workItem: {
    id: payload.entity_id,
    project: payload.data.project_id,
    workspace: payload.workspace_id,
    name: "Inventory canonical auth states",
    description_html: "<p>Map the current behavior.</p>",
    description_stripped: "Map the current behavior.",
    priority: "none",
    state: "067b88e5-304b-4221-ba09-94340dcc36e5",
    labels: [],
    assignees: [aiAssigneeId],
    module: null,
    parent: null,
    updated_at: "2026-07-26T02:00:00.000Z",
  },
  project: {
    id: payload.data.project_id,
    workspace: payload.workspace_id,
    name: "Onboarding Auth QA",
    description_html: "<p>Deterministic auth qualification.</p>",
    updated_at: "2026-07-26T01:00:00.000Z",
  },
};
const readyStateId = "cc8562ab-79c7-4f1c-b4a2-1ed51dfcd6aa";
const readyUpdatedAt = "2026-07-27T02:45:00.000Z";
const readyPayload = {
  event: "issue",
  action: "updated",
  webhook_id: payload.webhook_id,
  workspace_id: payload.workspace_id,
  data: {
    ...source.workItem,
    state: {
      id: readyStateId,
      name: "Ready",
      color: "#3B82F6",
      group: "unstarted",
    },
    updated_at: readyUpdatedAt,
  },
  activity: {
    field: "state_id",
    old_value: source.workItem.state,
    new_value: readyStateId,
    actor: { id: actorId },
  },
};

function readyResearchPacket() {
  const projectContext = compileProjectContext({
    repository: { owner: "anulman", name: "renoconcierge" },
    controlPlaneSha,
    baseSha,
    workspaceId: payload.workspace_id,
    project: {
      id: source.project.id,
      name: source.project.name,
      descriptionHtml: source.project.description_html,
      updatedAt: source.project.updated_at,
    },
    documents: projectContextDocuments,
  });
  return upgradeResearchPacket({
    version: "codeops.research-packet/v2",
    personas: ["@ai-security"],
    perspectives: [
      {
        persona: "@ai-security",
        outcome: "findings",
        summary: "The signed auth boundary is explicit.",
      },
    ],
    requestId: "research-request:pipeline-fixture",
    projectId: source.project.id,
    workItemId: source.workItem.id,
    baseSha,
    projectContextDigest: projectContext.digest,
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    summary: "The signed auth boundary is explicit.",
    currentBehavior: [],
    expectedBehavior: [],
    evidence: [],
    videoNotApplicableReason: "Contract-only fixture.",
    decisions: [],
    proposedMutations: {
      version: "codeops.research-mutation-batch/v1",
      requestId: "research-request:pipeline-fixture",
      projectId: source.project.id,
      sourceWorkItemId: source.workItem.id,
      mutations: [],
    },
    createdAt: "2026-07-26T02:30:00.000Z",
  });
}

function webhookInput(ledger, enqueue, body = payload) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      delivery: body.delivery_id,
      event: body.event,
      signature: createHmac("sha256", secret).update(rawBody).digest("hex"),
    },
    webhookSecret: secret,
    allowedHumanActorIds: new Set([actorId]),
    repository: { owner: "anulman", name: "renoconcierge" },
    controlPlaneSha,
    baseSha,
    receivedAt: "2026-07-26T02:30:00.000Z",
    projectContextDocuments,
    loadSource: async () => source,
    ledger,
    enqueue,
    now: () => "2026-07-26T12:00:00.000Z",
  };
}

function readyWebhookInput(ledger, enqueue, body = readyPayload) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      delivery: "716d98fe-35a7-4436-bdca-5ff5490dbf09",
      event: body.event,
      signature: createHmac("sha256", secret).update(rawBody).digest("hex"),
    },
    webhookSecret: secret,
    allowedHumanActorIds: new Set([actorId]),
    aiPersonaUserIds: new Set([aiAssigneeId]),
    readyStateId,
    repository: { owner: "anulman", name: "renoconcierge" },
    controlPlaneSha,
    baseSha,
    receivedAt: "2026-07-27T02:45:01.000Z",
    projectContextDocuments,
    loadResearchPacket: async () => readyResearchPacket(),
    loadSource: async () => ({
      project: source.project,
      workItem: {
        ...source.workItem,
        state: readyStateId,
        updated_at: readyUpdatedAt,
      },
    }),
    ledger,
    enqueue,
    now: () => "2026-07-27T02:46:00.000Z",
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codeops-pipeline-"));
  return {
    root,
    ledger: createFileResearchDedupLedger({
      rootDirectory: root,
      leaseDurationMs: 60_000,
    }),
  };
}

test("claims the signed event and request before one deterministic enqueue", async () => {
  const { root, ledger } = await fixture();
  const enqueued = [];
  try {
    const result = await processPlaneResearchWebhook(
      webhookInput(ledger, async (input) => {
        enqueued.push(input);
        return "enqueued";
      }),
    );
    assert.equal(result.status, "enqueued");
    assert.equal(result.duplicate, false);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].workflowId, result.requestId);
    assert.equal(enqueued[0].request.requestId, result.requestId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Plane delivery retry returns the persisted outcome without enqueueing again", async () => {
  const { root, ledger } = await fixture();
  let enqueueCount = 0;
  const enqueue = async () => {
    enqueueCount += 1;
    return "enqueued";
  };
  try {
    const first = await processPlaneResearchWebhook(
      webhookInput(ledger, enqueue),
    );
    const retryInput = webhookInput(ledger, enqueue, {
        ...payload,
        delivery_id: "616d98fe-35a7-4436-bdca-5ff5490dbf09",
      });
    retryInput.receivedAt = "2026-07-26T12:30:00.000Z";
    retryInput.baseSha = "a".repeat(40);
    retryInput.loadSource = async () => ({
      project: {
        ...source.project,
        updated_at: "2026-07-26T12:29:00.000Z",
      },
      workItem: {
        ...source.workItem,
        name: "Inventory canonical auth states after deployment",
        updated_at: "2026-07-26T12:29:00.000Z",
      },
    });
    const retry = await processPlaneResearchWebhook(retryInput);
    assert.equal(first.status, "enqueued");
    assert.deepEqual(retry, {
      status: "enqueued",
      requestId: first.requestId,
      duplicate: true,
    });
    assert.equal(enqueueCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed enqueue releases both identities for a safe retry", async () => {
  const { root, ledger } = await fixture();
  let enqueueCount = 0;
  try {
    await assert.rejects(
      processPlaneResearchWebhook(
        webhookInput(ledger, async () => {
          enqueueCount += 1;
          throw new Error("Temporal unavailable");
        }),
      ),
      /Temporal unavailable/,
    );
    const retry = await processPlaneResearchWebhook(
      webhookInput(ledger, async () => {
        enqueueCount += 1;
        return "enqueued";
      }),
    );
    assert.equal(retry.status, "enqueued");
    assert.equal(retry.duplicate, false);
    assert.equal(enqueueCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary signed comments remain ignored without touching the enqueuer", async () => {
  const { root, ledger } = await fixture();
  let enqueueCount = 0;
  try {
    const result = await processPlaneResearchWebhook(
      webhookInput(
        ledger,
        async () => {
          enqueueCount += 1;
          return "enqueued";
        },
        {
          ...payload,
          data: {
            ...payload.data,
            comment: {
              ...payload.data.comment,
              comment_stripped: "Please investigate.",
            },
          },
        },
      ),
    );
    assert.deepEqual(result, { status: "ignored" });
    assert.equal(enqueueCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durably reuses the first Ready admission across delivery-time source drift", async () => {
  const { root, ledger } = await fixture();
  const enqueued = [];
  try {
    const first = await processPlaneReadyWebhook(
      readyWebhookInput(ledger, async (input) => {
        enqueued.push(input);
        return "enqueued";
      }),
    );
    const retryInput = readyWebhookInput(ledger, async () => {
        throw new Error("retry must not enqueue");
      });
    retryInput.baseSha = "a".repeat(40);
    retryInput.receivedAt = "2026-07-27T03:00:00.000Z";
    const retry = await processPlaneReadyWebhook(retryInput);
    assert.equal(first.status, "enqueued");
    assert.equal(first.duplicate, false);
    assert.equal(retry.status, "enqueued");
    assert.equal(retry.duplicate, true);
    assert.equal(retry.requestId, first.requestId);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].workflowId, first.requestId);
    assert.equal(enqueued[0].request.requestId, first.requestId);
    assert.equal(
      enqueued[0].request.workItem.workflowId,
      enqueued[0].request.workItem.runId,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Ready enqueue releases both identities for a bounded retry", async () => {
  const { root, ledger } = await fixture();
  let attempts = 0;
  try {
    await assert.rejects(
      processPlaneReadyWebhook(
        readyWebhookInput(ledger, async () => {
          attempts += 1;
          throw new Error("Temporal unavailable");
        }),
      ),
      /Temporal unavailable/,
    );
    const retry = await processPlaneReadyWebhook(
      readyWebhookInput(ledger, async () => {
        attempts += 1;
        return "enqueued";
      }),
    );
    assert.equal(retry.status, "enqueued");
    assert.equal(retry.duplicate, false);
    assert.equal(attempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes one fail-closed Ready acknowledgement after durable enqueue", async () => {
  const { root, ledger } = await fixture();
  const accepted = [];
  const order = [];
  try {
    const input = readyWebhookInput(ledger, async () => {
      order.push("temporal-acknowledged");
      return "enqueued";
    });
    input.publishAccepted = async (value) => {
      order.push("plane-in-progress");
      accepted.push(value);
    };
    const result = await processPlaneReadyWebhook(input);
    assert.equal(result.status, "enqueued");
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].request.requestId, result.requestId);
    assert.equal(accepted[0].enqueueResult, "enqueued");
    assert.deepEqual(order, ["temporal-acknowledged", "plane-in-progress"]);
    assert.equal(
      accepted[0].request.researchDisposition.mode,
      "optional",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("admits a bounded Ready ticket with research explicitly skipped", async () => {
  const { root, ledger } = await fixture();
  const enqueued = [];
  try {
    const input = readyWebhookInput(ledger, async (value) => {
      enqueued.push(value);
      return "enqueued";
    });
    input.loadResearchPacket = async () => null;
    const result = await processPlaneReadyWebhook(input);
    assert.equal(result.status, "enqueued");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].request.researchDisposition.mode, "skipped");
    assert.equal(enqueued[0].request.researchPacket, undefined);
    assert.equal(enqueued[0].request.workItem.baseSha, baseSha);
    assert.equal(enqueued[0].request.controlPlaneSha, controlPlaneSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
