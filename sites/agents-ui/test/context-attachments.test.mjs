import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { File } from "node:buffer";
import test from "node:test";
import {
  contextAttachmentSummary,
  workspaceContextAttachmentFromFile,
} from "../src/lib/contextAttachments.ts";

test("binds a browser-selected file to exact canonical bytes and SHA-256", async () => {
  const bytes = Buffer.from("Exact UI context.\n", "utf8");
  const attachment = await workspaceContextAttachmentFromFile(
    new File([bytes], "brief.txt", { type: "text/plain" }),
  );
  assert.equal(attachment.name, "brief.txt");
  assert.equal(attachment.mimeType, "text/plain");
  assert.equal(attachment.sizeBytes, bytes.byteLength);
  assert.equal(attachment.content, bytes.toString("base64"));
  assert.equal(
    attachment.digest,
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  assert.match(contextAttachmentSummary(attachment), /^text\/plain · 18 B · [0-9a-f]{12}$/);
});

test("rejects empty and oversized browser-selected files before launch", async () => {
  await assert.rejects(
    workspaceContextAttachmentFromFile(new File([], "empty.txt", { type: "text/plain" })),
    /empty/,
  );
  await assert.rejects(
    workspaceContextAttachmentFromFile(new File([Buffer.alloc(256 * 1024 + 1)], "large.bin")),
    /256 KiB/,
  );
});
