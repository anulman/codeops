import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertImmutableProviderRequest,
  lockProviderRouting,
} from "../lock-provider-routing.mjs";

const entrypointUrl = new URL("../entrypoint.sh", import.meta.url);
const entrypoint = await readFile(entrypointUrl, "utf8");
const connectionUrl = new URL("../acp-connection.mjs", import.meta.url);
const connection = await readFile(connectionUrl, "utf8");
const { loadModelProxyAuthority } = await import(connectionUrl);
const codexAcpUrl = new URL(import.meta.resolve("@agentclientprotocol/codex-acp"));
const codexAcpSource = await readFile(codexAcpUrl, "utf8");
const codexAcpPackage = JSON.parse(
  await readFile(new URL("../package.json", codexAcpUrl), "utf8"),
);

function routingEnvironment() {
  return {
    PATH: process.env.PATH,
    CODEOPS_MODEL_PROXY_ORIGIN: "http://codeops-model-proxy:8080",
    CODEOPS_MODEL_PROXY_TOKEN_FILE: "/run/codeops/model-proxy-token",
    MODEL_PROVIDER: "codeops_proxy",
    CODEX_CONFIG: JSON.stringify({
      model: "gpt-5.6-sol",
      model_provider: "codeops_proxy",
      model_providers: {
        codeops_proxy: {
          name: "CodeOps model proxy",
          base_url: "http://codeops-model-proxy:8080/v1",
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
        },
      },
    }),
  };
}

