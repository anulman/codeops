import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import {
  canonicalJsonText, sha256CanonicalJsonDigest,
  githubBranchPublishCandidateSchema, githubBranchPublishInputSchema,
  githubMutationProviderRequestSchema, githubMutationResultSchema,
  githubMutationReconciliationResultSchema, githubPullRequestCreateInputSchema,
  sessionPermissionOperationSchema, sessionRuntimeDispatchSchema, sessionSnapshotSchema,
  isWorkspaceSessionIdentity,
  workspaceLaunchSchema, workspaceLaunchRequestSchema, workspaceLaunchSessionId,
  type GitHubMutationProviderRequest, type GitHubMutationResult,
  type GitHubMutationReconciliationResult,
} from "@codeops/codeops-contracts";
import { workspaceContextAttachmentDescriptors } from "@codeops/codeops-contracts/workspace-context-node";
import { authenticatedCheckpointOperator } from "./checkpoint-recovery.js";
import type { TransactionClient } from "./session-broker-repository.js";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const text = z.string().min(1).max(256);
const evidenceSchema = z.object({
  version: z.literal("codeops.retained-source-evidence/v1"),
  recoveryId: uuid,
  origin: z.literal("retained-source"),
  retainedSourceId: text,
  sourceManifestDigest: digest,
  historical: z.object({
    sessionId: text, dispatchId: uuid,
    // Absent for the existing admitted origin; never an admission UUID.
    workspaceLaunchId: z.string().regex(/^launch-[0-9a-f]{24}$/).optional(),
    // Digest of the read-only SQL projection in readHistory below.
    digest,
    checkpointBindingFailed: z.boolean(),
    workerState: z.literal("terminated"),
    terminationEvidenceId: text,
  }).strict(),
  authority: z.object({
    principalId: text, sessionId: text, generation: z.number().int().positive(),
    leaseId: uuid, expiresAt: z.string().datetime(),
  }).strict(),
  candidate: githubBranchPublishCandidateSchema,
  candidateDigest: digest,
  checks: z.object({
    candidateDigest: digest,
    sourceManifestDigest: digest,
    focused: z.literal("accepted"), full: z.literal("accepted"),
    qualificationEvidenceId: text, reviewEvidenceId: text,
    reviewerId: text, review: z.literal("accepted"),
  }).strict(),
  publication: z.object({
    baseBranch: z.string(), branchName: z.string(), commitMessage: z.string(),
    title: z.string(), body: z.string(), draft: z.boolean(),
  }).strict(),
}).strict();
export type RetainedSourceEvidence = z.infer<typeof evidenceSchema>;
const envelopeSchema = z.object({ evidence: evidenceSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();
const domain = "codeops.retained-source-evidence/v1\0";

/** Only the isolated verifier signs this domain. Operators submit an identity,
 * never source bytes, qualification assertions, or runtime completion claims. */
export function verifyRetainedSourceEvidence(raw: unknown, publicKey: string): RetainedSourceEvidence {
  const envelope = envelopeSchema.parse(raw);
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519" || !verify(null,
    Buffer.from(domain + canonicalJsonText(envelope.evidence)), key,
    Buffer.from(envelope.signature, "base64"))) throw new Error("Retained source signature is invalid");
  const evidence = envelope.evidence;
  if (evidence.candidate.binding === undefined ||
      evidence.candidateDigest !== sha256CanonicalJsonDigest(evidence.candidate) ||
      evidence.checks.candidateDigest !== evidence.candidateDigest ||
      evidence.checks.sourceManifestDigest !== evidence.sourceManifestDigest ||
      evidence.candidate.binding.treeSha === evidence.candidate.binding.baseTreeSha) {
    throw new Error("Retained source or accepted checks do not bind the exact candidate");
  }
  return evidence;
}

