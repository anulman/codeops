import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { admitPlaneResearchComment } from "../dist/index.js";

const actorId = "88fc36c8-73b0-4547-81c7-96b70f61835e";
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
      access: "INTERNAL",
      actor_id: actorId,
      issue_id: "088a83b9-a53f-4dda-b2bc-c860cf455997",
      edited_at: null,
      comment_stripped: "/research",
    },
  },
  previous_attributes: {},
};

const secret = "plane_wh_test-secret";
const baseSha = "8f3d2c033f70be04b4b2dc8a005683806e84e209";
const source = {
  workItem: {
    id: payload.entity_id,
    project: payload.data.project_id,
    workspace: payload.workspace_id,
    name: "Inventory canonical auth states",
    description_html: "<p>Map the current behavior.</p>",
    priority: "none",
    state: "067b88e5-304b-4221-ba09-94340dcc36e5",
    labels: [],
    assignees: [],
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

function signedInput(overrides = {}) {
  const body = overrides.payload ?? payload;
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      delivery: body.delivery_id,
      event: body.event,
      signature: createHmac("sha256", secret).update(rawBody).digest("hex"),
      ...overrides.headers,
    },
    webhookSecret: secret,
    allowedHumanActorIds: new Set([actorId]),
    repository: { owner: "anulman", name: "renoconcierge" },
    baseSha,
    receivedAt: "2026-07-26T02:30:00.000Z",
    loadSource: async () => source,
  };
}

test("admits an exact signed human /research comment and binds live source", async () => {
  const admission = await admitPlaneResearchComment(signedInput());
  assert.equal(admission.request.workItemId, payload.entity_id);
  assert.equal(admission.request.projectId, payload.data.project_id);
  assert.equal(admission.request.requestedBy, actorId);
  assert.match(admission.planeRevisionDigest, /^sha256:[0-9a-f]{64}$/);
});

test("deduplicates retries by Plane event ID rather than delivery ID", async () => {
  const first = await admitPlaneResearchComment(signedInput());
  const retryPayload = {
    ...payload,
    delivery_id: "616d98fe-35a7-4436-bdca-5ff5490dbf09",
  };
  const retry = await admitPlaneResearchComment(
    signedInput({ payload: retryPayload }),
  );
  assert.equal(first.request.requestId, retry.request.requestId);
});

test("ignores non-command comments without loading mutable source", async () => {
  let loads = 0;
  const input = signedInput({
    payload: {
      ...payload,
      data: {
        ...payload.data,
        comment: {
          ...payload.data.comment,
          comment_stripped: "Please investigate this.",
        },
      },
    },
  });
  input.loadSource = async () => {
    loads += 1;
    return source;
  };
  assert.equal(await admitPlaneResearchComment(input), null);
  assert.equal(loads, 0);
});

test("fails closed on signature, header, actor, and scope mismatch", async () => {
  await assert.rejects(
    admitPlaneResearchComment({
      ...signedInput(),
      headers: { ...signedInput().headers, signature: "0".repeat(64) },
    }),
    /signature/,
  );
  await assert.rejects(
    admitPlaneResearchComment({
      ...signedInput(),
      headers: { ...signedInput().headers, event: "workitem.comment.updated" },
    }),
    /headers/,
  );
  await assert.rejects(
    admitPlaneResearchComment({
      ...signedInput(),
      allowedHumanActorIds: new Set(),
    }),
    /actor/,
  );
  await assert.rejects(
    admitPlaneResearchComment({
      ...signedInput(),
      loadSource: async () => ({
        ...source,
        workItem: {
          ...source.workItem,
          project: "59e3be42-87ec-4950-99a3-ae639cf2b089",
        },
      }),
    }),
    /scope/,
  );
});
