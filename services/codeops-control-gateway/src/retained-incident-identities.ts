/** Preserved 2026-09-05 incident identities. Never adopt or reconcile their history. */
export const retainedLaunchIds = ["launch-222222222222222222222222"] as const;
export const retainedSessionIds = ["ses_222222222222222222222222"] as const;
export function isRetainedIncidentIdentity(launchId?: string, sessionId?: string): boolean {
  return retainedLaunchIds.some((id) => id === launchId) ||
    retainedSessionIds.some((id) => id === sessionId);
}
