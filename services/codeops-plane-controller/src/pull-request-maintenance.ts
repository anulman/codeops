export type ExactPullRequestPosition = Readonly<{
  repository: string;
  number: number;
  state: "open" | "closed" | "merged";
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string | null;
}>;

export type ExactPullRequestTarget = Readonly<{
  ref: string;
  sha: string;
}>;

export type PullRequestMaintenanceDecision =
  | Readonly<{ action: "current" }>
  | Readonly<{
      action: "rebase";
      expectedHeadSha: string;
      expectedBaseRef: string;
      expectedBaseSha: string;
      targetBaseRef: string;
      targetBaseSha: string;
      reason: "target-advanced" | "target-retarget-observed";
    }>
  | Readonly<{
      action: "retarget-and-rebase";
      expectedHeadSha: string;
      expectedBaseRef: string;
      expectedBaseSha: string;
      targetBaseRef: string;
      targetBaseSha: string;
      reason: "stack-parent-merged";
    }>
  | Readonly<{
      action: "requalify";
      expectedHeadSha: string;
      currentHeadSha: string;
      reason: "head-rewritten";
    }>
  | Readonly<{
      action: "attention";
      reason:
        | "binding-identity-drifted"
        | "pull-request-not-open"
        | "base-authority-unknown"
        | "live-base-ref-drifted"
        | "live-base-sha-drifted";
    }>;

/**
 * Compare durable reviewed authority, the current GitHub PR, and the exact
 * target selected from protected main or the dependency graph. This function
 * plans maintenance only. A separate permissioned provider effect must perform
 * any retarget or branch rewrite.
 */
export function evaluatePullRequestMaintenance(input: {
  binding: ExactPullRequestPosition;
  current: ExactPullRequestPosition;
  target: ExactPullRequestTarget;
  stackParentMerged: boolean;
}): PullRequestMaintenanceDecision {
  if (
    input.binding.repository !== input.current.repository ||
    input.binding.number !== input.current.number ||
    input.binding.headRef !== input.current.headRef
  ) {
    return { action: "attention", reason: "binding-identity-drifted" };
  }
  if (input.current.state !== "open") {
    return { action: "attention", reason: "pull-request-not-open" };
  }
  if (input.binding.baseSha === null) {
    return { action: "attention", reason: "base-authority-unknown" };
  }
  if (input.current.headSha !== input.binding.headSha) {
    return {
      action: "requalify",
      expectedHeadSha: input.binding.headSha,
      currentHeadSha: input.current.headSha,
      reason: "head-rewritten",
    };
  }

  if (input.target.ref !== input.binding.baseRef) {
    if (!input.stackParentMerged) {
      return { action: "attention", reason: "live-base-ref-drifted" };
    }
    if (input.current.baseRef === input.target.ref) {
      if (input.current.baseSha !== input.target.sha) {
        return { action: "attention", reason: "live-base-sha-drifted" };
      }
      return {
        action: "rebase",
        expectedHeadSha: input.binding.headSha,
        expectedBaseRef: input.current.baseRef,
        expectedBaseSha: input.current.baseSha,
        targetBaseRef: input.target.ref,
        targetBaseSha: input.target.sha,
        reason: "target-retarget-observed",
      };
    }
    if (input.current.baseRef !== input.binding.baseRef) {
      return { action: "attention", reason: "live-base-ref-drifted" };
    }
    if (input.current.baseSha !== input.binding.baseSha) {
      return { action: "attention", reason: "live-base-sha-drifted" };
    }
    return {
      action: "retarget-and-rebase",
      expectedHeadSha: input.binding.headSha,
      expectedBaseRef: input.binding.baseRef,
      expectedBaseSha: input.binding.baseSha,
      targetBaseRef: input.target.ref,
      targetBaseSha: input.target.sha,
      reason: "stack-parent-merged",
    };
  }

  if (input.current.baseRef !== input.binding.baseRef) {
    return { action: "attention", reason: "live-base-ref-drifted" };
  }
  if (input.current.baseSha !== input.target.sha) {
    return { action: "attention", reason: "live-base-sha-drifted" };
  }
  if (input.binding.baseSha !== input.target.sha) {
    return {
      action: "rebase",
      expectedHeadSha: input.binding.headSha,
      expectedBaseRef: input.binding.baseRef,
      expectedBaseSha: input.binding.baseSha,
      targetBaseRef: input.target.ref,
      targetBaseSha: input.target.sha,
      reason: "target-advanced",
    };
  }
  return { action: "current" };
}