function assertStartupRejected(env, pattern) {
  const result = spawnSync("/bin/sh", [entrypointUrl.pathname], {
    encoding: "utf8",
    env,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}

test("entrypoint requires the isolated per-Session Codex home", () => {
  execFileSync("/bin/sh", ["-n", entrypointUrl.pathname]);
  assert.match(entrypoint, /codex_home="\$\{CODEX_HOME:-\/var\/lib\/codeops-agent\/codex-home\}"/);
  assert.match(entrypoint, /if \[ "\$codex_home" != "\/var\/lib\/codeops-agent\/codex-home" \]/);
  assert.doesNotMatch(entrypoint, /CODEX_HOME:-\/tmp/);
  assert.match(entrypoint, /chmod 700 "\$codex_home"/);
  assert.match(entrypoint, /test -w "\$codex_home"/);
  assert.match(entrypoint, /CODEOPS_MODEL_PROXY_TOKEN_FILE/);
  assert.match(entrypoint, /acp-connection\.mjs/);
  assert.match(connection, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/);
  assert.match(connection, /\(stats\.mode & 0o777\) !== 0o600/);
  assert.doesNotMatch(entrypoint, /model-proxy-token\.tmp/);
  assert.doesNotMatch(entrypoint, /export CODEX_API_KEY/);
  assert.doesNotMatch(entrypoint, /auth\.json/);
});

test("each ACP connection loads the currently rotated authority file", async () => {
  const root = await mkdtemp(join(tmpdir(), "codeops-acp-authority-"));
  const tokenPath = join(root, "model-proxy-token");
  const first = `v1.${"a".repeat(32)}.${"b".repeat(43)}`;
  const second = `v1.${"c".repeat(32)}.${"d".repeat(43)}`;
  try {
    await writeFile(tokenPath, first, { mode: 0o600 });
    assert.equal(loadModelProxyAuthority(tokenPath, tokenPath), first);
    await writeFile(tokenPath, second);
    await chmod(tokenPath, 0o600);
    assert.equal(loadModelProxyAuthority(tokenPath, tokenPath), second);
    await chmod(tokenPath, 0o644);
    assert.throws(() => loadModelProxyAuthority(tokenPath, tokenPath), /0600/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entrypoint rejects every missing or mismatched model proxy route", () => {
  const valid = routingEnvironment();
  const config = JSON.parse(valid.CODEX_CONFIG);
  const mutations = [
    [{ ...valid, MODEL_PROVIDER: undefined }, /MODEL_PROVIDER must equal codeops_proxy/],
    [{ ...valid, MODEL_PROVIDER: "openai" }, /MODEL_PROVIDER must equal codeops_proxy/],
    [{ ...valid, CODEOPS_MODEL_PROXY_ORIGIN: undefined }, /CODEOPS_MODEL_PROXY_ORIGIN/],
    [{ ...valid, CODEOPS_MODEL_PROXY_ORIGIN: "https://codeops-model-proxy:8080" }, /credential-free HTTP origin/],
    [{ ...valid, CODEX_CONFIG: "{" }, /CODEX_CONFIG must be valid JSON/],
    [{ ...valid, CODEX_CONFIG: JSON.stringify({ ...config, model_provider: "openai" }) }, /routing contract is invalid/],
    [{ ...valid, CODEX_CONFIG: JSON.stringify({ ...config, model_providers: {} }) }, /routing contract is invalid/],
    [{ ...valid, CODEX_CONFIG: JSON.stringify({ ...config, model_providers: { ...config.model_providers, openai: {} } }) }, /routing contract is invalid/],
    [{ ...valid, CODEX_CONFIG: JSON.stringify({ ...config, model_providers: { codeops_proxy: { ...config.model_providers.codeops_proxy, base_url: "http://other-proxy:8080/v1" } } }) }, /routing contract is invalid/],
    [{ ...valid, CODEX_CONFIG: JSON.stringify({ ...config, model_providers: { codeops_proxy: { ...config.model_providers.codeops_proxy, env_key: "OPENAI_API_KEY" } } }) }, /routing contract is invalid/],
    [{ ...valid, CODEX_CONFIG: JSON.stringify({ ...config, model_providers: { codeops_proxy: { ...config.model_providers.codeops_proxy, wire_api: "chat" } } }) }, /routing contract is invalid/],
    [{ ...valid, CODEX_CONFIG: JSON.stringify({ ...config, model_providers: { codeops_proxy: { ...config.model_providers.codeops_proxy, extra: true } } }) }, /routing contract is invalid/],
    [{ ...valid, CODEOPS_MODEL_PROXY_TOKEN_FILE: undefined }, /must equal \/run\/codeops\/model-proxy-token/],
    [{ ...valid, CODEOPS_MODEL_PROXY_TOKEN_FILE: "/run/codeops/other-token" }, /must equal \/run\/codeops\/model-proxy-token/],
    [{ ...valid, CODEX_API_KEY: "literal-reusable-key" }, /forbidden before mounted token import/],
    [{ ...valid, CODEX_API_KEY: "" }, /forbidden before mounted token import/],
    [{ ...valid, OPENAI_API_KEY: "literal-reusable-key" }, /forbidden before mounted token import/],
    [{ ...valid, OPENAI_API_KEY: "" }, /forbidden before mounted token import/],
  ];
  for (const [env, pattern] of mutations) assertStartupRejected(env, pattern);
});

test("pins ACP new, load, and resume routing to the process model provider", () => {
  assert.equal(codexAcpPackage.version, "1.10.0");
  assert.match(codexAcpSource, /const modelProvider = process\.env\["MODEL_PROVIDER"\];/);
  assert.match(
    codexAcpSource,
    /new CodexAcpClient\(appServerClient, config2, modelProvider\)/,
  );

  const newSession = codexAcpSource.slice(
    codexAcpSource.indexOf("  async newSession("),
    codexAcpSource.indexOf("  async closeSession("),
  );
  assert.match(newSession, /modelProvider: this\.getModelProvider\(\)/);

  for (const [name, nextName] of [
    ["resumeSession", "loadSession"],
    ["loadSession", "newSession"],
  ]) {
    const method = codexAcpSource.slice(
      codexAcpSource.indexOf(`  async ${name}(`),
      codexAcpSource.indexOf(`  async ${nextName}(`),
    );
    assert.match(method, /modelProvider: await this\.getResumeModelProvider\(\)/);
    assert.doesNotMatch(method, /modelProvider: "openai"/);
  }

  const currentProvider = codexAcpSource.slice(
    codexAcpSource.indexOf("  async getCurrentModelProvider("),
    codexAcpSource.indexOf("  async logout("),
  );
  assert.match(
    currentProvider,
    /const sessionModelProvider = this\.getModelProvider\(\);[\s\S]*if \(sessionModelProvider !== null\) {[\s\S]*return sessionModelProvider;[\s\S]*configRead/,
  );
  const resumeProvider = codexAcpSource.slice(
    codexAcpSource.indexOf("  async getResumeModelProvider("),
    codexAcpSource.indexOf("  async refreshSkills("),
  );
  assert.match(
    resumeProvider,
    /return await this\.getCurrentModelProvider\(\) \?\? "openai";/,
  );
});

test("rejects provider overrides before ACP new, load, and resume", () => {
  const lockedSource = lockProviderRouting(codexAcpSource);
  assert.match(lockedSource, /configured process provider is immutable/);
  assert.ok(
    lockedSource.indexOf("configured process provider is immutable") <
      lockedSource.indexOf("  async resumeSession("),
  );
  for (const lifecycle of ["session/new", "session/load", "session/resume"]) {
    assert.throws(
      () => assertImmutableProviderRequest(
        "providers/set",
        { providerId: "custom-gateway", baseUrl: "http://other-proxy:8080/v1" },
        "codeops_proxy",
      ),
      /configured process provider is immutable/,
      lifecycle,
    );
    assert.throws(
      () => assertImmutableProviderRequest(
        "providers/disable",
        { providerId: "openai" },
        "codeops_proxy",
      ),
      /configured process provider is immutable/,
      lifecycle,
    );
    assert.throws(
      () => assertImmutableProviderRequest(
        "authenticate",
        { methodId: "gateway", _meta: { gateway: { baseUrl: "http://other-proxy:8080/v1" } } },
        "codeops_proxy",
      ),
      /configured process provider is immutable/,
      lifecycle,
    );
  }
  assert.doesNotThrow(() =>
    assertImmutableProviderRequest("authenticate", { methodId: "api-key" }, "codeops_proxy"),
  );
});
