import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyResearchMutationBatch,
} from "../dist/index.js";

const projectId = "45b87d89-0ce0-4d6f-8903-4070f1c67f1b";
const sourceWorkItemId = "088a83b9-a53f-4dda-b2bc-c860cf455997";
const relatedWorkItemId = "775c5716-5302-4617-bb9f-2cd843911268";
const parentWorkItemId = "8661bdfa-098f-434d-8e44-b1f32de62406";
const requestId = "research-request:4d819f3d58afe8a9";

function fakeClient() {
  const writes = [];
  const terminalChecks = [];
  const labels = [
    {
      id: "a6f8e562-49d2-4c19-bc4b-2bcb9d4f6a03",
      name: "Auth",
      color: "#334455",
      description: "[codeops-key:auth]",
    },
  ];
  const items = new Map(
    [sourceWorkItemId, relatedWorkItemId, parentWorkItemId].map((id) => [
      id,
      { id, project: projectId, labels: [] },
    ]),
  );
  return {
    writes,
    terminalChecks,
    labels,
    items,
    async getWorkItem(_projectId, workItemId) {
      const item = items.get(workItemId);
      if (!item) {
        return { id: workItemId, project: "59e3be42-87ec-4950-99a3-ae639cf2b089", labels: [] };
      }
      return { ...item, labels: [...item.labels] };
    },
    async listLabels() {
      return labels.map((label) => ({ ...label }));
    },
    async createLabel(_projectId, input) {
      const label = {
        id: "c7146baf-7058-496b-aa3a-df6c25a7e929",
        ...input,
      };
      labels.push(label);
      writes.push({ operation: "label.create", input });
      return label;
    },
    async updateLabel(_projectId, labelId, input) {
      const label = labels.find((candidate) => candidate.id === labelId);
      Object.assign(label, input);
      writes.push({ operation: "label.update", labelId, input });
      return { ...label };
    },
    async createComment(_projectId, workItemId, input) {
      writes.push({ operation: "comment.create", workItemId, input });
      return { id: "f3e29f26-708d-40f0-9209-7e0de44abc49" };
    },
    async updateProject(_projectId, input) {
      writes.push({ operation: "project.update", input });
    },
    async updateWorkItem(_projectId, workItemId, input) {
      const item = items.get(workItemId);
      if (item && input.labels) item.labels = [...input.labels];
      writes.push({ operation: "ticket.update", workItemId, input });
    },
    async createWorkItem(_projectId, input) {
      const created = {
        id: "e1c25c66-5bb8-465e-a818-92a483423443",
        project: projectId,
        labels: [...(input.labels ?? [])],
      };
      items.set(created.id, created);
      writes.push({ operation: "ticket.create", input });
      return created;
    },
    async transitionWorkItemToTerminalState(
      _projectId,
      workItemId,
      terminalState,
    ) {
      writes.push({
        operation: "ticket.terminal-transition",
        workItemId,
        terminalState,
      });
    },
    async assertTerminalStateAvailable(_projectId, terminalState) {
      terminalChecks.push(terminalState);
    },
  };
}

function batch(mutations) {
  return {
    version: "codeops.research-mutation-batch/v1",
    requestId,
    projectId,
    sourceWorkItemId,
    mutations,
  };
}

const expected = { requestId, projectId, sourceWorkItemId };
const completionEvidence = {
  version: "codeops.evidence/v1",
  kind: "test-report",
  uri: "https://evidence.example.test/runs/research/completion.json",
  digest: `sha256:${"b".repeat(64)}`,
  sizeBytes: 2048,
  mediaType: "application/json",
};

test("applies approved content mutations and only evidence-bound terminal transitions", async () => {
  const client = fakeClient();
  const results = await applyResearchMutationBatch({
    expected,
    client,
    batch: batch([
      {
        type: "comment.create",
        targetWorkItemId: sourceWorkItemId,
        bodyHtml: "<p>Research packet ready.</p>",
        attachments: [
          {
            version: "codeops.evidence/v1",
            kind: "video",
            uri: "https://evidence.example.test/runs/research/current.mp4",
            digest: `sha256:${"a".repeat(64)}`,
            sizeBytes: 1024,
            mediaType: "video/mp4",
          },
        ],
      },
      {
        type: "label.upsert",
        key: "qa-reviewed",
        name: "QA reviewed",
        color: "#123ABC",
        description: "Contract research complete.",
      },
      {
        type: "label.attach",
        targetWorkItemId: relatedWorkItemId,
        key: "auth",
      },
      {
        type: "label.detach",
        targetWorkItemId: relatedWorkItemId,
        key: "auth",
      },
      {
        type: "project.update",
        changes: { description: "Canonical auth QA project." },
      },
      {
        type: "ticket.update",
        targetWorkItemId: relatedWorkItemId,
        changes: {
          name: "Clarify cross-file session isolation",
          parentId: parentWorkItemId,
          assigneeIds: [],
        },
      },
      {
        type: "ticket.create",
        name: "Record stale-session oracle",
        descriptionHtml: "<p>Follow-up contract.</p>",
        parentId: parentWorkItemId,
        labelKeys: ["auth"],
      },
      {
        type: "ticket.cancel",
        targetWorkItemId: relatedWorkItemId,
        basis: "superseded",
        reason: "Superseded by <QANBRDAUTH-7>.",
        supersededByWorkItemId: parentWorkItemId,
        evidence: [],
      },
      {
        type: "ticket.complete",
        targetWorkItemId: parentWorkItemId,
        reason: "Existing candidate already satisfies the requested outcome.",
        evidence: [completionEvidence],
      },
    ]),
  });

  assert.equal(results.length, 9);
  assert.ok(client.writes.some((write) => write.operation === "project.update"));
  assert.ok(client.writes.some((write) => write.operation === "ticket.create"));
  assert.ok(client.writes.some((write) => write.operation === "comment.create"));
  assert.ok(
    client.writes.some(
      (write) =>
        write.operation === "comment.create" &&
        write.input.comment_html.includes(
          "https://evidence.example.test/runs/research/current.mp4",
        ) &&
        write.input.comment_html.includes(`sha256:${"a".repeat(64)}`),
    ),
  );
  assert.ok(
    client.writes.some(
      (write) =>
        write.operation === "label.create" &&
        write.input.description.includes("[codeops-key:qa-reviewed]"),
    ),
  );
  assert.equal(
    client.writes.some((write) =>
      Object.prototype.hasOwnProperty.call(write.input ?? {}, "state"),
    ),
    false,
  );
  const cancellation = client.writes.find(
    (write) =>
      write.operation === "comment.create" &&
      write.input.comment_html.includes("Cancelled by QA Contract Researcher"),
  );
  assert.match(cancellation.input.comment_html, /&lt;QANBRDAUTH-7&gt;/);
  assert.match(cancellation.input.comment_html, new RegExp(parentWorkItemId));
  assert.deepEqual(
    client.writes
      .filter((write) => write.operation === "ticket.terminal-transition")
      .map(({ workItemId, terminalState }) => ({ workItemId, terminalState })),
    [
      { workItemId: relatedWorkItemId, terminalState: "cancelled" },
      { workItemId: parentWorkItemId, terminalState: "completed" },
    ],
  );
  assert.deepEqual(client.terminalChecks, ["cancelled", "completed"]);
  const completion = client.writes.find(
    (write) =>
      write.operation === "comment.create" &&
      write.input.comment_html.includes("Completed by QA Contract Researcher"),
  );
  assert.match(completion.input.comment_html, new RegExp(completionEvidence.digest));
});

