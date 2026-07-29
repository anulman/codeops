import type {
  AgentJobDispatchResult,
} from "@renoconcierge/codeops-contracts";
import type {
  AdversarialReview,
} from "@renoconcierge/codeops-contracts/adversarial-review";

export function adversarialReviewMatchesCheckpoint(input: {
  readonly review: AdversarialReview;
  readonly workflowId: string;
  readonly workItemId: string;
  readonly baseSha: string;
  readonly checkpoint: AgentJobDispatchResult | null;
}): boolean {
  return input.checkpoint?.role === "coding-agent"
    && input.review.workflowId === input.workflowId
    && input.review.workItemId === input.workItemId
    && input.review.baseSha === input.baseSha
    && input.review.checkpoint.uri === input.checkpoint.checkpointUri
    && input.review.checkpoint.digest === input.checkpoint.checkpointDigest
    && input.review.checkpoint.sizeBytes === input.checkpoint.checkpointSizeBytes;
}
