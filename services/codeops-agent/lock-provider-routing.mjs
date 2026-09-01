import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const configuredProviderGuard = `
    if (
      this.modelProvider !== null &&
      (authRequest.methodId !== "api-key" || authRequest._meta !== void 0)
    ) {
      throw RequestError.invalidParams(void 0, "configured process provider is immutable");
    }`;

export function assertImmutableProviderRequest(method, params, configuredProvider) {
  if (configuredProvider === null) return;
  if (
    method === "providers/set" ||
    (method === "authenticate" &&
      (params?.methodId !== "api-key" || params?._meta !== undefined))
  ) {
    throw new Error("configured process provider is immutable");
  }
}

export function lockProviderRouting(source) {
  const authenticate = "  async authenticate(authRequest) {\n    if (!isCodexAuthRequest(authRequest)) {";
  const guardedAuthenticate = `  async authenticate(authRequest) {${configuredProviderGuard}\n    if (!isCodexAuthRequest(authRequest)) {`;
  const setProvider = "  setProvider(request) {\n    if (request.providerId !== CUSTOM_GATEWAY_PROVIDER_ID) {";
  const guardedSetProvider = `  setProvider(request) {\n    if (this.modelProvider !== null) {\n      throw RequestError.invalidParams(void 0, \"configured process provider is immutable\");\n    }\n    if (request.providerId !== CUSTOM_GATEWAY_PROVIDER_ID) {`;
  if (
    source.split(authenticate).length !== 2 ||
    source.split(setProvider).length !== 2 ||
    !source.includes('var package_default = {\n  name: "@agentclientprotocol/codex-acp",') ||
    !source.includes('  version: "1.1.7",')
  ) {
    throw new Error("unexpected codex-acp 1.1.7 provider routing source");
  }
  return source.replace(authenticate, guardedAuthenticate).replace(setProvider, guardedSetProvider);
}

async function main(path) {
  const source = await readFile(path, "utf8");
  await writeFile(path, lockProviderRouting(source));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
