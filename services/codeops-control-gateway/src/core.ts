import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  agentJobDispatchRequestSchema,
  agentJobDispatchResultSchema,
  canonicalSerialize,
  researchPersonaReportSchema,
  researchSynthesisSchema,
  type AgentJobDispatchRequest,
  type AgentJobDispatchResult,
} from "@renoconcierge/codeops-contracts";
import { z } from "zod";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EMPTY_PATCH_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const safeEventSchema = z
  .object({
    sequence: z.number().int().positive().max(100_000),
    type: z.string().min(1).max(200),
    toolCallId: z.string().max(500).optional(),
    title: z.string().max(500).optional(),
    status: z.string().max(200).optional(),
  })
  .strict();

const checkpointSchema = z
  .object({
    schemaVersion: z.literal(3),
    runId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
    agentRole: z.enum(["coding-agent", "qa-contract-researcher"]),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    projectContextDigest: z.string().regex(SHA256),
    model: z.literal("gpt-5.6-sol"),
    reasoningEffort: z.literal("high"),
    sessionId: z.string().max(500).optional(),
    stopReason: z.string().max(500).optional(),
    response: z.string().max(20_100),
    events: z.array(safeEventSchema).max(100_000),
    patch: z
      .object({
        path: z.literal("changes.patch"),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().nonnegative().max(2_000_000),
      })
      .strict(),
    error: z.string().max(2_000).optional(),
  })
  .strict();

const checkpointRecordSchema = z
  .object({
    type: z.literal("codeops.checkpoint"),
    checkpointDigest: z.string().regex(SHA256),
    checkpoint: checkpointSchema,
  })
  .strict();

