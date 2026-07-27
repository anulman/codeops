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
      comment_stripped:
        "@ai-security @ai-web Cross-check auth boundaries and route guards.",
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
    description_stripped: "Map the current behavior.",
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

const personaUserId = "98d2dd94-8b56-4d68-bce9-774fc6d4bb2c";
const cePayload = {
  event: "issue_comment",
  action: "created",
  webhook_id: "285f087b-e1e0-4f90-b9f4-0b720acfac04",
  workspace_id: payload.workspace_id,
  data: {
    id: payload.data.comment.id,
    created_at: "2026-07-26T02:29:00.000Z",
    updated_at: "2026-07-26T02:29:00.000Z",
    deleted_at: null,
    comment_html: `<p><mention-component id="f3137058-e0aa-4375-a0d6-6f8608a1aed7" entity_identifier="${personaUserId}" entity_name="user_mention"></mention-component> Inspect &amp; verify the signed auth boundary.</p>`,
    attachments: [],
    access: "INTERNAL",
    external_source: null,
    external_id: null,
    edited_at: null,
    created_by: actorId,
    updated_by: null,
    project: payload.data.project_id,
    workspace: payload.workspace_id,
    description: "7bc73f5f-a32e-4b96-9bb3-2e22368cd015",
    issue: payload.entity_id,
    actor: actorId,
    parent: null,
  },
  activity: {
    field: null,
    new_value: null,
    old_value: null,
    actor: { id: actorId },
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

function signedCeInput(overrides = {}) {
  const body = overrides.payload ?? cePayload;
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      delivery: "616d98fe-35a7-4436-bdca-5ff5490dbf09",
      event: "issue_comment",
      signature: createHmac("sha256", secret).update(rawBody).digest("hex"),
      ...overrides.headers,
    },
    webhookSecret: secret,
    allowedHumanActorIds: new Set([actorId]),
    personaUserIds: new Map([[personaUserId, "@ai-security"]]),
    repository: { owner: "anulman", name: "renoconcierge" },
    baseSha,
    receivedAt: "2026-07-26T02:30:00.000Z",
    loadSource: async () => source,
  };
}

test("admits signed human persona mentions and binds the bounded round", async () => {
  const admission = await admitPlaneResearchComment(signedInput());
  assert.equal(admission.request.workItemId, payload.entity_id);
  assert.equal(admission.request.projectId, payload.data.project_id);
  assert.equal(admission.request.requestedBy, actorId);
  assert.deepEqual(admission.request.personas, ["@ai-security", "@ai-web"]);
  assert.equal(
    admission.request.brief,
    "Cross-check auth boundaries and route guards.",
  );
  assert.match(admission.planeRevisionDigest, /^sha256:[0-9a-f]{64}$/);
});

test("admits the real Plane CE issue-comment payload and resolves mention UUIDs", async () => {
  const admission = await admitPlaneResearchComment(signedCeInput());
  assert.equal(admission.eventId, cePayload.data.id);
  assert.equal(admission.request.workItemId, cePayload.data.issue);
  assert.deepEqual(admission.request.personas, ["@ai-security"]);
  assert.equal(
    admission.request.brief,
    "Inspect & verify the signed auth boundary.",
  );
});

test("ignores unresolved Plane CE mention UUIDs", async () => {
  const input = signedCeInput();
  input.personaUserIds = new Map();
  assert.equal(await admitPlaneResearchComment(input), null);
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

test("ignores comments without a registered persona without loading mutable source", async () => {
  let loads = 0;
  const input = signedInput({
    payload: {
      ...payload,
      data: {
        ...payload.data,
        comment: {
          ...payload.data.comment,
          comment_stripped: "/research @ai-unknown Please investigate this.",
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

test("uses the bound ticket as the brief when a persona mention stands alone", async () => {
  const input = signedInput({
    payload: {
      ...payload,
      data: {
        ...payload.data,
        comment: {
          ...payload.data.comment,
          comment_stripped: "@ai-database",
        },
      },
    },
  });
  const admission = await admitPlaneResearchComment(input);
  assert.equal(
    admission.request.brief,
    "Inventory canonical auth states\n\nMap the current behavior.",
  );
  assert.deepEqual(admission.request.personas, ["@ai-database"]);
});

test("fails closed on signature, header, and scope mismatch", async () => {
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
  assert.equal(
    await admitPlaneResearchComment({
      ...signedInput(),
      allowedHumanActorIds: new Set(),
    }),
    null,
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
