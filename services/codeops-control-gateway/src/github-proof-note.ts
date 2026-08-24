import {
  proofPublicationReceiptSchema,
  type ProofPublicationReceipt,
} from "@codeops/codeops-contracts";

type PublishedProofReceipt = Extract<
  ProofPublicationReceipt,
  { status: "published" }
>;

export type GitHubProofNoteInput = Readonly<{
  receipt: unknown;
  release: string;
  reviewerTrimStartSeconds: number;
  reviewerDurationSeconds: number;
}>;

const releasePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function requireSeconds(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function artifact(
  receipt: PublishedProofReceipt,
  kind: PublishedProofReceipt["artifacts"][number]["kind"],
): PublishedProofReceipt["artifacts"][number] {
  const selected = receipt.artifacts.find((candidate) => candidate.kind === kind);
  if (selected === undefined) {
    throw new Error(`published proof receipt is missing ${kind}`);
  }
  return selected;
}

function seconds(value: number): string {
  return value.toFixed(3);
}

export function renderGitHubProofNote(input: GitHubProofNoteInput): string {
  const receipt = proofPublicationReceiptSchema.parse(input.receipt);
  if (receipt.status !== "published") {
    throw new Error("GitHub proof notes require a published proof receipt");
  }
  if (!releasePattern.test(input.release)) {
    throw new Error("CodeOps release identity is invalid");
  }
  const trimStart = requireSeconds(
    input.reviewerTrimStartSeconds,
    "reviewer trim start",
  );
  const duration = requireSeconds(
    input.reviewerDurationSeconds,
    "reviewer duration",
  );
  if (duration === 0) {
    throw new Error("reviewer duration must be greater than zero");
  }

  const video = artifact(receipt, "reviewer-video");
  const poster = artifact(receipt, "poster");
  const packetIndex = artifact(receipt, "packet-index");
  const { identity } = receipt;
  const marker = `<!-- codeops-proof-publication:${identity.runId}:${identity.headSha} -->`;
  const linkedPoster = `[![CodeOps UI proof — click to watch the reviewer video](${poster.publicUrl})](${video.publicUrl})`;

  return [
    marker,
    "",
    "## CodeOps UI proof",
    "",
    `Qualified by CodeOps release \`${input.release}\` against exact head \`${identity.headSha}\` with run \`${identity.runId}\`.`,
    "",
    linkedPoster,
    "",
    `[Open the proof packet](${packetIndex.publicUrl})`,
    "",
    `- Reviewer video SHA-256: \`${video.sha256.slice("sha256:".length)}\``,
    `- Reviewer trim: first meaningful action at \`${seconds(trimStart)}s\`; encoded reviewer duration \`${seconds(duration)}s\``,
    `- Packet index SHA-256: \`${packetIndex.sha256.slice("sha256:".length)}\``,
    `- Retention: expires \`${receipt.expiresAt.slice(0, 10)}\``,
    "",
  ].join("\n");
}
