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
    method === "providers/disable" ||
    (method === "authenticate" &&
      (params?.methodId !== "api-key" || params?._meta !== undefined))
  ) {
    throw new Error("configured process provider is immutable");
  }
}

export function lockProviderRouting(source) {
  const authenticate = "  async authenticate(authRequest, urlElicitationRequester) {\n    if (!isCodexAuthRequest(authRequest)) {";
  const guardedAuthenticate = `  async authenticate(authRequest, urlElicitationRequester) {${configuredProviderGuard}\n    if (!isCodexAuthRequest(authRequest)) {`;
  const setProvider = "  setProvider(request) {\n    if (request.providerId !== OPENAI_PROVIDER_ID) {";
  const guardedSetProvider = `  setProvider(request) {\n    if (this.modelProvider !== null) {\n      throw RequestError.invalidParams(void 0, \"configured process provider is immutable\");\n    }\n    if (request.providerId !== OPENAI_PROVIDER_ID) {`;
  const disableProvider = "  disableProvider(request) {\n    const overrideWasActive = this.gatewayConfig !== null;";
  const guardedDisableProvider = `  disableProvider(request) {\n    if (this.modelProvider !== null) {\n      throw RequestError.invalidParams(void 0, \"configured process provider is immutable\");\n    }\n    const overrideWasActive = this.gatewayConfig !== null;`;
  if (
    source.split(authenticate).length !== 2 ||
    source.split(setProvider).length !== 2 ||
    source.split(disableProvider).length !== 2 ||
    !source.includes('var package_default = {\n  name: "@agentclientprotocol/codex-acp",') ||
    !source.includes('  version: "1.10.0",')
  ) {
    throw new Error("unexpected codex-acp 1.10.0 provider routing source");
  }
  return source
    .replace(authenticate, guardedAuthenticate)
    .replace(setProvider, guardedSetProvider)
    .replace(disableProvider, guardedDisableProvider);
}

async function main(path) {
  const source = await readFile(path, "utf8");
  await writeFile(path, lockProviderRouting(source));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
