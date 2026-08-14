import type {
  WorkspaceContextAttachment,
  WorkspaceContextAttachmentDescriptor,
} from "@codeops/codeops-contracts/workspace-launch";

export const MAX_CONTEXT_ATTACHMENTS = 4;
export const MAX_CONTEXT_ATTACHMENT_BYTES = 256 * 1024;
export const MAX_CONTEXT_ATTACHMENTS_TOTAL_BYTES = 512 * 1024;

export async function workspaceContextAttachmentFromFile(
  file: File,
): Promise<WorkspaceContextAttachment> {
  if (file.size === 0) throw new Error(`${file.name || "Attachment"} is empty.`);
  if (file.size > MAX_CONTEXT_ATTACHMENT_BYTES) {
    throw new Error(`${file.name || "Attachment"} exceeds the 256 KiB per-file limit.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    attachmentId: `context-${crypto.randomUUID()}`,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: bytes.byteLength,
    digest: `sha256:${hex(new Uint8Array(digest))}`,
    content: base64(bytes),
  };
}

export function contextAttachmentSummary(
  attachment: WorkspaceContextAttachmentDescriptor,
): string {
  return `${attachment.mimeType} · ${formatBytes(attachment.sizeBytes)} · ${attachment.digest.slice(7, 19)}`;
}

export function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(value);
}
