import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  canonicalJsonText,
  admittedChildMaterializationInputSchema,
  runtimeLaunchBindingSchema,
  runtimeRequirementsSchema,
  SESSION_BROKER_VERSION,
  projectSessionBudgetV2,
  sessionEventSchema,
  sessionJobAdmittedInitializationRequestSchema,
  sessionJobBoundInitializationRequestSchema,
  sessionJobInitializationRequestSchema,
  sessionJobInitializationResponseSchema,
  sessionSnapshotSchema,
  sha256CanonicalJsonDigest,
  type SessionJobInitializationResponse,
  type SessionSnapshot,
  type RuntimeLaunchBinding,
  type RuntimeRequirements,
} from "@codeops/codeops-contracts";
import { verifyWorkspaceContextAttachments, workspaceContextAttachmentDescriptors } from
  "@codeops/codeops-contracts/workspace-context-node";
import { authenticateBearer } from "./bearer-auth.js";
import type { TransactionClient } from "./session-broker-repository.js";
import { sessionCapabilitiesFor } from "./session-broker-transitions.js";

interface StoredSessionRow extends Record<string, unknown> {
  readonly snapshot_json: unknown;
  readonly owner_principal_id: unknown;
  readonly runtime_requirements_json: unknown;
  readonly runtime_requirement_digest: unknown;
  readonly runtime_launch_binding_json: unknown;
  readonly legacy_runtime_worker_compatible: unknown;
}

interface WorkspaceRuntimeOwnerRow extends Record<string, unknown> {
  readonly state: unknown;
  readonly runtime_requirements_json: unknown;
  readonly runtime_requirement_digest: unknown;
  readonly runtime_launch_binding_json: unknown;
  readonly legacy_runtime_compatible: unknown;
}

export interface SessionRuntimeOwnerBinding {
  readonly requirements: RuntimeRequirements;
  readonly launchBinding: RuntimeLaunchBinding;
}

function assertRequestedRuntimeIdentity(
  request: ReturnType<typeof sessionJobInitializationRequestSchema.parse>,
  binding: RuntimeLaunchBinding,
  allowTupleless = false,
): void {
  const supplied = request.runtimeProfileId !== undefined;
  if (!supplied) {
    if (allowTupleless) return;
    throw new Error("session Job runtime identity is required");
  }
  if (
    request.runtimeProfileId !== binding.profile.profileId ||
    request.runtimeReleaseDigest !== binding.profile.releaseDigest ||
    request.runtimeCapabilityDigest !== binding.profile.capabilityDigest ||
    request.runtimeProfile === undefined ||
    canonicalJsonText(request.runtimeProfile) !== canonicalJsonText(binding.profile)
  ) {
    throw new Error("session Job runtime identity does not match its durable owner");
  }
}

function durableRuntimeOwner(
  requirementsValue: unknown,
  requirementDigest: unknown,
  bindingValue: unknown,
): SessionRuntimeOwnerBinding {
  const requirements = runtimeRequirementsSchema.parse(requirementsValue);
  const launchBinding = runtimeLaunchBindingSchema.parse(bindingValue);
  if (
    requirementDigest !== launchBinding.requirementDigest ||
    launchBinding.requirementDigest !== sha256CanonicalJsonDigest(requirements)
  ) {
    throw new Error("durable runtime owner evidence is invalid");
  }
  return { requirements, launchBinding };
}

