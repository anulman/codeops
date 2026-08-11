const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*\b/gi,
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function boundedText(value: string, maximum = 128_000): string {
  const redacted = redactSecrets(value);
  if (redacted.length <= maximum) return redacted;
  const marker = "\n[TRUNCATED]";
  if (maximum <= marker.length) return marker.slice(0, maximum);
  return `${redacted.slice(0, maximum - marker.length)}${marker}`;
}

export function requireLowerHex(
  name: string,
  value: string | undefined,
  length: number,
): string {
  if (!value || !new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new Error(`${name} must contain exactly ${length} lowercase hex characters`);
  }
  return value;
}

export function requireRunId(value: string | undefined): string {
  if (!value || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value)) {
    throw new Error("CODEOPS_RUN_ID must be a DNS-safe label of at most 40 characters");
  }
  return value;
}

export type AgentRole =
  | "coding-agent"
  | "critic-agent"
  | "qa-contract-researcher";

export function requireAgentRole(value: string | undefined): AgentRole {
  if (
    value !== "coding-agent" &&
    value !== "critic-agent" &&
    value !== "qa-contract-researcher"
  ) {
    throw new Error(
      "CODEOPS_AGENT_ROLE must be coding-agent, critic-agent, or qa-contract-researcher",
    );
  }
  return value;
}
