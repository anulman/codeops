import type { SessionSnapshot } from "@codeops/codeops-contracts/session-broker";
import { sessionDisplayName } from "./sessionIdentity";

export interface SessionNotification {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly sessionId: string;
  readonly url: string;
}

export function sessionNotificationForTransition(
  previous: SessionSnapshot | null,
  current: SessionSnapshot,
): SessionNotification | null {
  if (
    previous !== null && previous.sessionId !== current.sessionId
  ) {
    return null;
  }
  const name = sessionDisplayName(current.identity);
  if (
    previous?.budget?.exhaustedLimit !== current.budget?.exhaustedLimit &&
    current.budget?.exhaustedLimit
  ) {
    return notification(
      current,
      `budget-${current.budget.exhaustedLimit}`,
      `${name} reached a session budget limit`,
      `Open the session to checkpoint, fork, or review the ${current.budget.exhaustedLimit.replaceAll("_", " ")} limit.`,
    );
  }
  if (previous?.state === current.state) return null;
  if (current.state === "waiting_permission") {
    return notification(
      current,
      "permission",
      `${name} needs permission`,
      current.pendingPermission?.title ?? "Open the session to approve or deny the requested operation.",
    );
  }
  if (current.state === "failed") {
    return notification(
      current,
      "failed",
      `${name} needs attention`,
      "The session failed. Open it to inspect the last durable evidence.",
    );
  }
  if (current.state === "completed") {
    return notification(
      current,
      "completed",
      `${name} is complete`,
      "Open the session to review its result and evidence.",
    );
  }
  if (current.state === "hibernated") {
    return notification(
      current,
      "hibernated",
      `${name} is idle`,
      "The session checkpoint is ready. Open it to resume or fork the work.",
    );
  }
  return null;
}

function notification(
  session: SessionSnapshot,
  kind: string,
  title: string,
  body: string,
): SessionNotification {
  return {
    key: `${session.sessionId}:${session.generation}:${kind}:${session.eventCursor}`,
    title,
    body,
    sessionId: session.sessionId,
    url: `/sessions/${encodeURIComponent(session.sessionId)}`,
  };
}
