import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface WorkspaceCheckpointArtifact {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly checkpointId: string;
  readonly kind: "source-patch" | "scratch-bundle";
  readonly catalogKey?: string;
  readonly digest: string;
  readonly content: Buffer;
}

export interface WorkspaceCheckpointArtifactStore {
  put(artifact: WorkspaceCheckpointArtifact): Promise<void>;
}

export interface WorkspaceCheckpointArtifactReader {
  get(artifactId: string): Promise<WorkspaceCheckpointArtifact | null>;
}

interface ArtifactRow {
  readonly artifact_id: unknown;
  readonly session_id: unknown;
  readonly generation: unknown;
  readonly checkpoint_id: unknown;
  readonly artifact_kind: unknown;
  readonly catalog_key: unknown;
  readonly artifact_digest: unknown;
  readonly artifact_bytes: unknown;
}

export class PostgresWorkspaceCheckpointArtifactStore
  implements WorkspaceCheckpointArtifactStore {
  readonly #database: Pool;

  constructor(database: Pool) {
    this.#database = database;
  }

  async put(artifact: WorkspaceCheckpointArtifact): Promise<void> {
    const expectedDigest = `sha256:${createHash("sha256")
      .update(artifact.content)
      .digest("hex")}`;
    if (artifact.digest !== expectedDigest) {
      throw new Error("workspace artifact digest does not match its content");
    }
    if (artifact.content.byteLength > 16_000_000) {
      throw new Error("workspace artifact exceeds 16000000 bytes");
    }
    const inserted = await this.#database.query<ArtifactRow>(
      `INSERT INTO codeops.workspace_checkpoint_artifacts
         (artifact_id, session_id, generation, checkpoint_id, artifact_kind,
          catalog_key, artifact_digest, artifact_bytes, artifact_content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (artifact_id) DO NOTHING
       RETURNING artifact_id, session_id, generation, checkpoint_id,
                 artifact_kind, catalog_key, artifact_digest, artifact_bytes`,
      [
        artifact.artifactId,
        artifact.sessionId,
        artifact.generation,
        artifact.checkpointId,
        artifact.kind,
        artifact.catalogKey ?? null,
        artifact.digest,
        artifact.content.byteLength,
        artifact.content,
      ],
    );
    const row = inserted.rows[0] ?? (
      await this.#database.query<ArtifactRow>(
        `SELECT artifact_id, session_id, generation, checkpoint_id,
                artifact_kind, catalog_key, artifact_digest, artifact_bytes
           FROM codeops.workspace_checkpoint_artifacts
          WHERE artifact_id = $1`,
        [artifact.artifactId],
      )
    ).rows[0];
    if (
      row?.artifact_id !== artifact.artifactId ||
      row.session_id !== artifact.sessionId ||
      Number(row.generation) !== artifact.generation ||
      row.checkpoint_id !== artifact.checkpointId ||
      row.artifact_kind !== artifact.kind ||
      row.catalog_key !== (artifact.catalogKey ?? null) ||
      row.artifact_digest !== artifact.digest ||
      Number(row.artifact_bytes) !== artifact.content.byteLength
    ) {
      throw new Error("workspace artifact identity conflicts with durable storage");
    }
  }
}
