import { createHash } from "node:crypto";
import {
  canonicalJsonText,
  githubBranchPublishCandidateChunkRequestSchema,
  githubBranchPublishCandidateManifestRequestSchema,
  githubBranchPublishCandidateSchema,
  type GitHubBranchPublishCandidate,
  type GitHubBranchPublishCandidateChunkRequest,
  type GitHubBranchPublishCandidateManifestRequest,
} from "@codeops/codeops-contracts";
import {
  loadClaimedDispatchAuthority,
  selectClaimedWorkspaceSource,
} from "./claimed-dispatch-authority.js";
import type { TransactionClient } from "./session-broker-repository.js";

export class GitHubBranchCandidateInvalidRequestError extends Error {}
export class GitHubBranchCandidateNotFoundError extends Error {}
export class GitHubBranchCandidateConflictError extends Error {}

interface ManifestRow extends Record<string, unknown> {
  readonly manifest_id: unknown;
  readonly candidate_digest: unknown;
  readonly candidate_bytes: unknown;
  readonly chunk_count: unknown;
  readonly dispatch_id: unknown;
  readonly session_id: unknown;
  readonly owner_principal_id: unknown;
  readonly repository: unknown;
  readonly operation: unknown;
  readonly operation_id: unknown;
  readonly effect_digest: unknown;
  readonly chunk_identities_json: unknown;
}

interface ChunkRow extends Record<string, unknown> {
  readonly ordinal: unknown;
  readonly chunk_digest: unknown;
  readonly chunk_bytes: unknown;
  readonly content: unknown;
}

type CandidateReference = GitHubBranchPublishCandidateManifestRequest["candidate"];
type ChunkIdentity = GitHubBranchPublishCandidateManifestRequest["chunks"][number];

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseChunkIdentities(value: unknown): readonly ChunkIdentity[] {
  if (!Array.isArray(value) || value.some((chunk, ordinal) =>
    typeof chunk !== "object" || chunk === null ||
    (chunk as { ordinal?: unknown }).ordinal !== ordinal ||
    !/^sha256:[0-9a-f]{64}$/.test(String((chunk as { digest?: unknown }).digest)) ||
    !Number.isInteger((chunk as { sizeBytes?: unknown }).sizeBytes) ||
    Number((chunk as { sizeBytes?: unknown }).sizeBytes) < 1 ||
    Number((chunk as { sizeBytes?: unknown }).sizeBytes) > 65_536
  )) throw new Error("GitHub branch candidate manifest identity is invalid");
  return value as unknown as readonly ChunkIdentity[];
}

function manifestIdentity(row: ManifestRow) {
  return {
    manifestId: String(row.manifest_id),
    candidate: {
      manifestId: String(row.manifest_id),
      digest: String(row.candidate_digest),
      sizeBytes: Number(row.candidate_bytes),
      chunkCount: Number(row.chunk_count),
    },
    dispatchId: String(row.dispatch_id),
    sessionId: String(row.session_id),
    ownerPrincipalId: String(row.owner_principal_id),
    repository: String(row.repository),
    operation: String(row.operation),
    operationId: String(row.operation_id),
    effectDigest: String(row.effect_digest),
    chunks: parseChunkIdentities(row.chunk_identities_json),
  };
}

function expectedManifestId(input: {
  readonly dispatchId: string;
  readonly sessionId: string;
  readonly ownerPrincipalId: string;
  readonly request: GitHubBranchPublishCandidateManifestRequest;
}): string {
  return `githubcandidate-${createHash("sha256").update(canonicalJsonText({
    version: "codeops.github-branch-publish-candidate-manifest/v1",
    dispatchId: input.dispatchId,
    sessionId: input.sessionId,
    ownerPrincipalId: input.ownerPrincipalId,
    repository: input.request.repository,
    operationId: input.request.operationId,
    effectDigest: input.request.effectDigest,
    candidate: {
      digest: input.request.candidate.digest,
      sizeBytes: input.request.candidate.sizeBytes,
      chunkCount: input.request.candidate.chunkCount,
    },
    chunks: input.request.chunks,
    operation: "branch_publish",
  })).digest("hex")}`;
}