const patchChunkSchema = z
  .object({
    type: z.literal("codeops.patch-chunk"),
    runId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
    sequence: z.number().int().positive().max(100),
    total: z.number().int().positive().max(100),
    patchDigest: z.string().regex(SHA256),
    dataBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();

export interface RetainedCheckpoint {
  readonly checkpoint: z.infer<typeof checkpointSchema>;
  readonly checkpointDigest: string;
  readonly patch: Buffer;
}

export function authenticateBearer(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const received = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return (
    received.length === expected.length &&
    received.length > 0 &&
    timingSafeEqual(received, expected)
  );
}

export function parseDispatchRequest(value: unknown): AgentJobDispatchRequest {
  return agentJobDispatchRequestSchema.parse(value);
}

export function createRunIdentity(request: AgentJobDispatchRequest): {
  readonly runId: string;
  readonly requestDigest: string;
} {
  const requestDigest = createHash("sha256")
    .update(canonicalSerialize(request))
    .digest("hex");
  return {
    runId: `agent-${requestDigest.slice(0, 24)}`,
    requestDigest: `sha256:${requestDigest}`,
  };
}

export function buildAgentPrompt(request: AgentJobDispatchRequest): string {
  if (request.role === "coding-agent") {
    return [
      "You are the bounded RenoConcierge CodeOps coding agent.",
      `Work item: ${request.workItemId}`,
      `Exact base SHA: ${request.baseSha}`,
      `Task: ${request.summary}`,
      `Project context digest: ${request.codingRequest.projectContext.digest}`,
      "Read /context/project-context.json and every manifested repository document before planning.",
      "Read /context/research-packet.json; it is the immutable handoff from research.",
      `Acceptance criteria: ${JSON.stringify(
        request.codingRequest.workItem.acceptanceCriteria,
      )}`,
      "Make only the smallest source changes required by the task.",
      "Do not push, open or merge a PR, deploy, or access Plane/Kubernetes.",
      "Finish with a concise summary of changes and tests.",
    ].join("\n");
  }
  if (request.researchStage.kind === "synthesis") {
    return [
      "You are the final QA Contract Researcher synthesizer.",
      "Research only. The source workspace is read-only.",
      `Plane work item: ${request.workItemId}`,
      `Exact base SHA: ${request.baseSha}`,
      `Project context digest: ${request.researchRequest.projectContext.digest}`,
      "Read /context/project-context.json, /context/research-dispatch.json, and every manifested repository document.",
      "The dispatch file contains the immutable ticket title, description, acceptance content, relevant human comments, revision, dependencies, a bounded same-project task index, and every persona report.",
      "Deduplicate findings, reconcile conflicts, and make the result specific to this ticket.",
      "Return no more than five ranked findings and three genuine product decisions.",
      "Populate the versioned route/state/credential matrix from repository truth.",
      "Classify out-of-scope defects as downstream findings.",
      "Propose two to five same-project follow-up tasks when high- or medium-severity findings have strong repository evidence; prioritize security findings. Use targetWorkItemId to update a matching task from the immutable project task index, otherwise use null to create one. Do not create duplicate tasks.",
      "Do not propose lifecycle, label, project, or comment mutations. The trusted projector alone may refine the current description and create or update these bounded tasks.",
      "Every finding and matrix row needs exact source path/line citations; include exact test names when citing a test.",
      "Return only one JSON object, without Markdown fences, with exactly this shape:",
      JSON.stringify({
        version: "codeops.research-synthesis/v1",
        requestId: request.researchRequest.requestId,
        verdict: "ready-to-refine",
        summary: "ticket-specific verdict",
        topFindings: [
          {
            id: "finding-1",
            category: "matrix-fact",
            severity: "high",
            confidence: "high",
            currentBehavior: "observed behavior",
            expectedBehavior: "expected contract",
            citationIds: ["citation-1"],
          },
        ],
        decisions: [
          {
            question: "genuine product decision",
            blocking: true,
            citationIds: ["citation-1"],
          },
        ],
        downstreamFindings: [],
        followUpTasks: [
          {
            key: "otp-rate-limit",
            area: "security",
            targetWorkItemId: null,
            title: "Bound OTP verification attempts",
            objective: "Prevent unbounded OTP guessing during the validity window.",
            acceptanceCriteria: [
              "Attempts are bounded per challenge and identity.",
              "Executable tests cover exhaustion and reset behavior.",
            ],
            sourceFindingIds: ["finding-1"],
            citationIds: ["citation-1"],
          },
        ],
        matrix: {
          version: "codeops.route-state-credential-matrix/v1",
          rows: [
            {
              id: "matrix-1",
              lifecycleState: "state",
              credentialState: "credential",
              routeOrRpc: "route or RPC",
              currentOracle: "current behavior",
              expectedOracle: "expected behavior",
              allowedSideEffects: "allowed mutations",
              status: "verified",
              citationIds: ["citation-1"],
            },
          ],
        },
        citations: [
          {
            id: "citation-1",
            path: "relative/source/path.ts",
            lineStart: 1,
            lineEnd: 2,
            testName: "exact test name when applicable",
            claim: "claim supported by these lines",
          },
        ],
      }),
    ].join("\n");
  }
  const personaScopes: Record<string, string> = {
    "@ai-security":
      "Find exploit paths, rank severity and confidence, and map trust boundaries.",
    "@ai-database":
      "Map canonical states, transitions, database privileges, and failure atomicity.",
    "@ai-web":
      "Build the route/RPC oracle matrix and cite executable browser/runtime evidence.",
    "@ai-infra":
      "Inspect deployment boundaries, runtime configuration, isolation, and failure recovery.",
    "@ai-design":
      "Inspect user-visible states, error recovery, and interaction contract gaps.",
    "@ai-product":
      "Separate ticket facts from genuine product decisions and downstream scope.",
    "@ai-ml":
      "Inspect model/data contracts, evaluation evidence, and probabilistic failure modes.",
  };
  return [
    `You are the ${request.researchStage.persona} QA Contract Researcher perspective.`,
    "Research only. The source workspace is read-only.",
    `Plane work item: ${request.workItemId}`,
    `Exact base SHA: ${request.baseSha}`,
    `Brief: ${request.researchRequest.brief}`,
    `Distinct assignment: ${personaScopes[request.researchStage.persona]}`,
    `Project context digest: ${request.researchRequest.projectContext.digest}`,
    "Read /context/project-context.json, /context/research-dispatch.json, and every manifested repository document before research.",
    "The dispatch file contains the immutable ticket title, description, acceptance content, relevant human comments, revision, dependencies, and a bounded same-project task index.",
    "Stay within the distinct assignment above; classify each result as a matrix fact, product decision, or downstream defect.",
    "Every finding needs exact source path/line citations; include exact test names when citing a test.",
    "Never propose or perform a Plane lifecycle-state change.",
    "Return only one JSON object, without Markdown fences, with exactly this shape:",
    JSON.stringify({
      version: "codeops.research-persona-report/v2",
      requestId: request.researchRequest.requestId,
      persona: request.researchStage.persona,
      outcome: "findings",
      summary: "bounded plain-text summary",
      findings: [
        {
          id: "finding-1",
          category: "matrix-fact",
          severity: "high",
          confidence: "high",
          currentBehavior: "observed behavior",
          expectedBehavior: "expected contract",
          citationIds: ["citation-1"],
        },
      ],
      decisions: [
        {
          question: "decision or unresolved question",
          blocking: false,
          citationIds: ["citation-1"],
        },
      ],
      citations: [
        {
          id: "citation-1",
          path: "relative/source/path.ts",
          lineStart: 1,
          lineEnd: 2,
          testName: "exact test name when applicable",
          claim: "claim supported by these lines",
        },
      ],
    }),
  ].join("\n");
}

export function parseCheckpointLogs(input: {
  logs: string;
  request: AgentJobDispatchRequest;
  runId: string;
}): RetainedCheckpoint {
  const checkpoints: unknown[] = [];
  const chunks: z.infer<typeof patchChunkSchema>[] = [];
  for (const line of input.logs.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "codeops.checkpoint"
    ) {
      checkpoints.push(value);
    } else if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "codeops.patch-chunk"
    ) {
      chunks.push(patchChunkSchema.parse(value));
    }
  }
  if (checkpoints.length !== 1) {
    throw new Error("Agent Job must emit exactly one checkpoint record");
  }
  const rawRecord = checkpoints[0] as { checkpoint?: unknown };
  const record = checkpointRecordSchema.parse(rawRecord);
  const checkpoint = record.checkpoint;
  const serializedCheckpoint = JSON.stringify(rawRecord.checkpoint);
  if (serializedCheckpoint === undefined) {
    throw new Error("Agent Job checkpoint is not serializable");
  }
  const computedCheckpointDigest = `sha256:${createHash("sha256")
    .update(serializedCheckpoint)
    .digest("hex")}`;
  if (record.checkpointDigest !== computedCheckpointDigest) {
    throw new Error("Agent Job checkpoint digest mismatch");
  }
  if (
    checkpoint.runId !== input.runId ||
    checkpoint.agentRole !== input.request.role ||
    checkpoint.baseSha !== input.request.baseSha ||
    checkpoint.projectContextDigest !==
      (input.request.role === "coding-agent"
        ? input.request.codingRequest.projectContext.digest
        : input.request.researchRequest.projectContext.digest)
  ) {
    throw new Error("Agent Job checkpoint identity mismatch");
  }
  if (checkpoint.error) {
    throw new Error(`Agent Job checkpoint reported failure: ${checkpoint.error}`);
  }
  if (chunks.length === 0) {
    throw new Error("Agent Job did not emit patch evidence");
  }
  const totals = new Set(chunks.map((chunk) => chunk.total));
  const digests = new Set(chunks.map((chunk) => chunk.patchDigest));
  if (totals.size !== 1 || digests.size !== 1) {
    throw new Error("Agent Job patch chunks disagree");
  }
  const total = chunks[0]!.total;
  if (
    chunks.length !== total ||
    new Set(chunks.map((chunk) => chunk.sequence)).size !== total
  ) {
    throw new Error("Agent Job patch chunks are incomplete or duplicated");
  }
  const ordered = [...chunks].sort((a, b) => a.sequence - b.sequence);
  if (ordered.some((chunk, index) => chunk.sequence !== index + 1)) {
    throw new Error("Agent Job patch chunk sequence is invalid");
  }
  const patch = Buffer.concat(
    ordered.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
  const patchDigest = createHash("sha256").update(patch).digest("hex");
  if (
    `sha256:${patchDigest}` !== ordered[0]!.patchDigest ||
    patchDigest !== checkpoint.patch.sha256 ||
    patch.length !== checkpoint.patch.bytes
  ) {
    throw new Error("Agent Job retained patch does not match its checkpoint");
  }
  if (
    input.request.role === "qa-contract-researcher" &&
    (patch.length !== 0 || patchDigest !== EMPTY_PATCH_SHA256)
  ) {
    throw new Error("QA Contract Researcher produced a source patch");
  }
  return {
    checkpoint,
    checkpointDigest: record.checkpointDigest,
    patch,
  };
}

async function atomicWrite(filePath: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  const handle = await open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

export async function retainCheckpoint(input: {
  rootDirectory: string;
  request: AgentJobDispatchRequest;
  runId: string;
  requestDigest: string;
  retained: RetainedCheckpoint;
}): Promise<AgentJobDispatchResult> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  await claimRequest(input);
  const requestPath = path.join(directory, "request.json");
  const existing = JSON.parse(await readFile(requestPath, "utf8")) as {
    requestDigest?: unknown;
  };
  if (existing.requestDigest !== input.requestDigest) {
    throw new Error("durable Agent Job identity drift");
  }
  await atomicWrite(
    path.join(directory, "checkpoint.json"),
    `${JSON.stringify(input.retained.checkpoint, null, 2)}\n`,
  );
  await atomicWrite(path.join(directory, "changes.patch"), input.retained.patch);
  const result = agentJobDispatchResultSchema.parse({
    version: "codeops.agent-job-dispatch-result/v1",
    role: input.request.role,
    runId: input.runId,
    checkpointUri: `artifact:///agent-runs/${input.runId}/checkpoint.json`,
    checkpointDigest: input.retained.checkpointDigest,
    checkpointSizeBytes: Buffer.byteLength(
      JSON.stringify(input.retained.checkpoint),
    ),
    ...(input.request.role === "qa-contract-researcher"
      ? {
          researchResult:
            input.request.researchStage.kind === "persona"
              ? {
                  kind: "persona",
                  report: researchPersonaReportSchema.parse(
                    JSON.parse(input.retained.checkpoint.response) as unknown,
                  ),
                }
              : {
                  kind: "synthesis",
                  synthesis: researchSynthesisSchema.parse(
                    JSON.parse(input.retained.checkpoint.response) as unknown,
                  ),
                },
        }
      : {}),
  });
  if (input.request.role === "qa-contract-researcher") {
    if (
      result.role !== "qa-contract-researcher" ||
      result.researchResult.kind !== input.request.researchStage.kind
    ) {
      throw new Error("research report identity does not match its dispatch");
    }
    if (
      input.request.researchStage.kind === "persona" &&
      (result.researchResult.kind !== "persona" ||
        result.researchResult.report.requestId !==
          input.request.researchRequest.requestId ||
        result.researchResult.report.persona !==
          input.request.researchStage.persona)
    ) {
      throw new Error("research persona identity does not match its dispatch");
    }
    if (
      input.request.researchStage.kind === "synthesis" &&
      (result.researchResult.kind !== "synthesis" ||
        result.researchResult.synthesis.requestId !==
          input.request.researchRequest.requestId)
    ) {
      throw new Error("research synthesis identity does not match its dispatch");
    }
  }
  await atomicWrite(
    path.join(directory, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

export async function claimRequest(input: {
  rootDirectory: string;
  request: AgentJobDispatchRequest;
  runId: string;
  requestDigest: string;
}): Promise<void> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  const requestPath = path.join(directory, "request.json");
  try {
    const existing = JSON.parse(await readFile(requestPath, "utf8")) as {
      requestDigest?: unknown;
    };
    if (existing.requestDigest !== input.requestDigest) {
      throw new Error("durable Agent Job identity drift");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(
      requestPath,
      `${JSON.stringify(
        { requestDigest: input.requestDigest, request: input.request },
        null,
        2,
      )}\n`,
    );
  }
}

export async function readRetainedResult(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
}): Promise<AgentJobDispatchResult | null> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  try {
    const request = JSON.parse(
      await readFile(path.join(directory, "request.json"), "utf8"),
    ) as { requestDigest?: unknown };
    if (request.requestDigest !== input.requestDigest) {
      throw new Error("durable Agent Job identity drift");
    }
    return agentJobDispatchResultSchema.parse(
      JSON.parse(await readFile(path.join(directory, "result.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function retainFailure(input: {
  rootDirectory: string;
  runId: string;
  requestDigest: string;
  error: unknown;
  logs: string;
}): Promise<void> {
  const directory = path.join(input.rootDirectory, "agent-runs", input.runId);
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  await atomicWrite(
    path.join(directory, "failure.json"),
    `${JSON.stringify(
      {
        requestDigest: input.requestDigest,
        error: message.slice(0, 2_000),
        recordedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  await atomicWrite(
    path.join(directory, "session-gateway.log"),
    input.logs.slice(0, 4_000_000),
  );
}
