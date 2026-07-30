import {
  evaluateTicketScheduling,
  type SchedulerTicket,
  type SchedulingDecision,
} from "./scheduler.js";

export type ProjectSchedulingAction = Readonly<{
  ticketId: string;
  decision: SchedulingDecision;
}>;

/**
 * Re-evaluate a complete project snapshot after either Plane or GitHub changes.
 * Side effects are injected, deterministic, and idempotency remains the
 * responsibility of the durable workflow/PR identities invoked by callbacks.
 */
export async function reconcileProjectScheduling(input: {
  tickets: ReadonlyMap<string, SchedulerTicket>;
  protectedMainSha: string;
  start: (input: {
    ticket: SchedulerTicket;
    decision: Extract<SchedulingDecision, { action: "start" }>;
  }) => Promise<void>;
  cancel: (input: {
    ticket: SchedulerTicket;
    decision: Extract<SchedulingDecision, { action: "cancel" }>;
  }) => Promise<void>;
}): Promise<readonly ProjectSchedulingAction[]> {
  const actions: ProjectSchedulingAction[] = [];
  for (const ticketId of [...input.tickets.keys()].sort()) {
    const ticket = input.tickets.get(ticketId);
    if (ticket === undefined) continue;
    const decision = evaluateTicketScheduling({
      ticketId,
      tickets: input.tickets,
      protectedMainSha: input.protectedMainSha,
    });
    if (decision.action === "start") {
      await input.start({ ticket, decision });
      actions.push({ ticketId, decision });
    } else if (decision.action === "cancel") {
      await input.cancel({ ticket, decision });
      actions.push({ ticketId, decision });
    }
  }
  return actions;
}