export async function readRetainedSourceEvidence(root: string, evidenceDigest: string,
  publicKey: string): Promise<RetainedSourceEvidence> {
  digest.parse(evidenceDigest);
  if (!path.isAbsolute(root) || await realpath(root) !== path.resolve(root)) {
    throw new Error("Retained source evidence root must be a real absolute directory");
  }
  // No caller-controlled path, directory traversal, or symlink following.
  const file = await open(path.join(root, `${evidenceDigest.slice(7)}.json`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 4_500_000) {
      throw new Error("Retained source evidence must be a bounded regular file");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    if (count !== stat.size) throw new Error("Retained source evidence changed during read");
    const evidence = verifyRetainedSourceEvidence(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))), publicKey);
    if (sha256CanonicalJsonDigest(evidence) !== evidenceDigest) {
      throw new Error("Retained source evidence identity changed");
    }
    return evidence;
  } finally { await file.close(); }
}

async function readHistory(client: TransactionClient, evidence: RetainedSourceEvidence,
  current: Awaited<ReturnType<typeof requireCurrentAuthority>>) {
  const launchId = evidence.historical.workspaceLaunchId;
  // Preserve the admitted projection byte-for-byte. Root evidence additionally
  // signs the actual full launch rows, including the persisted request. Read up
  // to two matches so a second claimed Session origin cannot be hidden.
  const rootProjection = launchId === undefined ? "" : ` || jsonb_build_object(
       'workspaceLaunches', (SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY launch_id),'[]'::jsonb)
         FROM (SELECT * FROM codeops.workspace_launches
           WHERE launch_id=$3 OR launch_json->>'sessionId'=$1
             OR launch_json#>>'{retryRuntime,sessionId}'=$1
           ORDER BY launch_id LIMIT 2) w))`;
  const history = (await client.query<{ history: unknown }>(
    `SELECT jsonb_build_object(
       'session', (SELECT to_jsonb(s) FROM codeops.sessions s WHERE session_id=$1),
       'dispatch', (SELECT to_jsonb(d) FROM codeops.session_runtime_outbox d WHERE dispatch_id=$2),
       'progress', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY generation),'[]'::jsonb)
          FROM codeops.session_runtime_job_progress p WHERE session_id=$1),
       'checkpoints', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY checkpoint_id),'[]'::jsonb)
          FROM codeops.workspace_checkpoint_descriptors c WHERE session_id=$1)
     )${rootProjection} AS history`, [evidence.historical.sessionId, evidence.historical.dispatchId,
      ...(launchId === undefined ? [] : [launchId])])).rows[0]?.history;
  if (sha256CanonicalJsonDigest(history) !== evidence.historical.digest) {
    throw new Error("Retained historical evidence changed");
  }
  const parsed = z.object({
    session: z.object({ session_id: text }),
    dispatch: z.object({ dispatch_id: uuid, session_id: text,
      admission_id: uuid.nullable(), dispatch_json: sessionRuntimeDispatchSchema }),
    progress: z.array(z.object({ resource_configuration_digest: digest.nullable() }).passthrough()),
  }).passthrough().parse(history);
  if (parsed.session.session_id !== evidence.historical.sessionId ||
      parsed.dispatch.session_id !== evidence.historical.sessionId ||
      parsed.dispatch.dispatch_id !== evidence.historical.dispatchId ||
      parsed.dispatch.dispatch_json.command.sessionId !== evidence.historical.sessionId ||
      (evidence.historical.checkpointBindingFailed &&
        !parsed.progress.some((row) => row.resource_configuration_digest === null))) {
    throw new Error("Retained source history does not match its origin");
  }
  const identity = parsed.dispatch.dispatch_json.snapshot.identity;
  const binding = evidence.candidate.binding!;
  if (!isWorkspaceSessionIdentity(identity) || !identity.workspace.sources.some((source) =>
    source.repository === binding.repository && source.resolvedSha === binding.baseSha)) {
    throw new Error("Retained source is outside its historical repository and base");
  }
  if (launchId === undefined) {
    // The existing admitted path still requires its real admission UUID.
    uuid.parse(parsed.dispatch.admission_id);
  } else {
    requireRootLaunchOrigin(history, evidence, current);
  }
  return { ...parsed.dispatch, workspaceLaunchId: launchId };
}

