import {
  canonicalJsonText,
  type SessionSnapshot,
} from "@codeops/codeops-contracts";
import { createClaimedDispatchModelProxyToken } from "@codeops/codeops-contracts/model-proxy";
import {
  loadClaimedDispatchAuthority,
  ClaimedDispatchAuthorityConflictError,
} from "./claimed-dispatch-authority.js";
import { runtimeProfileModel } from "./runtime-profile-registry.js";
import {
  loadSessionSnapshot,
  type TransactionClient,
} from "./session-broker-repository.js";

export interface SessionModelAuthorityInput {
  readonly snapshot: SessionSnapshot;
  readonly signingKey: string;
  readonly issuedAt: Date;
  readonly dispatchId: string;
  readonly claimCount: number;
}

export type SessionModelAuthorityResult =
  | { readonly disposition: "disabled" }
  | {
      readonly disposition: "issued";
      readonly modelProxyToken: string;
      readonly expiresAt: string;
    };

export class MissingSessionModelBudgetError extends Error {}

export class ExhaustedSessionModelBudgetError extends Error {}
export class RevokedSessionModelAuthorityError extends Error {}

export function issueSessionModelAuthority(
  input: SessionModelAuthorityInput,
): SessionModelAuthorityResult {
  const modelPolicy =
    "version" in input.snapshot.identity &&
      input.snapshot.identity.version === "codeops.session-workspace-identity/v1"
      ? input.snapshot.identity.policy.modelPolicy
      : {
          provider: "openai" as const,
          model: "gpt-5.6-sol" as const,
          reasoningEffort: "high" as const,
        };
  if (modelPolicy.provider === "none") {
    return { disposition: "disabled" };
  }

  const lease = input.snapshot.lease;
  if (
    lease?.status !== "active" ||
    lease.generation !== input.snapshot.generation
  ) {
    throw new RevokedSessionModelAuthorityError(
      "session model authority requires the exact active lease",
    );
  }

  const budget = input.snapshot.budget;
  if (budget === undefined) {
    throw new MissingSessionModelBudgetError(
      "enabled session model authority requires a budget",
    );
  }
  const maximumRequests = budget.version === "codeops.session-budget/v2"
    ? budget.remaining.providerRequests
    : budget.remaining.modelRequests;
  const maximumOutputTokens = Math.min(
    32_768,
    budget.version === "codeops.session-budget/v2"
      ? budget.remaining.outputTokens
      : budget.remaining.totalTokens,
  );
  if (
    maximumRequests === 0 ||
    maximumOutputTokens === 0 ||
    budget.usage.elapsedSeconds >= budget.limits.elapsedSeconds
  ) {
    throw new ExhaustedSessionModelBudgetError(
      "enabled session model authority budget is exhausted",
    );
  }
  const expiryMilliseconds = Math.min(
    input.issuedAt.getTime() + 75 * 60_000,
    Date.parse(lease.expiresAt),
  );
  if (
    !Number.isFinite(expiryMilliseconds) ||
    Math.floor(expiryMilliseconds / 1_000) <=
      Math.floor(input.issuedAt.getTime() / 1_000)
  ) {
    throw new RevokedSessionModelAuthorityError(
      "session model authority expires with its active claim and lease",
    );
  }
  const expiresAt = new Date(Math.floor(expiryMilliseconds / 1_000) * 1_000);

  return {
    disposition: "issued",
    expiresAt: expiresAt.toISOString(),
    modelProxyToken: createClaimedDispatchModelProxyToken({
      subject: input.snapshot.sessionId,
      budgetId: budget.version === "codeops.session-budget/v2"
        ? budget.budgetId
        : input.snapshot.sessionId,
      generation: input.snapshot.generation,
      leaseId: lease.leaseId,
      dispatchId: input.dispatchId,
      claimCount: input.claimCount,
      expiresAt,
      signingKey: input.signingKey,
      model: modelPolicy.model,
      reasoningEffort: modelPolicy.reasoningEffort,
      maximumRequests,
      maximumOutputTokens,
      issuedAt: input.issuedAt,
    }),
  };
}

export async function issueClaimedSessionModelAuthority(
  client: TransactionClient,
  input: {
    readonly dispatchId: string;
    readonly workerId: string;
    readonly claimToken: string;
    readonly signingKey: string;
    readonly now?: () => Date;
  },
): Promise<Extract<SessionModelAuthorityResult, { disposition: "issued" }>> {
  const now = input.now ?? (() => new Date());
  const issuedAt = now();
  const authority = await loadClaimedDispatchAuthority(client, {
    dispatchId: input.dispatchId,
    workerId: input.workerId,
    claimToken: input.claimToken,
    now: () => issuedAt,
    requireClaimCount: true,
  });
  if (!(["prompt", "resume"] as const).includes(
    authority.dispatch.command.type as "prompt" | "resume",
  )) {
    throw new ClaimedDispatchAuthorityConflictError(
      "model authority belongs only to a claimed prompt or resume dispatch",
    );
  }
  const claimedModel = authority.runtimeBinding === undefined
    ? "gpt-5.6-sol"
    : runtimeProfileModel(authority.runtimeBinding.selectedProfile);
  const dispatchedPolicy = "version" in authority.snapshot.identity &&
      authority.snapshot.identity.version === "codeops.session-workspace-identity/v1"
    ? authority.snapshot.identity.policy.modelPolicy
    : { provider: "openai" as const, model: "gpt-5.6-sol" as const };
  if (dispatchedPolicy?.provider !== "openai" ||
      dispatchedPolicy.model !== claimedModel) {
    throw new ClaimedDispatchAuthorityConflictError(
      "model authority does not match the signed runtime profile",
    );
  }
  const snapshot = await loadSessionSnapshot(
    client,
    authority.dispatch.command.sessionId,
  );
  if (
    snapshot === null ||
    snapshot.sessionId !== authority.snapshot.sessionId ||
    snapshot.generation !== authority.snapshot.generation ||
    snapshot.lease?.status !== "active" ||
    snapshot.lease.leaseId !== authority.dispatch.command.leaseId ||
    canonicalJsonText(snapshot.identity) !==
      canonicalJsonText(authority.snapshot.identity)
  ) {
    throw new RevokedSessionModelAuthorityError(
      "claimed dispatch model authority is stale or revoked",
    );
  }
  const result = issueSessionModelAuthority({
    snapshot,
    signingKey: input.signingKey,
    issuedAt,
    dispatchId: authority.dispatch.dispatchId,
    claimCount: authority.claimCount!,
  });
  if (result.disposition === "disabled") {
    throw new RevokedSessionModelAuthorityError(
      "claimed dispatch model authority is disabled",
    );
  }
  return result;
}
