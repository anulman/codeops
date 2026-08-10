import { createHmac } from "node:crypto";

export function createModelProxyToken(input: {
  readonly subject: string;
  readonly signingKey: string;
  readonly issuedAt?: Date;
}): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.subject)) {
    throw new Error("model proxy token subject is invalid");
  }
  if (input.signingKey.length < 32 || input.signingKey.length > 4_096) {
    throw new Error("model proxy signing key length is invalid");
  }
  const issuedAt = Math.floor((input.issuedAt ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAt)) {
    throw new Error("model proxy token issue time is invalid");
  }
  const payload = Buffer.from(JSON.stringify({
    aud: "codeops-model-proxy",
    sub: input.subject,
    iat: issuedAt,
    exp: issuedAt + 75 * 60,
  })).toString("base64url");
  const signature = createHmac("sha256", input.signingKey)
    .update(`v1.${payload}`)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}