async function insertManifest(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly sessionId: string;
    readonly ownerPrincipalId: string;
    readonly request: GitHubBranchPublishCandidateManifestRequest;
  },
): Promise<void> {
  const { request } = input;
  if (request.candidate.manifestId !== expectedManifestId(input)) {
    throw new GitHubBranchCandidateInvalidRequestError(
      "GitHub branch candidate manifest identity is invalid",
    );
  }
  const lockedDispatch = await client.query(
    `SELECT dispatch_id FROM codeops.session_runtime_outbox
      WHERE dispatch_id = $1 FOR UPDATE`,
    [input.dispatchId],
  );
  if (lockedDispatch.rows[0] === undefined) {
    throw new GitHubBranchCandidateNotFoundError(
      "GitHub branch candidate dispatch was not found",
    );
  }
  const aggregate = await client.query<{ readonly staged_bytes: unknown }>(
    `SELECT COALESCE(SUM(candidate_bytes), 0)::integer AS staged_bytes
       FROM codeops.github_branch_publish_candidate_manifests
      WHERE dispatch_id = $1 AND manifest_id <> $2`,
    [input.dispatchId, request.candidate.manifestId],
  );
  if (Number(aggregate.rows[0]?.staged_bytes ?? 0) + request.candidate.sizeBytes > 4_194_304) {
    throw new GitHubBranchCandidateInvalidRequestError(
      "GitHub branch candidate dispatch aggregate exceeds 4194304 bytes",
    );
  }
  await client.query(
    `INSERT INTO codeops.github_branch_publish_candidate_manifests(
       manifest_id, candidate_digest, candidate_bytes, chunk_count,
       dispatch_id, session_id, owner_principal_id, repository, operation,
       operation_id, effect_digest, chunk_identities_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'branch_publish',$9,$10,$11::jsonb)
     ON CONFLICT DO NOTHING`,
    [request.candidate.manifestId, request.candidate.digest,
      request.candidate.sizeBytes, request.candidate.chunkCount,
      input.dispatchId, input.sessionId, input.ownerPrincipalId,
      request.repository, request.operationId, request.effectDigest,
      canonicalJsonText(request.chunks)],
  );
  const stored = await client.query<ManifestRow>(
    `SELECT manifest_id, candidate_digest, candidate_bytes, chunk_count,
            dispatch_id, session_id, owner_principal_id, repository, operation,
            operation_id, effect_digest, chunk_identities_json
       FROM codeops.github_branch_publish_candidate_manifests
      WHERE manifest_id = $1
      FOR UPDATE`,
    [request.candidate.manifestId],
  );
  const row = stored.rows[0];
  const expected = {
    manifestId: request.candidate.manifestId,
    candidate: request.candidate,
    dispatchId: input.dispatchId,
    sessionId: input.sessionId,
    ownerPrincipalId: input.ownerPrincipalId,
    repository: request.repository,
    operation: "branch_publish",
    operationId: request.operationId,
    effectDigest: request.effectDigest,
    chunks: request.chunks,
  };
  if (row === undefined || canonicalJsonText(manifestIdentity(row)) !== canonicalJsonText(expected)) {
    throw new GitHubBranchCandidateConflictError(
      "GitHub branch candidate manifest conflicts with immutable identity",
    );
  }
}

