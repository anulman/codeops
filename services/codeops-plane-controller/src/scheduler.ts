export type SchedulerTicketState =
  | "ready"
  | "in_progress"
  | "needs_attention"
  | "paused"
  | "cancelled"
  | "complete"
  | "failed"
  | "unknown";

export type PullRequestBinding = Readonly<{
  repository: string;
  number: number;
  state: "open" | "closed" | "merged";
  headSha: string;
  headRef: string;
  baseRef: string;
  baseTicketId?: string;
  qualified: boolean;
}>;

export type SchedulerTicket = Readonly<{
  id: string;
  state: SchedulerTicketState;
  blockedBy: readonly string[];
  workflow: "none" | "queued" | "running" | "terminal";
  pullRequest?: PullRequestBinding;
}>;

export type SchedulingDecision =
  | Readonly<{
      action: "start";
      mode: "main";
      baseSha: string;
      baseRef: "main";
      reason: "all-blockers-complete";
    }>
  | Readonly<{
      action: "start";
      mode: "stacked";
      baseSha: string;
      baseRef: string;
      parentTicketId: string;
      reason: "qualified-direct-blocker-review";
    }>
  | Readonly<{ action: "continue"; reason: "workflow-remains-eligible" }>
  | Readonly<{ action: "cancel"; reason: string }>
  | Readonly<{ action: "hold"; reason: string }>;

export type PullRequestEventDecision =
  | Readonly<{ action: "complete-ticket"; ticketId: string }>
  | Readonly<{ action: "require-attention"; ticketId: string; reason: string }>
  | Readonly<{ action: "ignore"; reason: string }>;

function holdOrCancel(ticket: SchedulerTicket, reason: string): SchedulingDecision {
  return ticket.workflow === "queued" || ticket.workflow === "running"
    ? { action: "cancel", reason }
    : { action: "hold", reason };
}

function hasUnmergedReviewAncestor(
  ticketId: string,
  tickets: ReadonlyMap<string, SchedulerTicket>,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(ticketId)) return true;
  const ticket = tickets.get(ticketId);
  if (ticket === undefined) return true;
  const next = new Set(visiting);
  next.add(ticketId);
  for (const blockerId of ticket.blockedBy) {
    const blocker = tickets.get(blockerId);
    if (blocker === undefined) return true;
    if (blocker.state !== "complete") return true;
    if (hasUnmergedReviewAncestor(blockerId, tickets, next)) return true;
  }
  return false;
}

/**
 * Decide whether one ticket may start or continue. Plane/GitHub reconciliation
 * must provide a complete snapshot; missing or ambiguous state fails closed.
 */
export function evaluateTicketScheduling(input: {
  ticketId: string;
  tickets: ReadonlyMap<string, SchedulerTicket>;
  protectedMainSha: string;
}): SchedulingDecision {
  const ticket = input.tickets.get(input.ticketId);
  if (ticket === undefined) {
    return { action: "hold", reason: "ticket-missing" };
  }
  if (ticket.state !== "ready" && ticket.state !== "in_progress") {
    return holdOrCancel(ticket, `ticket-state-${ticket.state}-is-not-runnable`);
  }

  const reviewBases: SchedulerTicket[] = [];
  for (const blockerId of ticket.blockedBy) {
    const blocker = input.tickets.get(blockerId);
    if (blocker === undefined) {
      return holdOrCancel(ticket, `blocker-${blockerId}-missing`);
    }
    if (blocker.state === "complete") {
      const binding = blocker.pullRequest;
      if (
        binding === undefined ||
        binding.state !== "merged" ||
        binding.baseRef === "main"
      ) {
        continue;
      }
      if (binding.baseTicketId === undefined) {
        return holdOrCancel(
          ticket,
          `completed-blocker-${blocker.id}-integration-base-missing`,
        );
      }
      const integrationParent = input.tickets.get(binding.baseTicketId);
      if (
        integrationParent === undefined ||
        integrationParent.state !== "needs_attention" ||
        integrationParent.pullRequest === undefined ||
        integrationParent.pullRequest.state !== "open" ||
        !integrationParent.pullRequest.qualified ||
        integrationParent.pullRequest.headRef !== binding.baseRef
      ) {
        return holdOrCancel(
          ticket,
          `completed-blocker-${blocker.id}-integration-base-unqualified`,
        );
      }
      reviewBases.push(integrationParent);
      continue;
    }
    if (blocker.state !== "needs_attention") {
      return holdOrCancel(ticket, `blocker-${blocker.id}-state-${blocker.state}`);
    }
    reviewBases.push(blocker);
  }

  let eligibleBase:
    | Readonly<{ mode: "main"; baseSha: string; baseRef: "main" }>
    | Readonly<{
        mode: "stacked";
        baseSha: string;
        baseRef: string;
        parentTicketId: string;
      }>;

  const uniqueReviewBases = [
    ...new Map(reviewBases.map((blocker) => [blocker.id, blocker])).values(),
  ];
  if (uniqueReviewBases.length === 0) {
    eligibleBase = {
      mode: "main",
      baseSha: input.protectedMainSha,
      baseRef: "main",
    };
  } else {
    if (uniqueReviewBases.length !== 1) {
      return holdOrCancel(ticket, "multiple-unresolved-blockers");
    }
    const parent = uniqueReviewBases[0]!;
    const pullRequest = parent.pullRequest;
    if (
      pullRequest === undefined ||
      pullRequest.state !== "open" ||
      !pullRequest.qualified
    ) {
      return holdOrCancel(ticket, `blocker-${parent.id}-has-no-qualified-open-pr`);
    }
    if (hasUnmergedReviewAncestor(parent.id, input.tickets)) {
      return holdOrCancel(ticket, "maximum-unmerged-stack-depth-reached");
    }
    eligibleBase = {
      mode: "stacked",
      baseSha: pullRequest.headSha,
      baseRef: pullRequest.headRef,
      parentTicketId: parent.id,
    };
  }

  if (ticket.state === "in_progress") {
    return { action: "continue", reason: "workflow-remains-eligible" };
  }
  if (eligibleBase.mode === "main") {
    return {
      action: "start",
      ...eligibleBase,
      reason: "all-blockers-complete",
    };
  }
  return {
    action: "start",
    ...eligibleBase,
    reason: "qualified-direct-blocker-review",
  };
}

export function evaluatePullRequestEvent(input: {
  ticket: SchedulerTicket;
  event: Readonly<{
    repository: string;
    number: number;
    action: "closed" | "reopened" | "synchronize";
    merged: boolean;
    headSha: string;
  }>;
}): PullRequestEventDecision {
  const binding = input.ticket.pullRequest;
  if (binding === undefined) {
    return { action: "ignore", reason: "ticket-has-no-pr-binding" };
  }
  if (
    binding.repository !== input.event.repository ||
    binding.number !== input.event.number
  ) {
    return { action: "ignore", reason: "pr-identity-mismatch" };
  }
  if (binding.headSha !== input.event.headSha) {
    return {
      action: "require-attention",
      ticketId: input.ticket.id,
      reason: "bound-pr-head-drifted",
    };
  }
  if (input.event.action === "closed" && input.event.merged) {
    return { action: "complete-ticket", ticketId: input.ticket.id };
  }
  if (input.event.action === "closed") {
    return {
      action: "require-attention",
      ticketId: input.ticket.id,
      reason: "bound-pr-closed-without-merge",
    };
  }
  return {
    action: "require-attention",
    ticketId: input.ticket.id,
    reason:
      input.event.action === "synchronize"
        ? "bound-pr-head-requires-requalification"
        : "bound-pr-reopened-requires-requalification",
  };
}