function eventId(body: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

function sameRootIdentity(
  existing: SessionSnapshot,
  proposed: SessionSnapshot,
): boolean {
  return (
    existing.sessionId === proposed.sessionId &&
    canonicalJsonText(existing.identity) === canonicalJsonText(proposed.identity)
  );
}

async function ensureSessionModelBudget(
  client: TransactionClient,
  snapshot: SessionSnapshot,
): Promise<void> {
  const budget = snapshot.budget;
  if (budget == null || budget.version !== "codeops.session-budget/v2") {
    throw new Error("session Job budget must use version 2");
  }
  await client.query(
    `INSERT INTO codeops.session_model_budgets (
       session_id, budget_id, started_at, provider_requests_limit,
       output_tokens_limit, committed_provider_requests,
       settled_output_tokens, reserved_output_tokens,
       observed_input_tokens, observed_total_tokens, revision, updated_at
     ) VALUES (
       $1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11,
       $12::timestamptz
     )
     ON CONFLICT (session_id) DO NOTHING`,
    [
      snapshot.sessionId,
      budget.budgetId,
      budget.startedAt,
      budget.limits.providerRequests,
      budget.limits.outputTokens,
      budget.usage.providerRequests,
      budget.usage.outputTokens,
      budget.reserved.outputTokens,
      budget.usage.observedInputTokens,
      budget.usage.observedTotalTokens,
      budget.revision,
      budget.observedAt,
    ],
  );
}

export async function initializeSessionFromJob(
  client: TransactionClient,
  input: {
    readonly request: unknown;
    readonly runtimeOwner?: SessionRuntimeOwnerBinding;
    readonly now?: () => Date;
    readonly leaseMs?: number;
  },
): Promise<SessionJobInitializationResponse> {
  const request = sessionJobInitializationRequestSchema.parse(input.request);
  const configuredOwner = input.runtimeOwner === undefined
    ? undefined
    : {
        requirements: runtimeRequirementsSchema.parse(input.runtimeOwner.requirements),
        launchBinding: runtimeLaunchBindingSchema.parse(input.runtimeOwner.launchBinding),
      };
  if (configuredOwner !== undefined) {
    durableRuntimeOwner(
      configuredOwner.requirements,
      configuredOwner.launchBinding.requirementDigest,
      configuredOwner.launchBinding,
    );
  }
  const now = (input.now ?? (() => new Date()))();
  const leaseMs = input.leaseMs ?? 60 * 60_000;
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 60_000 ||
    leaseMs > 24 * 60 * 60_000
  ) {
    throw new Error("session Job lease must be between one minute and 24 hours");
  }
  const initializedAt = now.toISOString();
  const proposed = sessionSnapshotSchema.parse({
    version: SESSION_BROKER_VERSION.snapshot,
    sessionId: request.sessionId,
    generation: 1,
    state: "running",
    identity: request.identity,
    lease: {
      leaseId: request.leaseId,
      generation: 1,
      status: "active",
      holderId: request.holderId,
      acquiredAt: initializedAt,
      expiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    },
    checkpoint: null,
    pendingPermission: null,
    budget: projectSessionBudgetV2({
      budgetId: request.sessionId,
      revision: 1,
      startedAt: initializedAt,
      observedAt: initializedAt,
    }),
    eventCursor: 1,
    capabilities: sessionCapabilitiesFor("running", false),
    updatedAt: initializedAt,
  });
  const eventBody = {
    sessionId: proposed.sessionId,
    generation: 1,
    cursor: 1,
    type: "session_created",
    occurredAt: initializedAt,
  } as const;
  const event = sessionEventSchema.parse({
    version: SESSION_BROKER_VERSION.event,
    eventId: eventId(eventBody),
    ...eventBody,
  });

  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const workspaceOwner = await client.query<WorkspaceRuntimeOwnerRow>(
      `SELECT state, runtime_requirements_json, runtime_requirement_digest,
              runtime_launch_binding_json, legacy_runtime_compatible
         FROM codeops.workspace_launches
        WHERE launch_id = $1
        FOR UPDATE`,
      [request.identity.runId],
    );
    if (workspaceOwner.rows.length > 1) {
      throw new Error("session Job resolved more than one workspace runtime owner");
    }
    const workspaceRow = workspaceOwner.rows[0];
    const workspaceIsBound = workspaceRow?.runtime_launch_binding_json != null;
    const workspaceCanOwnBinding = workspaceRow?.state === "queued" ||
      workspaceRow?.state === "provisioning";
    const selectedOwner = workspaceIsBound
      ? durableRuntimeOwner(
          workspaceRow.runtime_requirements_json,
          workspaceRow.runtime_requirement_digest,
          workspaceRow.runtime_launch_binding_json,
        )
      : workspaceCanOwnBinding ? undefined : configuredOwner;
    if (selectedOwner === undefined) {
      throw new Error("session Job has no durable runtime owner");
    }
    if (workspaceRow !== undefined && !workspaceIsBound &&
        workspaceRow.legacy_runtime_compatible !== true) {
      throw new Error("workspace session has no complete runtime launch binding");
    }
    const inserted = await client.query(
      `INSERT INTO codeops.sessions
         (session_id, generation, lease_id, snapshot_json, updated_at,
          owner_principal_id, runtime_requirements_json,
          runtime_requirement_digest, runtime_launch_binding_json)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6,
               $7::jsonb, $8, $9::jsonb)
       ON CONFLICT (session_id) DO NOTHING`,
      [
        proposed.sessionId,
        proposed.generation,
        proposed.lease!.leaseId,
        canonicalJsonText(proposed),
        proposed.updatedAt,
        request.ownerPrincipalId,
        workspaceIsBound ? null : canonicalJsonText(selectedOwner.requirements),
        workspaceIsBound ? null : selectedOwner.launchBinding.requirementDigest,
        workspaceIsBound ? null : canonicalJsonText(selectedOwner.launchBinding),
      ],
    );
    if (inserted.rowCount === 1) {
      if (workspaceRow !== undefined && !workspaceIsBound) {
        throw new Error("new workspace session requires a complete runtime launch binding");
      }
      assertRequestedRuntimeIdentity(request, selectedOwner.launchBinding);
      await ensureSessionModelBudget(client, proposed);
      await client.query(
        `INSERT INTO codeops.session_events
           (event_id, session_id, generation, cursor, event_type, event_json,
            command_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, $7::timestamptz)`,
        [
          event.eventId,
          event.sessionId,
          event.generation,
          event.cursor,
          event.type,
          canonicalJsonText(event),
          event.occurredAt,
        ],
      );
      await client.query("COMMIT");
      return sessionJobInitializationResponseSchema.parse({
        version: "codeops.session-job-initialization-result/v1",
        disposition: "created",
        snapshot: proposed,
      });
    }

    const stored = await client.query<StoredSessionRow>(
      `SELECT snapshot_json, owner_principal_id, runtime_requirements_json,
              runtime_requirement_digest, runtime_launch_binding_json,
              legacy_runtime_worker_compatible
         FROM codeops.sessions
        WHERE session_id = $1
        FOR UPDATE`,
      [request.sessionId],
    );
    const existing = sessionSnapshotSchema.parse(stored.rows[0]?.snapshot_json);
    if (
      !sameRootIdentity(existing, proposed) ||
      stored.rows[0]?.owner_principal_id !== request.ownerPrincipalId
    ) {
      throw new Error(
        `session ${request.sessionId} already belongs to a different Job identity`,
      );
    }
    if (workspaceIsBound &&
        stored.rows[0]?.runtime_launch_binding_json != null) {
      throw new Error("session Job resolved ambiguous durable runtime owners");
    }
    let storedOwner: SessionRuntimeOwnerBinding;
    if (workspaceIsBound) {
      storedOwner = selectedOwner;
    } else if (stored.rows[0]?.runtime_launch_binding_json != null) {
      storedOwner = durableRuntimeOwner(
        stored.rows[0].runtime_requirements_json,
        stored.rows[0].runtime_requirement_digest,
        stored.rows[0].runtime_launch_binding_json,
      );
    } else if (
      stored.rows[0]?.legacy_runtime_worker_compatible === true &&
      configuredOwner !== undefined
    ) {
      storedOwner = configuredOwner;
      await client.query(
        `UPDATE codeops.sessions
            SET runtime_requirements_json = $2::jsonb,
                runtime_requirement_digest = $3,
                runtime_launch_binding_json = $4::jsonb
          WHERE session_id = $1`,
        [
          existing.sessionId,
          canonicalJsonText(storedOwner.requirements),
          storedOwner.launchBinding.requirementDigest,
          canonicalJsonText(storedOwner.launchBinding),
        ],
      );
    } else {
      throw new Error("session Job has no durable runtime owner");
    }
    assertRequestedRuntimeIdentity(
      request,
      storedOwner.launchBinding,
      stored.rows[0]?.legacy_runtime_worker_compatible === true,
    );
    await ensureSessionModelBudget(client, existing);
    await client.query("COMMIT");
    return sessionJobInitializationResponseSchema.parse({
      version: "codeops.session-job-initialization-result/v1",
      disposition: "duplicate",
      snapshot: existing,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function initializeAdmittedChildSessionFromJob(
  client: TransactionClient,
  input: { readonly request: unknown; readonly now?: () => Date },
): Promise<SessionJobInitializationResponse> {
  const request = sessionJobAdmittedInitializationRequestSchema.parse(input.request);
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const result = await client.query<StoredSessionRow & {
      input_json: unknown; input_digest: unknown; state: unknown;
      authority_current: unknown; initial_dispatch_digest: unknown;
    }>(`SELECT materialization.input_json,materialization.input_digest,
        materialization.initial_dispatch_digest,materialization.state,
        session.snapshot_json,session.owner_principal_id,
        (admission.authority_digest=materialization.admission_digest AND
         approval.authority_digest=materialization.approval_digest AND
         dispatch.session_id=materialization.child_session_id AND
         dispatch.principal_id=materialization.principal_id AND
         dispatch.admission_id=materialization.admission_id AND
         dispatch.dispatch_digest=materialization.initial_dispatch_digest AND
         dispatch.dispatch_json=materialization.input_json->'initialDispatch' AND
         session.generation=materialization.generation AND
         session.lease_id=materialization.lease_id AND
         session.snapshot_json->>'state' IN ('running','waiting_permission','checkpointing') AND
         session.snapshot_json->'lease'->>'status'='active' AND
         session.snapshot_json->'lease'->>'leaseId'=materialization.lease_id::text AND
         (session.snapshot_json->'lease'->>'generation')::bigint=materialization.generation AND
         session.snapshot_json->'lease'->>'holderId'=materialization.input_json#>>'{lease,holderId}' AND
         (session.snapshot_json->'lease'->>'expiresAt')::timestamptz=
           (materialization.input_json#>>'{lease,expiresAt}')::timestamptz AND
         CURRENT_TIMESTAMP < (session.snapshot_json->'lease'->>'expiresAt')::timestamptz)
          AS authority_current
      FROM codeops.admitted_child_materializations materialization
      JOIN codeops.work_item_admissions admission ON admission.admission_id=materialization.admission_id
      JOIN codeops.project_plan_approvals approval ON approval.approval_id=materialization.approval_id
      JOIN codeops.sessions session ON session.session_id=materialization.child_session_id
      JOIN codeops.session_runtime_outbox dispatch ON dispatch.dispatch_id=materialization.child_dispatch_id
      WHERE materialization.admission_id=$1 AND materialization.child_session_id=$2
      FOR SHARE OF materialization,admission,approval,session,dispatch`,
      [request.admissionId, request.sessionId]);
    if (result.rowCount !== 1) throw new Error("admitted child initialization authority is missing");
    const row = result.rows[0]!;
    const materialization = admittedChildMaterializationInputSchema.parse(row.input_json);
    const snapshot = sessionSnapshotSchema.parse(row.snapshot_json);
    const digest = `sha256:${createHash("sha256").update(canonicalJsonText(materialization)).digest("hex")}`;
    const initialDispatchDigest = `sha256:${createHash("sha256")
      .update(canonicalJsonText(materialization.initialDispatch)).digest("hex")}`;
    const attachments = verifyWorkspaceContextAttachments(materialization.contextAttachments);
    const exact = (left: unknown, right: unknown) => canonicalJsonText(left) === canonicalJsonText(right);
    if ((row.state !== "runtime-authorized" && row.state !== "success-finalizing" &&
          row.state !== "ready") ||
        row.authority_current !== true ||
        row.input_digest !== digest || request.inputDigest !== digest ||
        row.initial_dispatch_digest !== initialDispatchDigest ||
        request.approvalId !== materialization.approvalId ||
        request.dispatchId !== materialization.childDispatchId ||
        request.generation !== materialization.generation ||
        request.leaseId !== materialization.lease.leaseId ||
        request.holderId !== materialization.lease.holderId ||
        request.ownerPrincipalId !== materialization.principalId ||
        request.parentSessionId !== materialization.parentSessionId ||
        request.repository !== materialization.workItem.repository ||
        request.sourceSha !== materialization.workItem.sourceSha ||
        request.workItemId !== materialization.workItem.workItemId ||
        request.profile !== materialization.profile || request.release !== materialization.release ||
        !exact(request.images, materialization.images) ||
        !exact(request.identity, snapshot.identity) ||
        !exact(request.identity.policy, materialization.policy) ||
        request.identity.workflowId !== materialization.workflowId ||
        request.identity.runId !== materialization.runId ||
        !exact(workspaceContextAttachmentDescriptors(attachments), request.identity.contextAttachments) ||
        snapshot.sessionId !== materialization.childSessionId ||
        snapshot.generation !== materialization.generation ||
        snapshot.lease?.status !== "active" || snapshot.lease.leaseId !== materialization.lease.leaseId ||
        snapshot.lease.generation !== materialization.generation ||
        snapshot.lease.holderId !== materialization.lease.holderId ||
        snapshot.lease.expiresAt !== materialization.lease.expiresAt ||
        row.owner_principal_id !== materialization.principalId ||
        (input.now ?? (() => new Date()))().getTime() >= Date.parse(materialization.lease.expiresAt)) {
      throw new Error("admitted child initialization authority drifted");
    }
    await ensureSessionModelBudget(client, snapshot);
    await client.query("COMMIT");
    return sessionJobInitializationResponseSchema.parse({
      version: "codeops.session-job-initialization-result/v1",
      disposition: "duplicate", snapshot, contextAttachments: attachments,
      initialDispatchDigest,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export class InvalidSessionJobInitializationRequestError extends Error {}

export async function serveSessionJobInitialization(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly readBody: () => Promise<unknown>;
  readonly initialize: (request: unknown) => Promise<SessionJobInitializationResponse>;
}): Promise<{
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
} | null> {
  const legacyBoundary = input.url === "/v1/session-jobs/initializations";
  const boundBoundary = input.url === "/v2/session-jobs/initializations";
  if (
    input.method !== "POST" ||
    (!legacyBoundary && !boundBoundary)
  ) {
    return null;
  }
  const authorization =
    typeof input.headers.authorization === "string"
      ? input.headers.authorization
      : undefined;
  if (!authenticateBearer(authorization, input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      typeof input.headers["content-type"] === "string"
        ? input.headers["content-type"]
        : "",
    )
  ) {
    throw new InvalidSessionJobInitializationRequestError(
      "session Job initialization content type must be application/json",
    );
  }
  let request: unknown;
  try {
    const body = await input.readBody();
    request = boundBoundary
      ? sessionJobBoundInitializationRequestSchema.parse(body)
      : sessionJobInitializationRequestSchema.parse(body);
    if (legacyBoundary &&
        (request as { readonly version?: unknown }).version ===
          "codeops.session-job-initialization/v3") {
      throw new Error("bound initialization requires version 2 boundary");
    }
  } catch {
    throw new InvalidSessionJobInitializationRequestError(
      "session Job initialization body is invalid",
    );
  }
  return { status: 200, body: await input.initialize(request) };
}