export async function createGitHubBranchCandidateManifest(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
): Promise<void> {
  const request = githubBranchPublishCandidateManifestRequestSchema.parse(input.request);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const authority = await loadClaimedDispatchAuthority(client, {
      dispatchId: input.dispatchId, workerId: input.workerId,
      claimToken: request.claimToken, now: input.now,
    });
    selectClaimedWorkspaceSource(authority, { repository: request.repository });
    await insertManifest(client, {
      dispatchId: input.dispatchId,
      sessionId: authority.dispatch.command.sessionId,
      ownerPrincipalId: authority.dispatch.principalId,
      request,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function lockedManifest(
  client: TransactionClient,
  input: {
    readonly manifestId: string;
    readonly dispatchId: string;
    readonly operationId: string;
  },
): Promise<ReturnType<typeof manifestIdentity>> {
  const result = await client.query<ManifestRow>(
    `SELECT manifest_id, candidate_digest, candidate_bytes, chunk_count,
            dispatch_id, session_id, owner_principal_id, repository, operation,
            operation_id, effect_digest, chunk_identities_json
       FROM codeops.github_branch_publish_candidate_manifests
      WHERE manifest_id = $1 AND dispatch_id = $2 AND operation_id = $3
      FOR UPDATE`,
    [input.manifestId, input.dispatchId, input.operationId],
  );
  if (result.rows[0] === undefined) throw new GitHubBranchCandidateNotFoundError(
    "GitHub branch candidate manifest was not found",
  );
  return manifestIdentity(result.rows[0]);
}

export async function storeGitHubBranchCandidateChunk(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly request: unknown;
    readonly now?: () => Date;
  },
): Promise<void> {
  const request = githubBranchPublishCandidateChunkRequestSchema.parse(input.request);
  const bytes = Buffer.from(request.bytesBase64, "base64");
  if (bytes.length < 1 || bytes.length > 65_536 ||
      bytes.toString("base64") !== request.bytesBase64 || sha256(bytes) !== request.digest) {
    throw new GitHubBranchCandidateInvalidRequestError(
      "GitHub branch candidate chunk bytes are invalid",
    );
  }
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const authority = await loadClaimedDispatchAuthority(client, {
      dispatchId: input.dispatchId, workerId: input.workerId,
      claimToken: request.claimToken, now: input.now,
    });
    const manifest = await lockedManifest(client, {
      manifestId: request.manifestId,
      dispatchId: input.dispatchId,
      operationId: request.operationId,
    });
    selectClaimedWorkspaceSource(authority, { repository: manifest.repository });
    const expected = manifest.chunks[request.ordinal];
    if (expected === undefined || expected.ordinal !== request.ordinal ||
        expected.digest !== request.digest || expected.sizeBytes !== bytes.length) {
      throw new GitHubBranchCandidateInvalidRequestError(
        "GitHub branch candidate chunk identity is invalid",
      );
    }
    const existing = await client.query<ChunkRow>(
      `SELECT ordinal, chunk_digest, chunk_bytes, content
         FROM codeops.github_branch_publish_candidate_chunks
        WHERE manifest_id = $1 AND ordinal = $2`,
      [request.manifestId, request.ordinal],
    );
    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0];
      if (Number(row.ordinal) !== request.ordinal || String(row.chunk_digest) !== request.digest ||
          Number(row.chunk_bytes) !== bytes.length || !Buffer.from(row.content as Uint8Array).equals(bytes)) {
        throw new GitHubBranchCandidateConflictError(
          "GitHub branch candidate chunk conflicts with immutable identity",
        );
      }
    } else {
      const aggregate = await client.query<{ readonly staged_bytes: unknown }>(
        `SELECT COALESCE(SUM(chunk_bytes), 0)::integer AS staged_bytes
           FROM codeops.github_branch_publish_candidate_chunks
          WHERE dispatch_id = $1`,
        [input.dispatchId],
      );
      if (Number(aggregate.rows[0]?.staged_bytes ?? 0) + bytes.length > 4_194_304) {
        throw new GitHubBranchCandidateInvalidRequestError(
          "GitHub branch candidate staged bytes exceed the dispatch aggregate bound",
        );
      }
      await client.query(
        `INSERT INTO codeops.github_branch_publish_candidate_chunks(
           manifest_id, dispatch_id, operation_id, ordinal,
           chunk_digest, chunk_bytes, content)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [request.manifestId, input.dispatchId, request.operationId,
          request.ordinal, request.digest, bytes.length, bytes],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function lockGitHubBranchCandidateManifest(
  client: TransactionClient,
  input: {
    readonly manifestId: string;
    readonly dispatchId: string;
    readonly operationId: string;
    readonly repository: string;
    readonly sessionId: string;
    readonly ownerPrincipalId: string;
    readonly digest: string;
    readonly sizeBytes: number;
    readonly chunkCount: number;
  },
): Promise<{ readonly effectDigest: string }> {
  const manifest = await lockedManifest(client, input);
  const expected = {
    manifestId: input.manifestId, digest: input.digest,
    sizeBytes: input.sizeBytes, chunkCount: input.chunkCount,
  };
  if (manifest.repository !== input.repository || manifest.sessionId !== input.sessionId ||
      manifest.ownerPrincipalId !== input.ownerPrincipalId || manifest.operation !== "branch_publish" ||
      canonicalJsonText(manifest.candidate) !== canonicalJsonText(expected)) {
    throw new GitHubBranchCandidateConflictError(
      "GitHub branch candidate manifest authority is invalid",
    );
  }
  return { effectDigest: manifest.effectDigest };
}

export async function loadGitHubBranchCandidate(
  client: TransactionClient,
  input: {
    readonly manifestId: string;
    readonly dispatchId: string;
    readonly operationId: string;
    readonly effectDigest?: string;
    readonly lock?: boolean;
  },
): Promise<GitHubBranchPublishCandidate> {
  const result = await client.query<ManifestRow>(
    `SELECT manifest_id, candidate_digest, candidate_bytes, chunk_count,
            dispatch_id, session_id, owner_principal_id, repository, operation,
            operation_id, effect_digest, chunk_identities_json
       FROM codeops.github_branch_publish_candidate_manifests
      WHERE manifest_id = $1 AND dispatch_id = $2 AND operation_id = $3
      ${input.lock === false ? "" : "FOR UPDATE"}`,
    [input.manifestId, input.dispatchId, input.operationId],
  );
  if (result.rows[0] === undefined) throw new Error("GitHub branch candidate manifest was not found");
  const manifest = manifestIdentity(result.rows[0]);
  if (input.effectDigest !== undefined && manifest.effectDigest !== input.effectDigest) {
    throw new Error("GitHub branch candidate effect identity is invalid");
  }
  const chunks = await client.query<ChunkRow>(
    `SELECT ordinal, chunk_digest, chunk_bytes, content
       FROM codeops.github_branch_publish_candidate_chunks
      WHERE manifest_id = $1 AND dispatch_id = $2 AND operation_id = $3
      ORDER BY ordinal`,
    [input.manifestId, input.dispatchId, input.operationId],
  );
  if (chunks.rows.length !== manifest.candidate.chunkCount) {
    throw new Error("GitHub branch candidate is incomplete");
  }
  const buffers = chunks.rows.map((row, ordinal) => {
    const bytes = Buffer.from(row.content as Uint8Array);
    const expected = manifest.chunks[ordinal];
    if (Number(row.ordinal) !== ordinal || expected?.ordinal !== ordinal ||
        String(row.chunk_digest) !== expected.digest || Number(row.chunk_bytes) !== expected.sizeBytes ||
        bytes.length !== expected.sizeBytes || sha256(bytes) !== expected.digest) {
      throw new Error("GitHub branch candidate chunk identity is invalid");
    }
    return bytes;
  });
  const bytes = Buffer.concat(buffers);
  if (bytes.length !== manifest.candidate.sizeBytes || sha256(bytes) !== manifest.candidate.digest) {
    throw new Error("GitHub branch candidate aggregate identity is invalid");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("GitHub branch candidate content is invalid"); }
  return githubBranchPublishCandidateSchema.parse(decoded);
}

export async function stageLegacyGitHubBranchCandidate(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly sessionId: string;
    readonly ownerPrincipalId: string;
    readonly repository: string;
    readonly operationId: string;
    readonly logicalInput: { readonly changes: GitHubBranchPublishCandidate["changes"] };
  },
): Promise<CandidateReference> {
  const candidate = githubBranchPublishCandidateSchema.parse({
    version: "codeops.github-branch-publish-candidate/v1",
    changes: input.logicalInput.changes,
  });
  const bytes = Buffer.from(canonicalJsonText(candidate));
  const chunks = Array.from({ length: Math.ceil(bytes.length / 65_536) }, (_, ordinal) => {
    const content = bytes.subarray(ordinal * 65_536, (ordinal + 1) * 65_536);
    return { ordinal, digest: sha256(content), sizeBytes: content.length, content };
  });
  const candidateIdentity = {
    digest: sha256(bytes), sizeBytes: bytes.length, chunkCount: chunks.length,
  };
  const effectDigest = sha256(canonicalJsonText(input.logicalInput));
  const manifestSeed = {
    version: "codeops.github-branch-publish-candidate-manifest/v1",
    dispatchId: input.dispatchId, sessionId: input.sessionId,
    ownerPrincipalId: input.ownerPrincipalId, repository: input.repository,
    operationId: input.operationId, effectDigest,
    candidate: candidateIdentity,
    chunks: chunks.map(({ content: _content, ...identity }) => identity),
    operation: "branch_publish",
  };
  const candidateReference: CandidateReference = {
    manifestId: `githubcandidate-${createHash("sha256").update(canonicalJsonText(manifestSeed)).digest("hex")}`,
    ...candidateIdentity,
  };
  await insertManifest(client, {
    dispatchId: input.dispatchId, sessionId: input.sessionId,
    ownerPrincipalId: input.ownerPrincipalId,
    request: {
      version: "codeops.github-branch-publish-candidate-manifest-request/v1",
      claimToken: "00000000-0000-4000-8000-000000000000",
      operationId: input.operationId, effectDigest, repository: input.repository,
      candidate: candidateReference,
      chunks: chunks.map(({ content: _content, ...identity }) => identity),
    },
  });
  for (const chunk of chunks) {
    const existing = await client.query<ChunkRow>(
      `SELECT ordinal, chunk_digest, chunk_bytes, content
         FROM codeops.github_branch_publish_candidate_chunks
        WHERE manifest_id = $1 AND ordinal = $2`,
      [candidateReference.manifestId, chunk.ordinal],
    );
    if (existing.rows[0] === undefined) {
      await client.query(
        `INSERT INTO codeops.github_branch_publish_candidate_chunks(
           manifest_id, dispatch_id, operation_id, ordinal,
           chunk_digest, chunk_bytes, content)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [candidateReference.manifestId, input.dispatchId, input.operationId,
          chunk.ordinal, chunk.digest, chunk.sizeBytes, chunk.content],
      );
    }
  }
  return candidateReference;
}

