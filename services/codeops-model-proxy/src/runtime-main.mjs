import { createServer } from "node:http";
import pg from "pg";
import { ENV } from "varlock/env";
import { createModelProxyRequestListener } from "./core.mjs";
import { createModelBudgetLedger } from "./model-budget-ledger.mjs";

const port = Number(ENV.CODEOPS_MODEL_PROXY_PORT);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CODEOPS_MODEL_PROXY_PORT is invalid");
}
if (ENV.CODEOPS_MODEL_PROXY_PRIVACY_MODE !== "strict-v1") {
  throw new Error("CODEOPS_MODEL_PROXY_PRIVACY_MODE must be strict-v1");
}

const database = new pg.Pool({
  connectionString: ENV.CODEOPS_MODEL_PROXY_DATABASE_URL,
  max: 10,
  application_name: "codeops-model-proxy",
});
const modelBudgetLedger = createModelBudgetLedger(database);
await modelBudgetLedger.recover();
const recoveryTimer = setInterval(() => {
  void modelBudgetLedger.recover().catch((error) => {
    console.error("model budget recovery failed", error);
  });
}, 60_000);
recoveryTimer.unref();
const server = createServer(
  createModelProxyRequestListener({
    openAiApiKey: ENV.OPENAI_API_KEY,
    signingKey: ENV.CODEOPS_MODEL_PROXY_SIGNING_KEY,
    modelBudgetLedger,
  }),
);
server.listen(port, ENV.CODEOPS_MODEL_PROXY_HOST);
