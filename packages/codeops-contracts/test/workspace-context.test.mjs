import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  workspaceContextAttachmentDescriptorsSchema,
  workspaceContextAttachmentsSchema,
} from "../dist/workspace-launch.js";
import {
  decodeWorkspaceContextAttachment,
  verifyWorkspaceContextAttachments,
  workspaceContextAttachmentDescriptors,
} from "../dist/workspace-context-node.js";

function attachment(name, content, overrides = {}) {
  const bytes = Buffer.from(content);
  return {
    attachmentId: `context-${name.replace(/\W/g, "-")}`,
    name,
    mimeType: "text/plain",
    sizeBytes: bytes.byteLength,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    content: bytes.toString("base64"),
    ...overrides,
  };
}

test("verifies exact context bytes and returns descriptor-only public state", () => {
  const exact = attachment("brief.txt", "Inspect this exact brief.\n");
  assert.deepEqual(verifyWorkspaceContextAttachments([exact]), [exact]);
  assert.equal(decodeWorkspaceContextAttachment(exact).toString("utf8"), "Inspect this exact brief.\n");
  const descriptors = workspaceContextAttachmentDescriptors([exact]);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].digest, exact.digest);
  assert.equal("content" in descriptors[0], false);
  assert.doesNotThrow(() => workspaceContextAttachmentDescriptorsSchema.parse(descriptors));
});

test("rejects digest, size, encoding, text, identity, and aggregate drift", () => {
  const exact = attachment("brief.txt", "exact");
  assert.throws(() => verifyWorkspaceContextAttachments([{ ...exact, digest: `sha256:${"0".repeat(64)}` }]), /digest drifted/);
  assert.throws(() => verifyWorkspaceContextAttachments([{ ...exact, sizeBytes: exact.sizeBytes + 1 }]), /byte count drifted/);
  assert.throws(() => workspaceContextAttachmentsSchema.parse([{ ...exact, content: "not base64" }]));
  assert.throws(() => verifyWorkspaceContextAttachments([attachment("invalid.txt", Buffer.from([0xff]))]));
  assert.throws(() => workspaceContextAttachmentsSchema.parse([exact, { ...exact }]));
  assert.throws(() => verifyWorkspaceContextAttachments([
    attachment("a.bin", Buffer.alloc(256 * 1024), { mimeType: "application/octet-stream" }),
    attachment("b.bin", Buffer.alloc(256 * 1024), { mimeType: "application/octet-stream" }),
    attachment("c.bin", Buffer.from("x"), { mimeType: "application/octet-stream" }),
  ]), /exceed 524288/);
});

test("bounds count, names, media types, and per-file bytes", () => {
  const exact = attachment("brief.txt", "exact");
  assert.throws(() => workspaceContextAttachmentsSchema.parse(Array.from({ length: 5 }, (_, index) => ({
    ...exact,
    attachmentId: `context-${index}`,
    name: `brief-${index}.txt`,
  }))));
  assert.throws(() => workspaceContextAttachmentsSchema.parse([{ ...exact, name: "../brief.txt" }]));
  assert.throws(() => workspaceContextAttachmentsSchema.parse([{ ...exact, mimeType: "text" }]));
  assert.throws(() => workspaceContextAttachmentsSchema.parse([{ ...exact, sizeBytes: 256 * 1024 + 1 }]));
});
