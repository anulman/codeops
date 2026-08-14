import { createHash } from "node:crypto";
import {
  workspaceContextAttachmentsSchema,
  type WorkspaceContextAttachment,
  type WorkspaceContextAttachmentDescriptor,
} from "./workspace-launch.js";

const MAX_TOTAL_CONTEXT_BYTES = 512 * 1_024;

export function isTextContextMediaType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || [
    "application/json",
    "application/ld+json",
    "application/markdown",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
  ].includes(mimeType.toLowerCase());
}

export function decodeWorkspaceContextAttachment(
  attachment: WorkspaceContextAttachment,
): Buffer {
  const content = Buffer.from(attachment.content, "base64");
  if (content.toString("base64") !== attachment.content) {
    throw new Error("context attachment must use canonical base64");
  }
  if (content.byteLength !== attachment.sizeBytes) {
    throw new Error("context attachment byte count drifted");
  }
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== attachment.digest) {
    throw new Error("context attachment digest drifted");
  }
  if (isTextContextMediaType(attachment.mimeType)) {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  }
  return content;
}

export function verifyWorkspaceContextAttachments(
  value: unknown,
): readonly WorkspaceContextAttachment[] {
  const attachments = workspaceContextAttachmentsSchema.parse(value);
  let totalBytes = 0;
  for (const attachment of attachments) {
    totalBytes += decodeWorkspaceContextAttachment(attachment).byteLength;
    if (totalBytes > MAX_TOTAL_CONTEXT_BYTES) {
      throw new Error("context attachments exceed 524288 bytes");
    }
  }
  return attachments;
}

export function workspaceContextAttachmentDescriptors(
  value: unknown,
): readonly WorkspaceContextAttachmentDescriptor[] {
  return verifyWorkspaceContextAttachments(value).map(({ content: _content, ...descriptor }) => descriptor);
}
