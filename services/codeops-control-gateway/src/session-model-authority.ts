import type { SessionSnapshot } from "@codeops/codeops-contracts";
import { createModelProxyToken } from "@codeops/codeops-contracts/model-proxy";

export interface SessionModelAuthorityInput {
  readonly snapshot: SessionSnapshot;
  readonly signingKey: string;
  readonly issuedAt: Date;
}

export type SessionModelAuthorityResult =
  | { readonly disposition: "disabled" }
  | { readonly disposition: "issued"; readonly modelProxyToken: string };

export class MissingSessionModelBudgetError extends Error {}

export class ExhaustedSessionModelBudgetError extends Error {}

export function issueSessionModelAuthority(
  input: SessionModelAuthorityInput,
): SessionModelAuthorityResult {
  const modelPolicy =
    "version" in input.snapshot.identity
      ? input.snapshot.identity.policy.modelPolicy
      : {
          provider: "openai" as const,
          model: "gpt-5.6-sol" as const,
          reasoningEffort: "high" as const,
        };
  if (modelPolicy.provider === "none") {
    return { disposition: "disabled" };
  }

  const budget = input.snapshot.budget;
  if (budget === undefined) {
    throw new MissingSessionModelBudgetError(
      "enabled session model authority requires a budget",
    );
  }
  const maximumRequests = budget.remaining.modelRequests;
  const maximumOutputTokens = Math.min(
    32_768,
    budget.remaining.totalTokens,
  );
  if (maximumRequests === 0 || maximumOutputTokens === 0) {
    throw new ExhaustedSessionModelBudgetError(
      "enabled session model authority budget is exhausted",
    );
  }

  return {
    disposition: "issued",
    modelProxyToken: createModelProxyToken({
      subject: input.snapshot.sessionId,
      signingKey: input.signingKey,
      model: modelPolicy.model,
      reasoningEffort: modelPolicy.reasoningEffort,
      maximumRequests,
      maximumOutputTokens,
      issuedAt: input.issuedAt,
    }),
  };
}
