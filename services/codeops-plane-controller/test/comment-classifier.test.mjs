import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelPlaneCommentRequestClassifier } from "../dist/comment-classifier.js";

const eventId = "0afa042d-92a9-4326-bdca-5ff5490dbf09";
const signingKey = "s".repeat(64);

function modelResponse(intent) {
  return {
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({ intent }),
          },
        ],
      },
    ],
  };
}

test("classifies one bounded comment through the small model proxy", async () => {
  const calls = [];
  const classify = createModelPlaneCommentRequestClassifier({
    origin: "http://codeops-model-proxy:8080",
    signingKey,
    now: () => new Date("2026-08-14T11:00:00.000Z"),
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return Response.json(modelResponse("source_change"));
    },
  });

  assert.deepEqual(
    await classify({ eventId, comment: "Could we make this less brittle?" }),
    { intent: "source_change" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://codeops-model-proxy:8080/v1/responses");
  assert.match(calls[0].init.headers.Authorization, /^Bearer v1\./);
  assert.equal(
    calls[0].init.headers["Idempotency-Key"],
    `plane-comment-classifier:${eventId}`,
  );
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "gpt-5.4-nano-2026-03-17");
  assert.equal(body.reasoning.effort, "none");
  assert.equal(body.store, false);
  assert.deepEqual(body.text.format.schema.properties.intent.enum, [
    "ignore",
    "research",
    "response",
    "source_change",
    "steering",
  ]);
  assert.match(body.input[0].content, /'Use option B' as steering/);
  assert.match(body.input[0].content, /'Also cover mobile' as source_change/);
  assert.match(body.input[0].content, /'Create those follow-ups' as source_change/);
  assert.equal(body.input[1].content, "Could we make this less brittle?");
});

test("fails closed on proxy, completion, and schema drift", async () => {
  const classifyWith = (response) =>
    createModelPlaneCommentRequestClassifier({
      origin: "http://codeops-model-proxy:8080",
      signingKey,
      fetch: async () => response,
    });

  await assert.rejects(
    classifyWith(new Response("unavailable", { status: 503 }))({
      eventId,
      comment: "Please continue.",
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    classifyWith(Response.json({ ...modelResponse("steering"), status: "incomplete" }))({
      eventId,
      comment: "Please continue.",
    }),
  );
  await assert.rejects(
    classifyWith(Response.json(modelResponse("do_anything")))({
      eventId,
      comment: "Please continue.",
    }),
  );
});