export async function cleanupNoReceiptGitHubBranchCandidatesForDispatch(
  client: TransactionClient,
  dispatchId: string,
): Promise<void> {
  await client.query(
    `WITH locked AS (
       SELECT manifest.manifest_id
         FROM codeops.github_branch_publish_candidate_manifests AS manifest
        WHERE manifest.dispatch_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM codeops.provider_effect_receipts AS effect
             WHERE effect.effect_id = manifest.operation_id)
        FOR UPDATE OF manifest SKIP LOCKED
     )
     DELETE FROM codeops.github_branch_publish_candidate_manifests AS manifest
      USING locked
      WHERE manifest.manifest_id = locked.manifest_id`,
    [dispatchId],
  );
}

export async function cleanupDefinitiveGitHubBranchCandidateChunks(
  client: TransactionClient,
  operationId: string,
): Promise<void> {
  await client.query(
    `WITH locked AS (
       SELECT manifest.manifest_id
         FROM codeops.github_branch_publish_candidate_manifests AS manifest
         JOIN codeops.provider_effect_receipts AS effect
           ON effect.effect_id = manifest.operation_id
        WHERE manifest.operation_id = $1
          AND effect.state IN ('succeeded','failed','reconciled_satisfied',
            'reconciled_not_observed','operator_resolved')
        FOR UPDATE OF manifest SKIP LOCKED
     )
     DELETE FROM codeops.github_branch_publish_candidate_chunks AS chunk
      USING locked
      WHERE chunk.manifest_id = locked.manifest_id`,
    [operationId],
  );
}

