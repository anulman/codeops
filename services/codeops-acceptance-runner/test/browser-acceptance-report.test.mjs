import assert from "node:assert/strict";
import { test } from "node:test";
import { browserAcceptanceReport } from "../src/browser-acceptance-report.mjs";

test("reports browser acceptance without claiming provider delivery", () => {
  assert.deepEqual(browserAcceptanceReport(), {
    version: "codeops.browser-acceptance-report/v1",
    evidence: {
      kind: "browser-acceptance",
      providerDelivery: false,
    },
    status: "passed",
    target: "local-agents-ui",
  });
});
