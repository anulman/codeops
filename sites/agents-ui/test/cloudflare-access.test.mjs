import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import {
  parseCloudflareAccessConfiguration,
  verifyCloudflareAccessJwt,
} from "../src/lib/cloudflareAccess.server.ts";

const issuer = "https://example.cloudflareaccess.com";
const audience = "agents_control_plane_audience_2026";
const allowedEmail = "operator@example.com";
const currentDate = new Date("2026-08-09T18:00:00.000Z");

async function signingFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "access-key-1";
  return {
    privateKey,
    jwks: createLocalJWKSet({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
    kid,
  };
}

function configuration(allowedEmails = [allowedEmail]) {
  return parseCloudflareAccessConfiguration({ issuer, audience, allowedEmails });
}

async function token(input = {}) {
  const fixture = input.fixture ?? await signingFixture();
  const signed = await new SignJWT({ email: input.email ?? allowedEmail })
    .setProtectedHeader({ alg: "RS256", kid: fixture.kid, typ: "JWT" })
    .setIssuer(input.issuer ?? issuer)
    .setAudience(input.audience ?? audience)
    .setIssuedAt(Math.floor(currentDate.getTime() / 1000) - 60)
    .setExpirationTime(input.expirationTime ?? Math.floor(currentDate.getTime() / 1000) + 300)
    .sign(fixture.privateKey);
  return { signed, fixture };
}

test("accepts one signed, current, audience-bound, allowlisted Access identity", async () => {
  const { signed, fixture } = await token({ email: "OPERATOR@example.com" });
  assert.equal(await verifyCloudflareAccessJwt({
    token: signed,
    configuration: configuration(),
    jwks: fixture.jwks,
    currentDate,
  }), allowedEmail);
});

test("rejects a wrong issuer, audience, expiry, signature, or identity", async () => {
  const cases = [
    await token({ issuer: "https://other.cloudflareaccess.com/" }),
    await token({ audience: "different_access_audience" }),
    await token({ expirationTime: Math.floor(currentDate.getTime() / 1000) - 30 }),
    await token({ email: "intruder@example.com" }),
  ];
  for (const candidate of cases) {
    await assert.rejects(verifyCloudflareAccessJwt({
      token: candidate.signed,
      configuration: configuration(),
      jwks: candidate.fixture.jwks,
      currentDate,
    }));
  }

  const signedByForeignKey = await token();
  const trustedKey = await signingFixture();
  await assert.rejects(verifyCloudflareAccessJwt({
    token: signedByForeignKey.signed,
    configuration: configuration(),
    jwks: trustedKey.jwks,
    currentDate,
  }));
});

test("rejects non-Cloudflare issuers and empty identity allowlists", () => {
  assert.throws(() => parseCloudflareAccessConfiguration({
    issuer: "https://example.com/",
    audience,
    allowedEmails: [allowedEmail],
  }));
  assert.throws(() => parseCloudflareAccessConfiguration({
    issuer,
    audience,
    allowedEmails: [],
  }), /at least one identity/);
});

test("permits the unauthenticated browser harness only on loopback", async () => {
  const source = await readFile(
    new URL("../src/lib/agentsAuth.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /AGENTS_UI_ACCESS_REQUIRED === "false"/);
  assert.match(source, /localHost === "127\.0\.0\.1"/);
  assert.match(source, /localHost === "localhost"/);
  assert.match(source, /localHost === "::1"/);
  assert.match(source, /process\.env\.NODE_ENV === "production"/);
});

test("rejects unauthenticated requests before SSR serialization", async () => {
  const authSource = await readFile(
    new URL("../src/lib/agentsAuth.ts", import.meta.url),
    "utf8",
  );
  const startSource = await readFile(
    new URL("../src/start.ts", import.meta.url),
    "utf8",
  );

  assert.match(authSource, /createMiddleware\(\)\.server/);
  assert.doesNotMatch(authSource, /throw new Response\("Unauthorized"/);
  assert.equal(
    (authSource.match(/return new Response\("Unauthorized", \{ status: 401 \}\)/g) ?? []).length,
    2,
  );
  assert.match(startSource, /requestMiddleware: \[agentsAuthMiddleware\]/);
});
