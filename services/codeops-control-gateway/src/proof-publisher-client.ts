import {
  proofPublicationReceiptSchema,
  proofPublicationRequestSchema,
  type ProofPublicationReceipt,
} from "@codeops/codeops-contracts";

export type ProofPublisherClient = (
  input: unknown,
) => Promise<ProofPublicationReceipt>;

function requirePublicBaseUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("proof publisher public base URL must be credential-free HTTPS");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function publicationPrefix(request: ReturnType<typeof proofPublicationRequestSchema.parse>): string {
  const [owner, repository] = request.identity.repository.split("/");
  return [
    owner,
    repository,
    `pull-${request.identity.pullRequestNumber}`,
    request.identity.headSha,
    request.identity.runId,
  ].join("/");
}

function expectedInputObjectKey(
  request: ReturnType<typeof proofPublicationRequestSchema.parse>,
  artifact: (typeof request.artifacts)[number],
): string {
  return `${publicationPrefix(request)}/${artifact.kind}-${artifact.sha256.slice("sha256:".length)}.${artifact.extension}`;
}

function expectedPublicUrl(publicBaseUrl: URL, objectKey: string): string {
  return new URL(encodeObjectKey(objectKey), publicBaseUrl).toString();
}

function assertArtifactBinding(input: {
  request: ReturnType<typeof proofPublicationRequestSchema.parse>;
  receipt: Extract<ProofPublicationReceipt, { status: "published" }>;
  publicBaseUrl: URL;
}): void {
  for (const index of [0, 1] as const) {
    const requested = input.request.artifacts[index];
    const returned = input.receipt.artifacts[index];
    const expectedKey = expectedInputObjectKey(input.request, requested);
    if (
      returned.kind !== requested.kind ||
      returned.mediaType !== requested.mediaType ||
      returned.byteLength !== requested.byteLength ||
      returned.sha256 !== requested.sha256 ||
      returned.objectKey !== expectedKey ||
      returned.publicUrl !== expectedPublicUrl(input.publicBaseUrl, expectedKey)
    ) {
      throw new Error(`${requested.kind} receipt does not match request`);
    }
  }
  const index = input.receipt.artifacts[2];
  const expectedIndexKey = `${publicationPrefix(input.request)}/packet-index-${index.sha256.slice("sha256:".length)}.json`;
  if (
    index.mediaType !== "application/json" ||
    index.objectKey !== expectedIndexKey ||
    index.publicUrl !== expectedPublicUrl(input.publicBaseUrl, expectedIndexKey)
  ) {
    throw new Error("packet-index receipt does not match request");
  }
}

function assertStagedObjectKeys(
  request: ReturnType<typeof proofPublicationRequestSchema.parse>,
  receipt: Extract<ProofPublicationReceipt, { status: "failed" }>,
): void {
  const exactInputKeys = new Set(request.artifacts.map((artifact) =>
    expectedInputObjectKey(request, artifact)
  ));
  const indexPattern = new RegExp(
    `^${publicationPrefix(request).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/packet-index-[a-f0-9]{64}\\.json$`,
  );
  for (const key of receipt.stagedObjectKeys) {
    if (!exactInputKeys.has(key) && !indexPattern.test(key)) {
      throw new Error("staged object key does not match request");
    }
  }
}

export function createProofPublisherClient(input: {
  readonly origin: string;
  readonly publicBaseUrl: string;
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
  const publicBaseUrl = requirePublicBaseUrl(input.publicBaseUrl);

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
    if (receipt.status === "published") {
      assertArtifactBinding({ request, receipt, publicBaseUrl });
    } else {
      assertStagedObjectKeys(request, receipt);
    }
    if (response.status !== (receipt.status === "published" ? 200 : 409)) {
      throw new Error("proof publisher response status does not match receipt");
    }
    return receipt;
  };
}
