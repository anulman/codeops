import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { agentMessageInputSchema, sha256CanonicalJsonDigest } from "@codeops/codeops-contracts";
import { operateWorkerMessage, operateSupervisorMessage, parseSupervisorRoutes } from "../dist/agent-messages.js";
import { serveSupervisorMessages } from "../dist/agent-message-http.js";
import { dispatchId, claimToken, workerId, repository, resolvedSha, snapshot, row } from "./agent-message-fixtures.mjs";

const scope = { repository, projectId: "66666666-6666-4666-8666-666666666666", workItemId: snapshot().identity.workItemId };
const route = parseSupervisorRoutes([{
  id: "supervisor", version: "v1", repository, projectId: scope.projectId,
  ownerPrincipalId: "operator:example", supervisorPrincipalId: "supervisor:example",
  token: "s".repeat(32), openClawUrl: "https://supervisor.example/codeops/messages",
  sessions: [{ sessionId: snapshot().sessionId, workItemId: scope.workItemId }],
}])[0];
const send = { operation: "send", idempotencyKey: "question-1", scope, recipient: "supervisor", type: "question", body: "Which interface version should this candidate support?" };

// Behavioral transaction double; the shared backing store survives service/client
// replacement. Real PostgreSQL locking and DDL still require isolated qualification.
function database(state = { messages: new Map(), register: new Map(), claim: row(), snapshot: snapshot() }) {
  let before;
  return {
    state,
    async query(sql, values = []) {
      const result = (rows = [], count = rows.length) => ({ rows, rowCount: count });
      if (sql.startsWith("BEGIN")) { before = structuredClone(state); return result(); }
      if (sql === "ROLLBACK") { Object.assign(state, before); return result(); }
      if (sql === "COMMIT") return result();
      if (sql.includes("SELECT outbox.dispatch_json")) return result([state.claim]);
      if (sql.includes("SELECT dispatch_id FROM")) return result([{ dispatch_id: dispatchId }]);
      if (sql.includes("SELECT snapshot_json")) return result([{ snapshot_json: state.snapshot, owner_principal_id: "operator:example" }]);
      if (sql.includes("FROM codeops.work_item_admissions")) return result(state.admission ? [state.admission] : []);
      if (sql.includes("FROM codeops.workspace_checkpoint_descriptors")) return result([]);
      if (sql.includes("SELECT * FROM codeops.agent_messages")) {
        let selected = [...state.messages.values()];
        if (sql.includes("sender = $3")) selected = selected.filter((r) => r.session_id === values[0] && r.generation === values[1] && r.sender === values[2] && r.idempotency_key === values[3]);
        else if (sql.includes("route_id = $1")) selected = selected.filter((r) => r.route_id === values[0] && r.route_version === values[1] && r.recipient === values[2] && (values[3] ? r.message_id === values[3] : (!r.acknowledged_at || (["question", "decision"].includes(r.message_json.type) && !r.answered_at)))).slice(0, values[4]);
        else {
          selected = selected.filter((r) => r.session_id === values[0] && r.generation === values[1] && r.recipient === values[0] && (values[2] ? r.message_id === values[2] : !r.acknowledged_at));
          if (sql.includes("jsonb_to_recordset")) {
            assert.ok(sql.indexOf("jsonb_to_recordset") < sql.indexOf("LIMIT"));
            const scopes = JSON.parse(values[5]);
            selected = selected.filter(r => r.message_json.leaseId === values[4] && scopes.some(s =>
              r.route_id === s.id && r.route_version === s.version &&
              r.message_json.routeId === s.id && r.message_json.routeVersion === s.version &&
              r.message_json.sender === s.supervisor && r.message_json.scope.repository === s.repository &&
              r.message_json.scope.projectId === s.project && r.message_json.scope.workItemId === s.workItem));
          }
          selected = selected.slice(0, values[3]);
        }
        return result(selected);
      }
      if (sql.includes("INSERT INTO codeops.agent_messages")) {
        const [id, thread, reply, session, generation, dispatch, sender, recipient, routeId, version, key, digest, json] = values;
        if ([...state.messages.values()].some((r) => reply && r.in_reply_to === reply)) throw new Error("unique reply");
        const item = JSON.parse(json);
        if (item.friction && [...state.messages.values()].some((r) => r.message_json.friction?.reportId === item.friction.reportId)) throw new Error("unique report");
        state.messages.set(id, { message_id: id, thread_id: thread, in_reply_to: reply, session_id: session,
          generation, dispatch_id: dispatch, sender, recipient, route_id: routeId, route_version: version,
          idempotency_key: key, request_digest: digest, message_json: item });
        return result([], 1);
      }
      if (sql.includes("UPDATE codeops.agent_messages")) {
        const item = state.messages.get(values[0]);
        if (!item) throw new Error("missing message");
        if (sql.includes("delivered_at =")) item.delivered_at ??= "2099-08-15T10:05:00Z";
        if (sql.includes("acknowledged_at =")) item.acknowledged_at ??= "2099-08-15T10:05:00Z";
        if (sql.includes("answered_at =")) item.answered_at ??= "2099-08-15T10:05:00Z";
        return result([], 1);
      }
      if (sql.includes("INSERT INTO codeops.agent_friction_register")) {
        const key = values.slice(0, 3).join(":");
        state.register.set(key, (state.register.get(key) ?? 0) + 1);
        return result([], 1);
      }
      if (sql.includes("pg_notify")) return result();
      throw new Error(`Unhandled fake database query: ${sql}`);
    },
  };
}
const worker = (db, input, routes = [route]) => operateWorkerMessage(db, { dispatchId, workerId, routes, request: { claimToken, input } });
const supervisor = (db, request, configured = route) => operateSupervisorMessage(db, { route: configured, request });

