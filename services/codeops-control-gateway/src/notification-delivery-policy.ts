/** Shared bounded notification retry policy. Exhausted/ambiguous work is retained. */
export function notificationRetryDelayMs(attemptCount: number): number {
  if (!Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount > 8) {
    throw new Error("notification delivery attempt is invalid");
  }
  return Math.min(300_000, 5_000 * 2 ** (attemptCount - 1));
}
