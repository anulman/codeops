import { createServer } from "node:http";
import { ENV } from "varlock/env";
import { createModelProxyRequestListener } from "./core.mjs";

const port = Number(ENV.CODEOPS_MODEL_PROXY_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CODEOPS_MODEL_PROXY_PORT is invalid");
}

const server = createServer(
  createModelProxyRequestListener({
    openAiApiKey: ENV.OPENAI_API_KEY,
    signingKey: ENV.CODEOPS_MODEL_PROXY_SIGNING_KEY,
  }),
);
server.listen(port, ENV.CODEOPS_MODEL_PROXY_HOST);