test("question/reply survives client restart, duplicate delivery and acknowledgment", async () => {
  const first = database();
  const question = (await worker(first, send)).messages[0];
  const restarted = database(first.state);
  assert.equal((await worker(restarted, send)).messages[0].messageId, question.messageId);
  const inbox = await supervisor(restarted, { operation: "inbox" });
  assert.equal(inbox.messages[0].state, "delivered");
  const replyInput = { operation: "reply", messageId: question.messageId, idempotencyKey: "answer-1", body: "Use interface v1." };
  const reply = (await supervisor(restarted, replyInput)).messages[0];
  assert.equal((await supervisor(database(first.state), replyInput)).messages[0].messageId, reply.messageId);
  assert.equal(reply.threadId, question.messageId);
  assert.equal(reply.inReplyTo, question.messageId);
  assert.equal(reply.executionAuthority, false);
  assert.equal((await worker(database(first.state), { operation: "inbox", limit: 20 })).messages[0].messageId, reply.messageId);
  const ack = { operation: "acknowledge", messageId: reply.messageId };
  await worker(restarted, ack); await worker(restarted, ack);
  assert.deepEqual((await worker(restarted, { operation: "inbox", limit: 20 })).messages, []);
  assert.equal(first.state.messages.size, 2);
});

test("reordered reply, changed idempotent bytes, second answer and worker impersonation refuse", async () => {
  const db = database();
  await assert.rejects(supervisor(db, { operation: "reply", messageId: `sha256:${"f".repeat(64)}`, idempotencyKey: "early", body: "Early." }));
  const question = (await worker(db, send)).messages[0];
  await assert.rejects(worker(db, { ...send, body: "Changed." }));
  const reply = { operation: "reply", messageId: question.messageId, idempotencyKey: "answer", body: "Use v1." };
  await assert.rejects(worker(db, reply));
  await supervisor(db, reply);
  await assert.rejects(supervisor(db, { ...reply, idempotencyKey: "another-answer" }));
  assert.equal(db.state.messages.size, 2);
});

test("stale generation, claim, profile, route and cross-project identities refuse", async () => {
  for (const change of [
    (s) => { s.claim.claim_token = "77777777-7777-4777-8777-777777777777"; },
    (s) => { s.claim.claim_expires_at = "2000-01-01T00:00:00Z"; },
    (s) => { s.claim.owner_runtime_binding_json = null; },
    (s) => { s.snapshot.generation++; },
    (s) => { s.admission = { repository, project_id: "77777777-7777-4777-8777-777777777777", work_item_id: scope.workItemId }; },
  ]) {
    const db = database(); change(db.state);
    await assert.rejects(worker(db, send));
    assert.equal(db.state.messages.size, 0);
  }
  const db = database();
  const question = (await worker(db, send)).messages[0];
  const reply = { operation: "reply", messageId: question.messageId, idempotencyKey: "answer", body: "Use v1." };
  await assert.rejects(supervisor(db, reply, { ...route, version: "v2" }));
  await assert.rejects(supervisor(db, reply, { ...route, projectId: "77777777-7777-4777-8777-777777777777" }));
  db.state.snapshot.generation++;
  await assert.rejects(supervisor(db, reply));
  assert.equal(db.state.messages.size, 1);
});

function reportInput(db) {
  const candidate = sha256CanonicalJsonDigest({ repository, sourceSha: resolvedSha });
  const content = JSON.stringify({ version: "codeops.friction-evidence/v1", scope,
    sessionId: snapshot().sessionId, generation: 1, candidate, sanitized: true,
    observation: "The supervisor returned an unsupported version." });
  const digest = createHash("sha256").update(content).digest("hex");
  db.state.claim.dispatch_json.command.contextAttachments = [{ attachmentId: "evidence", name: "evidence.json", mimeType: "application/json",
    content: Buffer.from(content).toString("base64"), digest: `sha256:${digest}`, sizeBytes: Buffer.byteLength(content) }];
  return { ...send, idempotencyKey: "report-1", friction: {
    reportId: "88888888-8888-4888-8888-888888888888", failureClass: "unsupported-interface", candidate,
    expected: "Interface v1.", observed: "Interface v2.", evidence: [`codeops-context://sha256/${digest}/evidence.json`],
    impact: "The candidate cannot continue.", cause: { certainty: "suspected", description: "Version mismatch." },
    workaround: { limits: "Manual supervisor relay for this message only.", removalCriterion: "Native interface v1 is available." },
    proposedFixWorkItemId: null,
  } };
}

