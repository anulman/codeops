import {
  workspaceLaunchRequestSchema,
  workspaceLaunchDetailSchema,
  workspaceLaunchSchema,
  type WorkspaceLaunch,
  type WorkspaceLaunchDetail,
  type WorkspaceLaunchRequest,
} from "@codeops/codeops-contracts";
import { workspaceLaunchSessionId } from "@codeops/codeops-contracts/workspace-launch";
import type { TransactionClient } from "./session-broker-repository.js";
import type { WorkspaceLaunchStore } from "./workspace-launch.js";
import {
  WorkspaceLaunchConflictError,
  WorkspaceLaunchQuotaError,
} from "./workspace-launch.js";

interface LaunchRow extends Record<string, unknown> {
  readonly launch_json: unknown;
}

interface LaunchDetailRow extends LaunchRow {
  readonly request_json: unknown;
  readonly initial_prompt_committed: unknown;
}

interface RuntimeOwnerRow extends Record<string, unknown> {
  readonly runtime_launch_binding_json: unknown;
}

export function createPostgresWorkspaceLaunchStore(
  client: TransactionClient,
): WorkspaceLaunchStore {
  return {
    async findByIdempotencyKey(principalId, idempotencyKey) {
      const result = await client.query<LaunchRow>(
        `SELECT launch_json
           FROM codeops.workspace_launches
          WHERE principal_id = $1 AND idempotency_key = $2`,
        [principalId, idempotencyKey],
      );
      return result.rows[0]
        ? workspaceLaunchSchema.parse(result.rows[0].launch_json)
        : null;
    },
    async admit(input) {
      const launch = workspaceLaunchSchema.parse(input.launch);
      const request = workspaceLaunchRequestSchema.parse(input.request);
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('codeops.workspace-launch-admission', 0))",
        );
        const existing = await client.query<LaunchRow>(
          `SELECT launch_json
             FROM codeops.workspace_launches
            WHERE principal_id = $1 AND idempotency_key = $2
            FOR UPDATE`,
          [launch.principalId, launch.idempotencyKey],
        );
        if (existing.rows[0]) {
          const stored = workspaceLaunchSchema.parse(existing.rows[0].launch_json);
          if (stored.requestDigest !== launch.requestDigest) {
            throw new WorkspaceLaunchConflictError(
              "workspace launch idempotency conflict",
            );
          }
          await client.query("COMMIT");
          return stored;
        }
        const counts = await client.query<{
          readonly principal_count: unknown;
          readonly global_count: unknown;
        }>(
          `SELECT
             count(*) FILTER (WHERE principal_id = $1)::text AS principal_count,
             count(*)::text AS global_count
           FROM codeops.workspace_launches
          WHERE state IN ('queued', 'provisioning')`,
          [launch.principalId],
        );
        const principalCount = Number(counts.rows[0]?.principal_count);
        const globalCount = Number(counts.rows[0]?.global_count);
        if (
          !Number.isSafeInteger(principalCount) ||
          principalCount < 0 ||
          !Number.isSafeInteger(globalCount) ||
          globalCount < 0
        ) {
          throw new Error("workspace launch active count is invalid");
        }
        if (
          principalCount >= input.maximumActivePerPrincipal ||
          globalCount >= input.maximumActiveGlobal
        ) {
          throw new WorkspaceLaunchQuotaError("workspace launch quota exceeded");
        }
        const inserted = await client.query<LaunchRow>(
          `INSERT INTO codeops.workspace_launches
             (launch_id, principal_id, idempotency_key, request_digest,
              request_json, launch_json, state, created_at, updated_at,
              runtime_requirements_json, runtime_requirement_digest,
              runtime_launch_binding_json, legacy_runtime_compatible)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9,
                   $10::jsonb, $11, $12::jsonb, $13)
           RETURNING launch_json`,
          [
            launch.launchId,
            launch.principalId,
            launch.idempotencyKey,
            launch.requestDigest,
            JSON.stringify(request),
            JSON.stringify(launch),
            launch.state,
            launch.createdAt,
            launch.updatedAt,
            launch.runtimeRequirements === undefined
              ? null
              : JSON.stringify(launch.runtimeRequirements),
            launch.runtimeRequirementDigest ?? null,
            launch.runtimeLaunchBinding === undefined
              ? null
              : JSON.stringify(launch.runtimeLaunchBinding),
            launch.legacyRuntimeCompatible ?? false,
          ],
        );
        await client.query("COMMIT");
        return workspaceLaunchSchema.parse(inserted.rows[0]?.launch_json);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
}

