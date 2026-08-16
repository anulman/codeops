import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionOwnerPrincipal } from "../src/lib/sessionOwnerContext.ts";

test("resolves one normalized fixed session owner", () => {
  assert.equal(resolveSessionOwnerPrincipal({
    fixedPrincipal: " operator@example.com ",
    readHeader: () => undefined,
  }), "operator@example.com");
});

test("resolves one exact trusted header session owner", () => {
  const reads = [];
  assert.equal(resolveSessionOwnerPrincipal({
    principalHeader: "X-CodeOps-Authenticated-Principal",
    readHeader(name) {
      reads.push(name);
      return "access:aidan@example.com";
    },
  }), "access:aidan@example.com");
  assert.deepEqual(reads, ["x-codeops-authenticated-principal"]);
});

test("fails closed for ambiguous, missing, or malformed session owner authority", () => {
  assert.throws(() => resolveSessionOwnerPrincipal({
    readHeader: () => undefined,
  }), /exactly one/);
  assert.throws(() => resolveSessionOwnerPrincipal({
    fixedPrincipal: "operator@example.com",
    principalHeader: "x-principal",
    readHeader: () => "operator@example.com",
  }), /exactly one/);
  assert.throws(() => resolveSessionOwnerPrincipal({
    principalHeader: "x-principal",
    readHeader: () => undefined,
  }), /missing/);
  assert.throws(() => resolveSessionOwnerPrincipal({
    principalHeader: "x-principal",
    readHeader: () => " operator@example.com ",
  }), /missing/);
  assert.throws(() => resolveSessionOwnerPrincipal({
    fixedPrincipal: "invalid principal",
    readHeader: () => undefined,
  }));
});
