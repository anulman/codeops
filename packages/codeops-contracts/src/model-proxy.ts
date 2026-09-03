import { createHmac } from "node:crypto";

interface ModelProxyTokenInput {
  readonly subject: string;
  readonly signingKey: string;
  readonly model: string;
  readonly reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh";
  readonly maximumRequests?: number;
  readonly maximumOutputTokens?: number;
  readonly issuedAt?: Date;
}

interface SessionModelProxyTokenInput extends ModelProxyTokenInput {
  readonly budgetId: string;
  readonly generation: number;
}

interface ClaimedDispatchModelProxyTokenInput extends SessionModelProxyTokenInput {
  readonly leaseId: string;
  readonly dispatchId: string;
  readonly expiresAt: Date;
}

function createToken(
  input: ModelProxyTokenInput,
  budgetAuthority: Readonly<{
    budgetId: string;
    generation: number;
    leaseId?: string;
    dispatchId?: string;
    expiresAt?: Date;
  }> | null,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.subject)) {
    throw new Error("model proxy token subject is invalid");
  }
  if (budgetAuthority !== null && (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(budgetAuthority.budgetId) ||
    !Number.isSafeInteger(budgetAuthority.generation) ||
    budgetAuthority.generation < 1 ||
    ((budgetAuthority.leaseId !== undefined ||
      budgetAuthority.dispatchId !== undefined ||
      budgetAuthority.expiresAt !== undefined) && (
      budgetAuthority.expiresAt === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        budgetAuthority.leaseId ?? "",
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        budgetAuthority.dispatchId ?? "",
      )
    ))
  )) {
    throw new Error("model proxy token budget authority is invalid");
  }
  if (input.signingKey.length < 32 || input.signingKey.length > 4_096) {
    throw new Error("model proxy signing key length is invalid");
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(input.model) ||
    !["none", "low", "medium", "high", "xhigh"].includes(
      input.reasoningEffort,
    )
  ) {
    throw new Error("model proxy token policy is invalid");
  }
  const maximumRequests = input.maximumRequests ?? 200;
  const maximumOutputTokens = input.maximumOutputTokens ?? 32_768;
  if (
    !Number.isSafeInteger(maximumRequests) ||
    maximumRequests < 1 ||
    maximumRequests > 1_000 ||
    !Number.isSafeInteger(maximumOutputTokens) ||
    maximumOutputTokens < 1 ||
    maximumOutputTokens > 100_000
  ) {
    throw new Error("model proxy token budget is invalid");
  }
  const issuedAt = Math.floor((input.issuedAt ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAt)) {
    throw new Error("model proxy token issue time is invalid");
  }
  const dispatchAuthority = budgetAuthority?.expiresAt !== undefined;
  const expiresAt = !dispatchAuthority
    ? issuedAt + 75 * 60
    : Math.floor(budgetAuthority.expiresAt!.getTime() / 1_000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > (dispatchAuthority ? 5 * 60 : 75 * 60)
  ) {
    throw new Error("session model proxy token expiry is invalid");
  }
  const payloadBody = budgetAuthority === null
    ? {
        aud: "codeops-model-proxy",
        sub: input.subject,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        maximumRequests,
        maximumOutputTokens,
        iat: issuedAt,
        exp: expiresAt,
      }
    : dispatchAuthority
    ? {
        aud: "codeops-model-proxy",
        sub: input.subject,
        budgetId: budgetAuthority.budgetId,
        generation: budgetAuthority.generation,
        leaseId: budgetAuthority.leaseId!,
        dispatchId: budgetAuthority.dispatchId!,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        maximumRequests,
        maximumOutputTokens,
        iat: issuedAt,
        exp: expiresAt,
      }
    : {
        aud: "codeops-model-proxy",
        sub: input.subject,
        budgetId: budgetAuthority.budgetId,
        generation: budgetAuthority.generation,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        maximumRequests,
        maximumOutputTokens,
        iat: issuedAt,
        exp: expiresAt,
      };
  const payload = Buffer.from(JSON.stringify(payloadBody)).toString("base64url");
  const signature = createHmac("sha256", input.signingKey)
    .update(`v1.${payload}`)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

export function createModelProxyToken(input: ModelProxyTokenInput): string {
  return createToken(input, null);
}

export function createSessionModelProxyToken(
  input: SessionModelProxyTokenInput,
): string {
  return createToken(input, {
    budgetId: input.budgetId,
    generation: input.generation,
  });
}

export function createClaimedDispatchModelProxyToken(
  input: ClaimedDispatchModelProxyTokenInput,
): string {
  return createToken(input, {
    budgetId: input.budgetId,
    generation: input.generation,
    leaseId: input.leaseId,
    dispatchId: input.dispatchId,
    expiresAt: input.expiresAt,
  });
}