export async function cleanupTerminalOrphanGitHubBranchCandidateChunks(
  client: TransactionClient,
): Promise<void> {
  await client.query(
    `WITH definitive_locked AS (
       SELECT manifest.manifest_id
         FROM codeops.github_branch_publish_candidate_manifests AS manifest
         JOIN codeops.provider_effect_receipts AS effect
           ON effect.effect_id = manifest.operation_id
        WHERE effect.state IN ('succeeded','failed','reconciled_satisfied',
          'reconciled_not_observed','operator_resolved')
          AND EXISTS (
            SELECT 1
              FROM codeops.github_branch_publish_candidate_chunks AS chunk
             WHERE chunk.manifest_id = manifest.manifest_id)
        ORDER BY manifest.created_at, manifest.manifest_id
        LIMIT 100
        FOR UPDATE OF manifest SKIP LOCKED
     ), deleted_chunks AS (
       DELETE FROM codeops.github_branch_publish_candidate_chunks AS chunk
        USING definitive_locked
        WHERE chunk.manifest_id = definitive_locked.manifest_id
     ), orphan_locked AS (
       SELECT manifest.manifest_id
         FROM codeops.github_branch_publish_candidate_manifests AS manifest
         JOIN codeops.session_runtime_outbox AS outbox
           ON outbox.dispatch_id = manifest.dispatch_id
        WHERE outbox.status = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM codeops.provider_effect_receipts AS effect
             WHERE effect.effect_id = manifest.operation_id)
        ORDER BY manifest.created_at, manifest.manifest_id
        LIMIT 100
        FOR UPDATE OF manifest SKIP LOCKED
     )
     DELETE FROM codeops.github_branch_publish_candidate_manifests AS manifest
      USING orphan_locked
      WHERE manifest.manifest_id = orphan_locked.manifest_id`,
  );
}
