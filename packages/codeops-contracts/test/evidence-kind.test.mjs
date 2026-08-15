import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVIDENCE_KINDS,
  evidenceDeclarationSchema,
} from "../dist/index.js";

const declarations = [
  { kind: "simulated-provider", providerMode: "fake" },
  { kind: "browser-acceptance", providerDelivery: false },
  { kind: "released-image", sourceCheckout: false, immutableImageRefs: true },
  { kind: "live-provider", providerDelivery: true, authorizationMode: "explicit" },
];

test("accepts every exact evidence declaration", () => {
  assert.deepEqual(EVIDENCE_KINDS, declarations.map(({ kind }) => kind));
  for (const declaration of declarations) {
    assert.deepEqual(evidenceDeclarationSchema.parse(declaration), declaration);
  }
});

test("rejects unknown, incomplete, mixed, or upgraded evidence declarations", () => {
  const invalid = [
    { kind: "unsupported" },
    { kind: "simulated-provider" },
    { kind: "simulated-provider", providerMode: "fake", providerDelivery: true },
    { kind: "browser-acceptance", providerDelivery: true },
    { kind: "browser-acceptance", providerDelivery: false, providerMode: "fake" },
    { kind: "released-image", sourceCheckout: true, immutableImageRefs: true },
    { kind: "released-image", sourceCheckout: false, immutableImageRefs: false },
    { kind: "released-image", sourceCheckout: false, immutableImageRefs: true, providerMode: "fake" },
    { kind: "live-provider", providerDelivery: true },
    { kind: "live-provider", providerDelivery: true, authorizationMode: "implicit" },
    { kind: "live-provider", providerDelivery: true, authorizationMode: "explicit", token: "secret" },
  ];
  for (const declaration of invalid) {
    assert.equal(evidenceDeclarationSchema.safeParse(declaration).success, false);
  }
});
