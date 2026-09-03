import assert from "node:assert/strict";
import { test } from "node:test";
import {
  controlGatewayRuntimeRole,
  isFileBackedControlGatewayRequest,
  runtimeRoleOwnsRequest,
} from "../dist/runtime-role.js";

test("splits rolling API requests from singleton file-backed dispatch", () => {
  assert.equal(controlGatewayRuntimeRole(undefined), "api");
  assert.equal(controlGatewayRuntimeRole("file-dispatcher"), "file-dispatcher");
  assert.throws(() => controlGatewayRuntimeRole("combined"), /invalid/);

  const fileRequests = [
    ["POST", "/v1/agent-jobs"],
    ["POST", "/v1/repositories/example-org/example-repository/candidate-publications"],
  ];
  for (const [method, url] of fileRequests) {
    assert.equal(isFileBackedControlGatewayRequest(method, url), true);
    assert.equal(runtimeRoleOwnsRequest("file-dispatcher", method, url), true);
    assert.equal(runtimeRoleOwnsRequest("api", method, url), false);
  }
  for (const [method, url] of [
    ["GET", "/v1/session-broker/sessions"],
    ["POST", "/v1/session-runtime/dispatches/id/completions"],
    ["POST", "/v1/repositories/example-org/example-repository/proof-publications"],
  ]) {
    assert.equal(isFileBackedControlGatewayRequest(method, url), false);
    assert.equal(runtimeRoleOwnsRequest("api", method, url), true);
    assert.equal(runtimeRoleOwnsRequest("file-dispatcher", method, url), false);
  }
});
