import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  admitPlaneReadyTransition,
  admitPlaneResearchComment,
  compileProjectContext,
  identifyPlaneReadyTransition,
} from "../dist/index.js";
import { upgradeResearchPacket } from "./research-fixture.mjs";

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
const controlPlaneSha = "bd8072b349424e4af7fabfd986dc133b53400603";
const projectContextDocuments = [
  {
    path: "AGENTS.md",
    purpose: "Repository guidance",
    digest:
      "sha256:bce2d710d7649d7175f3dcf1ef4705b5cd16a3ba674788ab17ca03164cb8be85",
    content: "# Repository guidance\n",
  },
];
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
  comments: [
    {
      id: payload.data.comment.id,
      comment_html: "<p>Human research request.</p>",
      created_by: actorId,
      created_at: "2026-07-26T02:29:00.000Z",
      external_source: null,
    },
    {
      id: "99999999-9999-4999-8999-999999999999",
      comment_html: "<p>Old CodeOps output.</p>",
      created_by: actorId,
      created_at: "2026-07-26T02:29:30.000Z",
      external_source: "codeops",
    },
  ],
  relations: {
    blocking: [
      {
        project_id: payload.data.project_id,
        issue_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    ],
    blocked_by: [],
    duplicate: [],
    relates_to: [],
    start_after: [],
    start_before: [],
    finish_after: [],
    finish_before: [],
  },
  projectWorkItems: [
    {
      id: "77777777-7777-4777-8777-777777777777",
      project: payload.data.project_id,
      workspace: payload.workspace_id,
      name: "Existing security hardening",
      description_html: "<p>Existing task.</p>",
      priority: "high",
      state: "067b88e5-304b-4221-ba09-94340dcc36e5",
      labels: [],
      assignees: [],
      module: null,
      parent: null,
      updated_at: "2026-07-26T01:30:00.000Z",
    },
  ],
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

const readyStateId = "cc8562ab-79c7-4f1c-b4a2-1ed51dfcd6aa";
const backlogStateId = source.workItem.state;
const readyUpdatedAt = "2026-07-27T02:45:00.000Z";
const readyPayload = {
  event: "issue",
  action: "updated",
  webhook_id: cePayload.webhook_id,
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
    old_value: backlogStateId,
    new_value: readyStateId,
    actor: {
      id: actorId,
      display_name: "Aidan",
    },
  },
};

function researchPacket() {
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
    personas: ["@ai-product"],
    perspectives: [
      {
        persona: "@ai-product",
        outcome: "findings",
        summary: "The product context is bound.",
      },
    ],
    requestId: "research-request:fixture",
    projectId: source.project.id,
    workItemId: source.workItem.id,
    baseSha,
    projectContextDigest: projectContext.digest,
    planeRevisionDigest: `sha256:${"b".repeat(64)}`,
    summary: "The product context is bound.",
    currentBehavior: [],
    expectedBehavior: [],
    evidence: [],
    videoNotApplicableReason: "Contract-only fixture.",
    decisions: [],
    proposedMutations: {
      version: "codeops.research-mutation-batch/v1",
      requestId: "research-request:fixture",
      projectId: source.project.id,
      sourceWorkItemId: source.workItem.id,
      mutations: [],
    },
    createdAt: "2026-07-26T02:30:00.000Z",
  });
}

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
    controlPlaneSha,
    baseSha,
    receivedAt: "2026-07-26T02:30:00.000Z",
    projectContextDocuments,
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
    controlPlaneSha,
    baseSha,
    receivedAt: "2026-07-26T02:30:00.000Z",
    projectContextDocuments,
    loadSource: async () => source,
  };
}

function signedReadyInput(overrides = {}) {
  const body = overrides.payload ?? readyPayload;
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: {
      delivery: "716d98fe-35a7-4436-bdca-5ff5490dbf09",
      event: "issue",
      signature: createHmac("sha256", secret).update(rawBody).digest("hex"),
      ...overrides.headers,
    },
    webhookSecret: secret,
    allowedHumanActorIds: new Set([actorId]),
    readyStateId,
    repository: { owner: "anulman", name: "renoconcierge" },
    controlPlaneSha,
    baseSha,
    receivedAt: "2026-07-27T02:45:01.000Z",
    projectContextDocuments,
    loadResearchPacket: async () => researchPacket(),
    loadSource: async () => ({
      project: source.project,
      workItem: {
        ...source.workItem,
        state: readyStateId,
        updated_at: readyUpdatedAt,
      },
    }),
  };
}

