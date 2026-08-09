import { readFile } from "node:fs/promises";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

const issuerSchema = z
  .string()
  .url()
  .max(512)
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname.endsWith(".cloudflareaccess.com"),
    "Cloudflare Access issuer must be one HTTPS team-domain origin",
  );
const audienceSchema = z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/);
const emailSchema = z.string().email().max(320).transform((value) => value.toLowerCase());

export interface CloudflareAccessConfiguration {
  readonly issuer: URL;
  readonly audience: string;
  readonly allowedEmails: ReadonlySet<string>;
}

const remoteKeySets = new WeakMap<CloudflareAccessConfiguration, JWTVerifyGetKey>();

function remoteKeySet(configuration: CloudflareAccessConfiguration): JWTVerifyGetKey {
  const existing = remoteKeySets.get(configuration);
  if (existing) return existing;
  const created = createRemoteJWKSet(
    new URL("/cdn-cgi/access/certs", configuration.issuer),
  );
  remoteKeySets.set(configuration, created);
  return created;
}

export function parseCloudflareAccessConfiguration(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly allowedEmails: readonly string[];
}): CloudflareAccessConfiguration {
  const issuer = issuerSchema.parse(input.issuer);
  const audience = audienceSchema.parse(input.audience);
  const allowedEmails = new Set(input.allowedEmails.map((email) => emailSchema.parse(email)));
  if (allowedEmails.size === 0) {
    throw new Error("Cloudflare Access must allow at least one identity");
  }
  return { issuer, audience, allowedEmails };
}

export async function readCloudflareAccessConfiguration(input: {
  readonly issuer: string | undefined;
  readonly audience: string | undefined;
  readonly allowedEmailsFile: string | undefined;
}): Promise<CloudflareAccessConfiguration> {
  if (!input.issuer?.trim() || !input.audience?.trim() || !input.allowedEmailsFile?.trim()) {
    throw new Error("Cloudflare Access configuration is incomplete");
  }
  const allowedEmails = (await readFile(input.allowedEmailsFile, "utf8"))
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value !== "" && !value.startsWith("#"));
  return parseCloudflareAccessConfiguration({
    issuer: input.issuer.trim(),
    audience: input.audience.trim(),
    allowedEmails,
  });
}

export async function verifyCloudflareAccessJwt(input: {
  readonly token: string;
  readonly configuration: CloudflareAccessConfiguration;
  readonly jwks?: JWTVerifyGetKey;
  readonly currentDate?: Date;
}): Promise<string> {
  if (input.token.length < 32 || input.token.length > 16_384) {
    throw new Error("Cloudflare Access token length is invalid");
  }
  const { payload } = await jwtVerify(
    input.token,
    input.jwks ?? remoteKeySet(input.configuration),
    {
      issuer: input.configuration.issuer.origin,
      audience: input.configuration.audience,
      algorithms: ["RS256"],
      clockTolerance: 5,
      currentDate: input.currentDate,
    },
  );
  const email = emailSchema.parse(payload.email);
  if (!input.configuration.allowedEmails.has(email)) {
    throw new Error("Cloudflare Access identity is not allowed");
  }
  return email;
}
