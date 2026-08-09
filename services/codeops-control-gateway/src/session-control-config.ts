export const SESSION_CONTROL_SECRET_NAMES = [
  "readToken",
  "writeToken",
  "workerToken",
  "initializationToken",
  "githubSteeringToken",
] as const;

export type SessionControlSecrets = Readonly<
  Record<(typeof SESSION_CONTROL_SECRET_NAMES)[number], string>
>;

export function validateSessionControlSecrets(
  secrets: SessionControlSecrets,
): SessionControlSecrets {
  for (const name of SESSION_CONTROL_SECRET_NAMES) {
    const value = secrets[name];
    if (value.length < 32 || value.length > 4_096) {
      throw new Error(`session control ${name} length is invalid`);
    }
  }
  if (new Set(Object.values(secrets)).size !== SESSION_CONTROL_SECRET_NAMES.length) {
    throw new Error("session control credentials must have distinct authorities");
  }
  return secrets;
}