test("admits signed human persona mentions and binds the bounded round", async () => {
  const admission = await admitPlaneResearchComment(signedInput());
  assert.equal(admission.request.workItemId, payload.entity_id);
  assert.equal(admission.request.projectId, payload.data.project_id);
  assert.equal(admission.request.requestedBy, actorId);
  assert.deepEqual(admission.request.personas, ["@ai-security", "@ai-web"]);
  assert.equal(admission.request.ticketSnapshot.name, source.workItem.name);
  assert.equal(admission.request.ticketSnapshot.relevantComments.length, 1);
  assert.equal(admission.request.ticketSnapshot.projectTasks.length, 1);
  assert.equal(
    admission.request.ticketSnapshot.projectTasks[0].workItemId,
    source.projectWorkItems[0].id,
  );
  assert.deepEqual(admission.request.ticketSnapshot.relations, [
    {
      kind: "blocking",
      projectId: payload.data.project_id,
      workItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  ]);
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

test("admits only a signed allowlisted human transition into configured Ready", async () => {
  const input = signedReadyInput();
  const identified = identifyPlaneReadyTransition(input);
  const admission = await admitPlaneReadyTransition(input);
  assert.equal(identified.projectId, payload.data.project_id);
  assert.equal(identified.workItemId, payload.entity_id);
  assert.equal(identified.eventId, admission.eventId);
  assert.equal(admission.request.workItem.workItemId, payload.entity_id);
  assert.equal(admission.request.projectId, payload.data.project_id);
  assert.equal(admission.request.requestedBy, actorId);
  assert.equal(admission.request.workItem.baseSha, baseSha);
  assert.equal(
    admission.request.workItem.summary,
    "Inventory canonical auth states",
  );
  assert.deepEqual(admission.request.workItem.acceptanceCriteria, [
    "Map the current behavior.",
  ]);
  assert.equal(
    admission.request.requestId,
    admission.request.workItem.workflowId,
  );
  assert.equal(
    admission.request.workItem.runId,
    admission.request.workItem.workflowId,
  );
  assert.match(admission.eventId, /^ready-event:[0-9a-f]{64}$/);
  assert.match(admission.planeRevisionDigest, /^sha256:[0-9a-f]{64}$/);
});

test("derives Ready acceptance criteria from Plane CE description HTML", async () => {
  const input = signedReadyInput();
  input.loadSource = async () => ({
    project: source.project,
    workItem: {
      ...source.workItem,
      state: readyStateId,
      updated_at: readyUpdatedAt,
      description_html:
        "<p>Build every fixture.</p><ul><li>Verify exact creation &amp; reset.</li></ul>",
      description_stripped: undefined,
    },
  });

  const admission = await admitPlaneReadyTransition(input);
  assert.deepEqual(admission.request.workItem.acceptanceCriteria, [
    "Build every fixture.\nVerify exact creation & reset.",
  ]);
});

test("Ready admission is stable across delivery retries", async () => {
  const first = await admitPlaneReadyTransition(signedReadyInput());
  const retry = await admitPlaneReadyTransition(
    signedReadyInput({
      headers: {
        delivery: "816d98fe-35a7-4436-bdca-5ff5490dbf09",
      },
    }),
  );
  assert.equal(first.eventId, retry.eventId);
  assert.equal(first.planeRevisionDigest, retry.planeRevisionDigest);
  assert.deepEqual(first.request, retry.request);
});

test("fails Ready admission closed without bounded acceptance criteria", async () => {
  const input = signedReadyInput();
  input.loadSource = async () => ({
    project: source.project,
    workItem: {
      ...source.workItem,
      state: readyStateId,
      updated_at: readyUpdatedAt,
      description_html: "<p> </p>",
      description_stripped: " ",
    },
  });
  await assert.rejects(
    admitPlaneReadyTransition(input),
    /must define acceptance criteria/,
  );
});

test("ignores non-Ready, non-human, and non-state Plane updates", async () => {
  assert.equal(
    await admitPlaneReadyTransition({
      ...signedReadyInput(),
      allowedHumanActorIds: new Set(),
    }),
    null,
  );
  assert.equal(
    await admitPlaneReadyTransition(
      signedReadyInput({
        payload: {
          ...readyPayload,
          data: {
            ...readyPayload.data,
            state: backlogStateId,
          },
          activity: {
            ...readyPayload.activity,
            new_value: backlogStateId,
            old_value: readyStateId,
          },
        },
      }),
    ),
    null,
  );
  assert.equal(
    await admitPlaneReadyTransition(
      signedReadyInput({
        payload: {
          ...readyPayload,
          activity: {
            ...readyPayload.activity,
            field: "priority",
          },
        },
      }),
    ),
    null,
  );
});

test("fails Ready admission closed on signature and trusted snapshot drift", async () => {
  await assert.rejects(
    admitPlaneReadyTransition({
      ...signedReadyInput(),
      headers: {
        ...signedReadyInput().headers,
        signature: "0".repeat(64),
      },
    }),
    /signature/,
  );
  const drifted = signedReadyInput();
  drifted.loadSource = async () => ({
    project: source.project,
    workItem: {
      ...source.workItem,
      state: readyStateId,
      updated_at: "2026-07-27T02:45:02.000Z",
    },
  });
  await assert.rejects(
    admitPlaneReadyTransition(drifted),
    /outside the signed event scope/,
  );
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