test("rejects a source or target outside the admitted project before writing", async () => {
  const client = fakeClient();
  await assert.rejects(
    applyResearchMutationBatch({
      expected,
      client,
      batch: batch([
        {
          type: "comment.create",
          targetWorkItemId: sourceWorkItemId,
          bodyHtml: "<p>This must not be written.</p>",
          attachments: [],
        },
        {
          type: "ticket.update",
          targetWorkItemId: "59e3be42-87ec-4950-99a3-ae639cf2b089",
          changes: { name: "Out of scope" },
        },
      ]),
    }),
    /outside project/,
  );
  assert.deepEqual(client.writes, []);
});

test("preflights terminal-state availability before the first write", async () => {
  const client = fakeClient();
  client.assertTerminalStateAvailable = async () => {
    throw new Error("Plane project must have exactly one Done state");
  };
  await assert.rejects(
    applyResearchMutationBatch({
      expected,
      client,
      batch: batch([
        {
          type: "comment.create",
          targetWorkItemId: sourceWorkItemId,
          bodyHtml: "<p>This must not be written.</p>",
          attachments: [],
        },
        {
          type: "ticket.complete",
          targetWorkItemId: relatedWorkItemId,
          reason: "Existing outcome.",
          evidence: [completionEvidence],
        },
      ]),
    }),
    /exactly one Done state/,
  );
  assert.deepEqual(client.writes, []);
});

test("rejects state changes and mismatched admitted-request identity", async () => {
  const client = fakeClient();
  await assert.rejects(
    applyResearchMutationBatch({
      expected,
      client,
      batch: batch([
        {
          type: "ticket.update",
          targetWorkItemId: relatedWorkItemId,
          changes: {
            state: "067b88e5-304b-4221-ba09-94340dcc36e5",
          },
        },
      ]),
    }),
  );
  await assert.rejects(
    applyResearchMutationBatch({
      expected: { ...expected, requestId: "research-request:wrong" },
      client,
      batch: batch([]),
    }),
    /does not match/,
  );
  assert.deepEqual(client.writes, []);
});

test("rejects active or malformed HTML before any Plane write", async () => {
  for (const bodyHtml of [
    "<script>alert(1)</script>",
    '<p onclick="alert(1)">Unsafe</p>',
    '<a href="javascript:alert(1)">Unsafe</a>',
    "<p>Malformed < text</p>",
  ]) {
    const client = fakeClient();
    await assert.rejects(
      applyResearchMutationBatch({
        expected,
        client,
        batch: batch([
          {
            type: "comment.create",
            targetWorkItemId: sourceWorkItemId,
            bodyHtml,
            attachments: [],
          },
        ]),
      }),
      /content HTML/,
    );
    assert.deepEqual(client.writes, []);
  }
});

test("fails closed on duplicate or unknown logical label keys", async () => {
  const duplicate = fakeClient();
  duplicate.labels.push({
    id: "c7146baf-7058-496b-aa3a-df6c25a7e928",
    name: "Auth duplicate",
    color: "#000000",
    description: "[codeops-key:auth]",
  });
  await assert.rejects(
    applyResearchMutationBatch({
      expected,
      client: duplicate,
      batch: batch([
        {
          type: "label.attach",
          targetWorkItemId: relatedWorkItemId,
          key: "auth",
        },
      ]),
    }),
    /duplicate/,
  );
  assert.deepEqual(duplicate.writes, []);

  const unknown = fakeClient();
  await assert.rejects(
    applyResearchMutationBatch({
      expected,
      client: unknown,
      batch: batch([
        {
          type: "ticket.create",
          name: "Unknown label",
          descriptionHtml: "<p>Must fail.</p>",
          labelKeys: ["missing"],
        },
      ]),
    }),
    /unknown Plane label key/,
  );
  assert.deepEqual(unknown.writes, []);
});
