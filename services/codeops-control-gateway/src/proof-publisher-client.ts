import {
  proofPublicationReceiptSchema,
  proofPublicationRequestSchema,
  type ProofPublicationReceipt,
} from "@codeops/codeops-contracts";

export type ProofPublisherClient = (
  input: unknown,
) => Promise<ProofPublicationReceipt>;

export function createProofPublisherClient(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}): ProofPublisherClient {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "http:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.pathname !== "/"
  ) {
    throw new Error(
      "proof publisher origin must be one credential-free internal HTTP origin",
    );
  }
  if (input.token.length < 32 || input.token.length > 4_096) {
    throw new Error("proof publisher token length is invalid");
  }
  const fetchImpl = input.fetch ?? fetch;

  return async (value: unknown): Promise<ProofPublicationReceipt> => {
    const request = proofPublicationRequestSchema.parse(value);
    const response = await fetchImpl(new URL("/v1/proof-publications", origin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    const receipt = proofPublicationReceiptSchema.parse(await response.json());
    if (receipt.identity.repository !== request.identity.repository) {
      throw new Error("proof publisher receipt repository does not match request");
    }
    if (
      receipt.identity.pullRequestNumber !== request.identity.pullRequestNumber
    ) {
      throw new Error("proof publisher receipt pull request does not match request");
    }
    if (receipt.identity.headSha !== request.identity.headSha) {
      throw new Error("proof publisher receipt head does not match request");
    }
    if (receipt.identity.runId !== request.identity.runId) {
      throw new Error("proof publisher receipt run does not match request");
    }
    if (receipt.destinationId !== request.expectedDestinationId) {
      throw new Error("proof publisher receipt destination does not match request");
    }
    if (response.status !== (receipt.status === "published" ? 200 : 409)) {
      throw new Error("proof publisher response status does not match receipt");
    }
    return receipt;
  };
}
