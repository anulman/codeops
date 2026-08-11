import type {
  AgentJobDispatchResult,
} from "@codeops/codeops-contracts";
import type {
  AdversarialReview,
  CandidateCheckpoint,
} from "@codeops/codeops-contracts/adversarial-review";

export const MAX_CODING_ROUNDS = 4;

export function candidateCheckpointFromDispatch(
  checkpoint: AgentJobDispatchResult,
  round: number,
): CandidateCheckpoint {
  if (checkpoint.role !== "coding-agent") {
    throw new Error("candidate checkpoint must come from a coding Agent Job");
  }
  return {
    round,
    runId: checkpoint.runId,
    checkpoint: {
      uri: checkpoint.checkpointUri,
      digest: checkpoint.checkpointDigest,
      sizeBytes: checkpoint.checkpointSizeBytes,
    },
    patch: {
      uri: checkpoint.patchUri,
      digest: checkpoint.patchDigest,
      sizeBytes: checkpoint.patchSizeBytes,
    },
    codingOutcome:
      checkpoint.codingOutcome ??
      (() => {
        throw new Error(
          "autonomous coding checkpoint must retain structured passing test evidence",
        );
      })(),
  };
}

export function adversarialReviewMatchesCandidate(input: {
  readonly review: AdversarialReview;
  readonly workflowId: string;
  readonly workItemId: string;
  readonly baseSha: string;
  readonly candidate: CandidateCheckpoint;
}): boolean {
  return input.review.workflowId === input.workflowId
    && input.review.workItemId === input.workItemId
    && input.review.baseSha === input.baseSha
    && input.review.candidate.round === input.candidate.round
    && input.review.candidate.runId === input.candidate.runId
    && input.review.candidate.checkpoint.uri ===
      input.candidate.checkpoint.uri
    && input.review.candidate.checkpoint.digest ===
      input.candidate.checkpoint.digest
    && input.review.candidate.checkpoint.sizeBytes ===
      input.candidate.checkpoint.sizeBytes
    && input.review.candidate.patch.uri === input.candidate.patch.uri
    && input.review.candidate.patch.digest === input.candidate.patch.digest
    && input.review.candidate.patch.sizeBytes ===
      input.candidate.patch.sizeBytes
    && JSON.stringify(input.review.candidate.codingOutcome) ===
      JSON.stringify(input.candidate.codingOutcome);
}

export function criticLoopAction(input: {
  readonly review: AdversarialReview;
  readonly round: number;
}): "accept" | "revise" | "exhausted" {
  if (input.review.verdict === "pass") return "accept";
  return input.round >= MAX_CODING_ROUNDS ? "exhausted" : "revise";
}