export async function loadWorkspaceLaunchRequest(
  client: TransactionClient,
  launchId: string,
): Promise<{ readonly launch: WorkspaceLaunch; readonly request: WorkspaceLaunchRequest } | null> {
  const result = await client.query<LaunchRow & { readonly request_json: unknown }>(
    `SELECT launch_json, request_json
       FROM codeops.workspace_launches
      WHERE launch_id = $1`,
    [launchId],
  );
  const row = result.rows[0];
  return row
    ? {
        launch: workspaceLaunchSchema.parse(row.launch_json),
        request: workspaceLaunchRequestSchema.parse(row.request_json),
      }
    : null;
}

export async function loadWorkspaceLaunchDetailForPrincipal(
  client: TransactionClient,
  launchId: string,
  principalId: string,
): Promise<WorkspaceLaunchDetail | null> {
  const result = await client.query<LaunchDetailRow>(
    `SELECT launch.launch_json, launch.request_json,
            EXISTS (
              SELECT 1
                FROM codeops.session_commands AS command
               WHERE command.session_id = launch.launch_json->>'sessionId'
                 AND command.idempotency_key::text =
                     launch.launch_json->>'initialPromptCommandId'
            ) AS initial_prompt_committed
       FROM codeops.workspace_launches AS launch
      WHERE launch.launch_id = $1 AND launch.principal_id = $2`,
    [launchId, principalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const request = workspaceLaunchRequestSchema.parse(row.request_json);
  return workspaceLaunchDetailSchema.parse({
    version: "codeops.workspace-launch-detail/v1",
    launch: workspaceLaunchSchema.parse(row.launch_json),
    initialPrompt: request.prompt,
    initialPromptStatus: row.initial_prompt_committed === true
      ? "committed"
      : "accepted",
  });
}

export async function listActiveWorkspaceLaunchIds(
  client: TransactionClient,
  limit = 20,
): Promise<readonly string[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("workspace launch reconciliation limit is invalid");
  }
  const result = await client.query<{ readonly launch_id: unknown }>(
    `SELECT launch_id
      FROM codeops.workspace_launches
      WHERE state IN ('queued', 'provisioning')
        AND (
          launch_json->>'nextAttemptAt' IS NULL
          OR (launch_json->>'nextAttemptAt')::timestamptz <= clock_timestamp()
        )
      ORDER BY created_at ASC, launch_id ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(({ launch_id }) => {
    if (typeof launch_id !== "string") {
      throw new Error("workspace launch identity is invalid");
    }
    return launch_id;
  });
}

export async function updateWorkspaceLaunch(
  client: TransactionClient,
  launch: WorkspaceLaunch,
): Promise<WorkspaceLaunch> {
  const parsed = workspaceLaunchSchema.parse(launch);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const lockedLaunch = await client.query<RuntimeOwnerRow>(
      `SELECT runtime_launch_binding_json
         FROM codeops.workspace_launches
        WHERE launch_id = $1
        FOR UPDATE`,
      [parsed.launchId],
    );
    if (lockedLaunch.rows.length !== 1) {
      throw new Error("workspace launch transition lost its active state");
    }
    const lockedSession = await client.query<RuntimeOwnerRow>(
      `SELECT runtime_launch_binding_json
         FROM codeops.sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [workspaceLaunchSessionId(parsed.launchId)],
    );
    if (
      parsed.runtimeLaunchBinding !== undefined &&
      lockedSession.rows[0]?.runtime_launch_binding_json != null
    ) {
      throw new Error("workspace launch resolved an existing session runtime owner");
    }
    const result = await client.query<LaunchRow>(
      `UPDATE codeops.workspace_launches
        SET launch_json = $2::jsonb, state = $3, updated_at = $4,
            runtime_requirements_json = $5::jsonb,
            runtime_requirement_digest = $6,
            runtime_launch_binding_json = $7::jsonb,
            legacy_runtime_compatible = $8
      WHERE launch_id = $1 AND state IN ('queued', 'provisioning')
      RETURNING launch_json`,
      [
        parsed.launchId,
        JSON.stringify(parsed),
        parsed.state,
        parsed.updatedAt,
        parsed.runtimeRequirements === undefined
          ? null
          : JSON.stringify(parsed.runtimeRequirements),
        parsed.runtimeRequirementDigest ?? null,
        parsed.runtimeLaunchBinding === undefined
          ? null
          : JSON.stringify(parsed.runtimeLaunchBinding),
        parsed.legacyRuntimeCompatible ?? false,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error("workspace launch transition lost its active state");
    }
    await client.query("COMMIT");
    return workspaceLaunchSchema.parse(result.rows[0]?.launch_json);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