test("friction is validated and accepted once across restart; register stays open", async () => {
  const db = database(); const report = reportInput(db);
  const item = (await worker(db, report)).messages[0];
  assert.equal((await worker(database(db.state), report)).messages[0].messageId, item.messageId);
  const ack = { operation: "acknowledge", messageId: item.messageId };
  await supervisor(db, ack); await supervisor(database(db.state), ack);
  assert.deepEqual([...db.state.register.values()], [1]);
});

test("forged, unverified, secret-bearing and stale-candidate evidence refuses before persistence", async () => {
  for (const mutate of [
    (r) => { r.friction.evidence[0] = `codeops-context://sha256/${"0".repeat(64)}/evidence.json`; },
    (r) => { r.friction.cause.certainty = "verified"; },
    (r) => { r.friction.observed = "token=do-not-export-this-value"; },
    (r) => { r.friction.candidate = `sha256:${"1".repeat(64)}`; },
    (r) => { r.scope = { ...r.scope, projectId: "77777777-7777-4777-8777-777777777777" }; },
  ]) {
    const db = database(); const report = reportInput(db); mutate(report);
    await assert.rejects(worker(db, report));
    assert.equal(db.state.messages.size, 0);
  }
});

test("supervisor endpoint authenticates before reading payload; tokens cannot overlap", async () => {
  let read = false;
  const result = await serveSupervisorMessages({ method: "POST", url: "/v1/supervisor/messages",
    headers: { authorization: `Bearer ${"w".repeat(32)}`, "content-type": "application/json" }, routes: [route],
    readBody: async () => { read = true; return {}; }, operate: async () => { throw new Error("must not execute"); } });
  assert.equal(result.status, 401); assert.equal(read, false);
  assert.throws(() => parseSupervisorRoutes([route], [route.token]));
  assert.equal(agentMessageInputSchema.safeParse({ ...send, executionAuthority: true }).success, false);
});

test("acknowledging a question retains it for answering after supervisor restart", async () => {
  const db = database();
  const item = (await worker(db, send)).messages[0];
  await supervisor(db, { operation: "acknowledge", messageId: item.messageId });
  const inbox = await supervisor(database(db.state), { operation: "inbox" });
  assert.equal(inbox.messages[0].messageId, item.messageId);
  assert.equal(inbox.messages[0].state, "acknowledged");
});

test("reclaimed dispatch replay retains original claim proof instead of adopting it", async () => {
  const db = database();
  const original = (await worker(db, send)).messages[0];
  db.state.claim.claim_count = 2;
  const replay = (await worker(database(db.state), send)).messages[0];
  assert.equal(replay.claimCount, 1);
  assert.equal(replay.authorityDigest, original.authorityDigest);
  assert.equal(db.state.messages.size, 1);
});

test("JSON-shaped credential prose is rejected", () => {
  assert.equal(agentMessageInputSchema.safeParse({ ...send, body: '{"token":"do-not-export"}' }).success, false);
});

test("an empty configured route set leaves ordinary prompt inbox reads empty", async () => {
  const db = { query: async () => { throw new Error("disabled messaging must not change ordinary dispatches"); } };
  assert.deepEqual(await worker(db, { operation: "inbox", limit: 20 }, []), { messages: [] });
});


test("a full stale-route page cannot hide current replies or mutate retained replies", async () => {
  const db = database();
  const stale = [];
  for (let i = 0; i < 20; i++) {
    const question = (await worker(db, { ...send, idempotencyKey: `old-question-${i}` })).messages[0];
    stale.push((await supervisor(db, { operation: "reply", messageId: question.messageId,
      idempotencyKey: `old-answer-${i}`, body: "Old route answer." })).messages[0].messageId);
  }
  const retained = stale.map(id => structuredClone(db.state.messages.get(id)));
  const current = { ...route, version: "v2" };
  const question = (await worker(db, { ...send, idempotencyKey: "current-question" }, [current])).messages[0];
  const reply = (await supervisor(db, { operation: "reply", messageId: question.messageId,
    idempotencyKey: "current-answer", body: "Current answer." }, current)).messages[0];
  for (const limit of [1, 20]) {
    const inbox = await worker(database(db.state), { operation: "inbox", limit }, [current]);
    assert.deepEqual(inbox.messages.map(m => m.messageId), [reply.messageId]);
  }
  await assert.rejects(worker(db, { operation: "acknowledge", messageId: stale[0] }, [current]));
  assert.deepEqual(stale.map(id => db.state.messages.get(id)), retained);
});