function rootUuid(value: string): string {
  // The original root controller's deterministic identity, not a new identity.
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function requireRootLaunchOrigin(history: unknown, evidence: RetainedSourceEvidence,
  current: Awaited<ReturnType<typeof requireCurrentAuthority>>): void {
  const parsed = z.object({
    session: z.object({ session_id: text, owner_principal_id: text,
      snapshot_json: sessionSnapshotSchema }),
    dispatch: z.object({ dispatch_id: uuid, session_id: text, principal_id: text,
      idempotency_key: uuid, admission_id: z.null(), dispatch_json: sessionRuntimeDispatchSchema }),
    workspaceLaunches: z.array(z.object({ launch_id: text, principal_id: text,
      idempotency_key: uuid, request_digest: digest, request_json: z.unknown(),
      launch_json: workspaceLaunchSchema, state: text })).length(1),
  }).parse(history);
  const row = parsed.workspaceLaunches[0]!;
  const launch = row.launch_json;
  const request = workspaceLaunchRequestSchema.parse(row.request_json);
  const dispatch = parsed.dispatch.dispatch_json;
  const identity = dispatch.snapshot.identity;
  const session = parsed.session.snapshot_json;
  const expectedLaunchId = `launch-${sha256CanonicalJsonDigest({
    principalId: row.principal_id, idempotencyKey: row.idempotency_key,
  }).slice(7, 31)}`;
  const sessionId = workspaceLaunchSessionId(expectedLaunchId);
  const same = (a: unknown, b: unknown) => canonicalJsonText(a) === canonicalJsonText(b);
  if (row.launch_id !== evidence.historical.workspaceLaunchId ||
      row.launch_id !== expectedLaunchId || launch.launchId !== row.launch_id ||
      launch.principalId !== row.principal_id || row.principal_id !== evidence.authority.principalId ||
      parsed.session.owner_principal_id !== row.principal_id ||
      parsed.dispatch.principal_id !== row.principal_id || dispatch.principalId !== row.principal_id ||
      request.idempotencyKey !== row.idempotency_key || launch.idempotencyKey !== row.idempotency_key ||
      row.request_digest !== sha256CanonicalJsonDigest(row.request_json) ||
      launch.requestDigest !== row.request_digest || launch.promptDigest !== sha256CanonicalJsonDigest(request.prompt) ||
      launch.state !== row.state || launch.retryRuntime !== undefined || dispatch.retryAuthority !== undefined ||
      sessionId !== evidence.historical.sessionId || parsed.session.session_id !== sessionId ||
      session.sessionId !== sessionId || parsed.dispatch.session_id !== sessionId ||
      dispatch.snapshot.sessionId !== sessionId || dispatch.command.sessionId !== sessionId ||
      parsed.dispatch.dispatch_id !== rootUuid(`${row.launch_id}:dispatch`) ||
      dispatch.dispatchId !== parsed.dispatch.dispatch_id ||
      parsed.dispatch.dispatch_id !== evidence.historical.dispatchId ||
      parsed.dispatch.idempotency_key !== rootUuid(`${row.launch_id}:prompt`) ||
      dispatch.command.idempotencyKey !== parsed.dispatch.idempotency_key ||
      dispatch.command.type !== "prompt" || dispatch.command.prompt !== request.prompt ||
      !same(dispatch.command.contextAttachments ?? [], request.contextAttachments ?? []) ||
      dispatch.command.leaseId !== rootUuid(`${row.launch_id}:lease`) ||
      dispatch.snapshot.lease?.leaseId !== dispatch.command.leaseId ||
      dispatch.command.generation !== dispatch.snapshot.generation ||
      (launch.state === "ready" && (launch.sessionId !== sessionId ||
        launch.initialPromptCommandId !== dispatch.command.idempotencyKey)) ||
      !isWorkspaceSessionIdentity(identity) || identity.parentSessionId !== null ||
      identity.forkedAtCursor !== null || identity.workflowId !== "workspace-launch" ||
      identity.runId !== row.launch_id || !same(identity.workspace, launch.workspace) ||
      !same(session.identity, identity) || !same(identity.policy, launch.policy) ||
      launch.policy.mode !== request.mode || launch.title !== request.title ||
      !same(launch.contextAttachments, workspaceContextAttachmentDescriptors(request.contextAttachments ?? [])) ||
      !same(identity.contextAttachments ?? [], launch.contextAttachments) ||
      !same(request.sources.map(({ catalogKey }) => catalogKey),
        launch.workspace.sources.map(({ catalogKey }) => catalogKey)) ||
      !isWorkspaceSessionIdentity(current.identity) || !same(current.identity.workspace, launch.workspace)) {
    throw new Error("Retained source root WorkspaceLaunch origin does not match persisted authority");
  }
}

async function requireCurrentAuthority(client: TransactionClient,
  evidence: RetainedSourceEvidence, principalId: string, readOnly = false) {
  const row = (await client.query<{ snapshot_json: unknown; database_now: unknown }>(
    `SELECT snapshot_json,clock_timestamp() AS database_now FROM codeops.sessions
      WHERE session_id=$1 AND owner_principal_id=$2 FOR SHARE`,
    [evidence.authority.sessionId, principalId])).rows[0];
  const snapshot = sessionSnapshotSchema.parse(row?.snapshot_json);
  const now = new Date(String(row?.database_now));
  if (principalId !== evidence.authority.principalId ||
      snapshot.sessionId !== evidence.authority.sessionId ||
      snapshot.generation !== evidence.authority.generation ||
      snapshot.lease?.leaseId !== evidence.authority.leaseId ||
      !isWorkspaceSessionIdentity(snapshot.identity) ||
      !snapshot.identity.workspace.sources.some((source) =>
        source.repository === evidence.candidate.binding!.repository &&
        source.resolvedSha === evidence.candidate.binding!.baseSha) ||
      !Number.isFinite(now.getTime()) ||
      (!readOnly && Date.parse(evidence.authority.expiresAt) <= now.getTime())) {
    throw new Error("Retained source requires current repository operator authority");
  }
  return snapshot;
}

type Step = "branch" | "pull-request";
interface RecoveryRow extends Record<string, unknown> {
  evidence_digest: string;
  evidence_json: unknown;
}
interface EffectRow extends Record<string, unknown> {
  request_json: unknown;
  state: string;
  attempted_at: Date | string;
  result_json: unknown;
}

function publicationRequest(evidence: RetainedSourceEvidence,
  historical: Awaited<ReturnType<typeof readHistory>>, step: Step,
  headSha?: string): GitHubMutationProviderRequest {
  const binding = evidence.candidate.binding!;
  const candidateBytes = Buffer.byteLength(canonicalJsonText(evidence.candidate));
  const publication = evidence.publication;
  const input = step === "branch" ? githubBranchPublishInputSchema.parse({
    repository: binding.repository, mode: "create", expectedHeadSha: binding.baseSha,
    baseBranch: publication.baseBranch, branchName: publication.branchName,
    commitMessage: publication.commitMessage,
    candidate: { manifestId: `githubcandidate-${evidence.candidateDigest.slice(7)}`,
      digest: evidence.candidateDigest, sizeBytes: candidateBytes,
      chunkCount: Math.ceil(candidateBytes / 65_536) },
  }) : githubPullRequestCreateInputSchema.parse({
    repository: binding.repository, expectedHeadSha: headSha, expectedBaseSha: binding.baseSha,
    headBranch: publication.branchName, baseBranch: publication.baseBranch,
    title: publication.title,
    body: `${publication.body}\n\nSource origin: recovered retained source (${evidence.recoveryId}).\nThis publication does not assert historical runtime success.`,
    draft: publication.draft,
  });
  const operation = step === "branch" ? "branch_publish" : "pull_request_create";
  const permission = sessionPermissionOperationSchema.parse({ kind: "github_mutation",
    repository: binding.repository, operation, pullRequestNumber: null,
    targetId: publication.branchName, expectedHeadSha: input.expectedHeadSha,
    payloadJson: canonicalJsonText(input) });
  const dispatch = historical.dispatch_json;
  return githubMutationProviderRequestSchema.parse({
    version: "codeops.github-mutation-provider-request/v1",
    operationId: `githubmutation-${sha256CanonicalJsonDigest({
      recoveryId: evidence.recoveryId, evidenceDigest: sha256CanonicalJsonDigest(evidence), step,
    }).slice(7)}`,
    payloadDigest: sha256CanonicalJsonDigest(input),
    permissionDigest: sha256CanonicalJsonDigest(permission), operation, input,
    provenance: {
      sourceRecoveryId: evidence.recoveryId,
      sessionId: evidence.historical.sessionId, dispatchId: evidence.historical.dispatchId,
      admissionId: historical.admission_id,
      ...(historical.workspaceLaunchId === undefined ? {} : {
        workspaceLaunchId: historical.workspaceLaunchId,
      }),
      sessionGeneration: dispatch.snapshot.generation,
      sessionLeaseId: dispatch.snapshot.lease?.leaseId,
      permissionRequestId: `recovery-${evidence.recoveryId}-${step}`,
      authorizationExpiresAt: evidence.authority.expiresAt,
      principalDigest: `sha256:${createHash("sha256").update(evidence.authority.principalId).digest("hex")}`,
    },
  });
}

export interface RetainedSourceRecoveryDependencies {
  readonly connect: () => Promise<TransactionClient & { release(): void }>;
  readonly loadEvidence: (digest: string) => Promise<RetainedSourceEvidence>;
  readonly resolveRepository: (repository: string) => unknown;
  readonly mutate: (request: GitHubMutationProviderRequest) => Promise<GitHubMutationResult>;
  readonly reconcile: (request: GitHubMutationProviderRequest, attemptedAt: Date) =>
    Promise<GitHubMutationReconciliationResult>;
}

/** The only writes here are new recovery records. Historical Session, dispatch,
 * progress, claim, completion and checkpoint records are never repaired. */
export async function serveRetainedSourceRecovery(input: RetainedSourceRecoveryDependencies & {
  readonly method: string | undefined; readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders; readonly token: string;
  readonly readBody: () => Promise<unknown>;
}): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const url = new URL(input.url ?? "/", "http://codeops.internal");
  const match = /^\/v1\/retained-source-recoveries\/([^/]+)\/(finalize|branch|pull-request|reconcile-branch|reconcile-pull-request)$/.exec(url.pathname);
  if (match === null) return null;
  if (input.method !== "POST") return { status: 405, body: { status: "method-not-allowed" } };
  let principalId: string;
  try { principalId = authenticatedCheckpointOperator(input).principalId; }
  catch { return { status: 401, body: { status: "unauthorized" } }; }
  if (url.search !== "" || !uuid.safeParse(match[1]).success ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(input.headers["content-type"]))) {
    return { status: 400, body: { status: "invalid-request" } };
  }
  const body = z.object({ evidenceDigest: digest }).strict().parse(await input.readBody());
  const evidence = await input.loadEvidence(body.evidenceDigest);
  if (evidence.recoveryId !== match[1] || sha256CanonicalJsonDigest(evidence) !== body.evidenceDigest) {
    throw new Error("Recovery request does not match verified evidence");
  }
  input.resolveRepository(evidence.candidate.binding!.repository);
  const client = await input.connect();
  let request: GitHubMutationProviderRequest | undefined;
  let attemptedAt: Date | undefined;
  const reconcile = match[2]!.startsWith("reconcile-");
  const step: Step = match[2]!.endsWith("pull-request") ? "pull-request" : "branch";
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const current = await requireCurrentAuthority(client, evidence, principalId, reconcile);
    const historical = await readHistory(client, evidence, current);
    const priorEffects = await client.query(`SELECT effect_id FROM codeops.provider_effect_receipts
      WHERE (dispatch_id=$1 OR target_id=$3) AND repository=$2
        AND operation IN ('branch_publish','pull_request_create') LIMIT 1`,
    [evidence.historical.dispatchId, evidence.candidate.binding!.repository, evidence.publication.branchName]);
    if (priorEffects.rows.length !== 0) {
      throw new Error("Historical publication effects require their original reconciliation path");
    }
    // Validate both publication metadata contracts before finalizing anything.
    publicationRequest(evidence, historical, "branch");
    publicationRequest(evidence, historical, "pull-request", evidence.candidate.binding!.baseSha);
    await client.query(`INSERT INTO codeops.retained_source_recoveries
      (recovery_id,evidence_digest,evidence_json,principal_id,origin,retained_source_id,source_key,publication_key)
      VALUES($1,$2,$3::jsonb,$4,'retained-source',$5,$6,$7) ON CONFLICT DO NOTHING`,
    [evidence.recoveryId, body.evidenceDigest, canonicalJsonText(evidence), principalId,
      evidence.retainedSourceId, sha256CanonicalJsonDigest({
        dispatchId: evidence.historical.dispatchId,
        binding: evidence.candidate.binding,
      }), sha256CanonicalJsonDigest({ repository: evidence.candidate.binding!.repository,
        branchName: evidence.publication.branchName })]);
    const stored = (await client.query<RecoveryRow>(`SELECT evidence_digest,evidence_json
      FROM codeops.retained_source_recoveries WHERE recovery_id=$1 FOR UPDATE`,
    [evidence.recoveryId])).rows[0];
    if (!stored || stored.evidence_digest !== body.evidenceDigest ||
        canonicalJsonText(stored.evidence_json) !== canonicalJsonText(evidence)) {
      throw new Error("Recovery identity conflicts with retained source finalization");
    }
    if (match[2] === "finalize") {
      await client.query("COMMIT");
      return { status: 200, body: { recoveryId: evidence.recoveryId,
        origin: "retained-source", candidateDigest: evidence.candidateDigest,
        state: "source-finalized" } };
    }
    let headSha: string | undefined;
    if (step === "pull-request") {
      const branch = (await client.query<EffectRow>(`SELECT request_json,state,attempted_at,result_json
        FROM codeops.retained_source_effects WHERE recovery_id=$1 AND step='branch'`,
      [evidence.recoveryId])).rows[0];
      const result = githubMutationResultSchema.parse(branch?.result_json);
      if (!branch || !["succeeded", "reconciled_satisfied"].includes(branch.state) ||
          result.version !== "codeops.github-branch-publish-result/v1") {
        throw new Error("Recovery pull request requires an observed branch publication");
      }
      headSha = result.headSha;
    }
    request = publicationRequest(evidence, historical, step, headSha);
    const effect = (await client.query<EffectRow>(`SELECT request_json,state,attempted_at,result_json
      FROM codeops.retained_source_effects WHERE recovery_id=$1 AND step=$2 FOR UPDATE`,
    [evidence.recoveryId, step])).rows[0];
    if (effect) {
      if (canonicalJsonText(effect.request_json) !== canonicalJsonText(request)) {
        throw new Error("Recovery provider effect identity changed");
      }
      if (["succeeded", "reconciled_satisfied"].includes(effect.state)) {
        const result = githubMutationResultSchema.parse(effect.result_json);
        await client.query("COMMIT");
        return { status: 200, body: { origin: "retained-source", result } };
      }
      if (!reconcile || !["attempting", "unknown"].includes(effect.state)) {
        throw new Error("Recovery effect cannot be retried; reconcile an unknown outcome");
      }
      attemptedAt = new Date(effect.attempted_at);
      // Publication has a bounded 20-minute deadline. Never reconcile an active call.
      const clock = (await client.query<{ now: unknown }>("SELECT clock_timestamp() AS now")).rows[0];
      const elapsed = new Date(String(clock?.now)).getTime() - attemptedAt.getTime();
      if (!Number.isFinite(elapsed) || elapsed < 1_200_000) {
        throw new Error("Recovery effect is still inside its attempt window");
      }
    } else {
      if (reconcile) throw new Error("Recovery effect has never been attempted");
      await client.query(`INSERT INTO codeops.retained_source_effects
        (recovery_id,step,effect_id,request_json,state,attempted_at)
        VALUES($1,$2,$3,$4::jsonb,'attempting',clock_timestamp())`,
      [evidence.recoveryId, step, request.operationId, canonicalJsonText(request)]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

  // The attempt is durable before the provider is called. A crash never grants
  // retry permission. Only the existing adapter's exact observation can resolve it.
  let state = "unknown";
  let result: GitHubMutationResult | null = null;
  try {
    if (reconcile) {
      const observation = githubMutationReconciliationResultSchema.parse(
        await input.reconcile(request!, attemptedAt!));
      state = observation.state;
      result = observation.result;
    } else {
      result = githubMutationResultSchema.parse(await input.mutate(request!));
      state = "succeeded";
    }
    if (result !== null && (result.operationId !== request!.operationId ||
        result.repository !== request!.input.repository ||
        result.version !== (step === "branch" ? "codeops.github-branch-publish-result/v1" :
          "codeops.github-pull-request-create-result/v1"))) {
      throw new Error("Recovery provider result identity changed");
    }
  } catch {
    state = "unknown"; result = null;
  }
  const writer = await input.connect();
  try {
    await writer.query(`UPDATE codeops.retained_source_effects SET state=$3,result_json=$4::jsonb
      WHERE recovery_id=$1 AND step=$2 AND state IN ('attempting','unknown')`,
    [evidence.recoveryId, step, state, result === null ? null : canonicalJsonText(result)]);
    const stored = (await writer.query<EffectRow>(`SELECT request_json,state,attempted_at,result_json
      FROM codeops.retained_source_effects WHERE recovery_id=$1 AND step=$2`,
    [evidence.recoveryId, step])).rows[0];
    if (!stored || canonicalJsonText(stored.request_json) !== canonicalJsonText(request)) {
      throw new Error("Recovery effect durable readback changed");
    }
    state = stored.state;
    result = stored.result_json === null ? null : githubMutationResultSchema.parse(stored.result_json);
  } finally { writer.release(); }
  return { status: state === "unknown" ? 202 : 200,
    body: { recoveryId: evidence.recoveryId, effectId: request!.operationId,
      origin: "retained-source", state, result } };
}

export async function loadRecoveredBranchCandidate(client: TransactionClient,
  request: Extract<GitHubMutationProviderRequest, { operation: "branch_publish" }>) {
  const row = (await client.query<RecoveryRow>(`SELECT recovery.evidence_digest,recovery.evidence_json
    FROM codeops.retained_source_recoveries recovery
    JOIN codeops.retained_source_effects effect USING(recovery_id)
    WHERE recovery.recovery_id=$1 AND effect.effect_id=$2 AND effect.request_json=$3::jsonb`,
  [request.provenance.sourceRecoveryId, request.operationId, canonicalJsonText(request)])).rows[0];
  const evidence = evidenceSchema.parse(row?.evidence_json);
  if (sha256CanonicalJsonDigest(evidence) !== row?.evidence_digest ||
      evidence.candidateDigest !== sha256CanonicalJsonDigest(evidence.candidate) ||
      evidence.candidateDigest !== request.input.candidate.digest) {
    throw new Error("Recovered publication candidate provenance changed");
  }
  return evidence.candidate;
}
