import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import {
  canonicalJsonBytes,
  proofPublicationReceiptSchema,
  proofPublicationRequestSchema,
  type ProofPublicationArtifactInput,
  type ProofPublicationArtifactReceipt,
  type ProofPublicationReceipt,
  type ProofPublicationRequest,
} from "@codeops/codeops-contracts";

export type S3ProofPublisherConfig = {
  destinationId: string;
  endpoint: string;
  publicBaseUrl: string;
  bucket: string;
  region: string;
  retentionDays: number;
  accessKeyId: string;
  secretAccessKey: string;
};

export type S3Response = {
  status: number;
  headers: Headers;
};

export type S3Transport = {
  head(objectKey: string): Promise<S3Response>;
  put(objectKey: string, body: Uint8Array, headers: Headers): Promise<S3Response>;
};

type Dependencies = {
  transport: S3Transport;
  now?: () => Date;
};

type PreparedArtifact = {
  kind: "reviewer-video" | "poster" | "packet-index";
  extension: "mp4" | "png" | "jpg" | "json";
  mediaType: "video/mp4" | "image/png" | "image/jpeg" | "application/json";
  bytes: Uint8Array;
  sha256: `sha256:${string}`;
};

function requireHttpsUrl(value: string, name: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return parsed;
}

function requireSegment(value: string, name: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${name} must be a canonical path segment`);
  }
  return value;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeArtifact(artifact: ProofPublicationArtifactInput): PreparedArtifact {
  const bytes = Buffer.from(artifact.bytesBase64, "base64");
  if (bytes.toString("base64") !== artifact.bytesBase64) {
    throw new Error(`${artifact.kind} bytes are not canonical base64`);
  }
  if (bytes.byteLength !== artifact.byteLength) {
    throw new Error(`${artifact.kind} byte length does not match`);
  }
  if (sha256(bytes) !== artifact.sha256) {
    throw new Error(`${artifact.kind} digest does not match`);
  }
  return {
    kind: artifact.kind,
    extension: artifact.extension,
    mediaType: artifact.mediaType,
    bytes,
    sha256: artifact.sha256,
  };
}

function objectKey(request: ProofPublicationRequest, artifact: PreparedArtifact): string {
  const [owner, repository] = request.identity.repository.split("/");
  return [
    requireSegment(owner!, "repository owner"),
    requireSegment(repository!, "repository name"),
    `pull-${request.identity.pullRequestNumber}`,
    request.identity.headSha,
    requireSegment(request.identity.runId, "run ID"),
    `${artifact.kind}-${artifact.sha256.slice("sha256:".length)}.${artifact.extension}`,
  ].join("/");
}

function publicUrl(config: S3ProofPublisherConfig, key: string): string {
  const base = requireHttpsUrl(config.publicBaseUrl, "public base URL");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(encodeObjectKey(key), base).toString();
}

function contentDisposition(artifact: PreparedArtifact): string {
  const name = artifact.kind === "reviewer-video"
    ? "reviewer-video.mp4"
    : artifact.kind === "poster"
      ? `poster.${artifact.extension}`
      : "packet-index.json";
  return `inline; filename="${name}"`;
}

function expectedHeaders(artifact: PreparedArtifact): Headers {
  return new Headers({
    "cache-control": "public, max-age=31536000, immutable",
    "content-disposition": contentDisposition(artifact),
    "content-length": String(artifact.bytes.byteLength),
    "content-type": artifact.mediaType,
    "if-none-match": "*",
    "x-amz-acl": "public-read",
    "x-amz-meta-codeops-sha256": artifact.sha256,
  });
}

function verifyHead(response: S3Response, artifact: PreparedArtifact): string {
  if (response.status !== 200) throw new Error(`object verification returned HTTP ${response.status}`);
  if (response.headers.get("content-length") !== String(artifact.bytes.byteLength)) {
    throw new Error("object verification found byte-length drift");
  }
  if (response.headers.get("content-type") !== artifact.mediaType) {
    throw new Error("object verification found media-type drift");
  }
  if (response.headers.get("x-amz-meta-codeops-sha256") !== artifact.sha256) {
    throw new Error("object verification found digest drift");
  }
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("object verification did not return an ETag");
  return etag;
}

async function publishArtifact(
  config: S3ProofPublisherConfig,
  request: ProofPublicationRequest,
  artifact: PreparedArtifact,
  transport: S3Transport,
): Promise<ProofPublicationArtifactReceipt> {
  const key = objectKey(request, artifact);
  const existing = await transport.head(key);
  let etag: string;
  if (existing.status === 200) {
    etag = verifyHead(existing, artifact);
  } else if (existing.status === 404) {
    const uploaded = await transport.put(key, artifact.bytes, expectedHeaders(artifact));
    if (![200, 201, 204, 412].includes(uploaded.status)) {
      throw new Error(`object upload returned HTTP ${uploaded.status}`);
    }
    etag = verifyHead(await transport.head(key), artifact);
  } else {
    throw new Error(`object preflight returned HTTP ${existing.status}`);
  }
  return {
    kind: artifact.kind,
    objectKey: key,
    publicUrl: publicUrl(config, key),
    mediaType: artifact.mediaType,
    byteLength: artifact.bytes.byteLength,
    sha256: artifact.sha256,
    etag,
  };
}

function failure(
  config: S3ProofPublisherConfig,
  request: ProofPublicationRequest,
  code: Extract<ProofPublicationReceipt, { status: "failed" }>['code'],
  retryable: boolean,
): ProofPublicationReceipt {
  return proofPublicationReceiptSchema.parse({
    version: "codeops.proof-publication-receipt/v1",
    plugin: "codeops.proof-publisher.s3/v1",
    status: "failed",
    destinationId: config.destinationId,
    identity: request.identity,
    code,
    retryable,
  });
}

export function createS3ProofPublisher(config: S3ProofPublisherConfig, dependencies: Dependencies) {
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) {
    throw new Error("retention days must be an integer from 1 through 3650");
  }
  requireHttpsUrl(config.endpoint, "S3 endpoint");
  requireHttpsUrl(config.publicBaseUrl, "public base URL");
  requireSegment(config.bucket, "bucket");
  const now = dependencies.now ?? (() => new Date());

  return async (input: unknown): Promise<ProofPublicationReceipt> => {
    const parsed = proofPublicationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("proof publication request is invalid");
    }
    const request = parsed.data;
    if (request.expectedDestinationId !== config.destinationId) {
      return failure(config, request, "destination_mismatch", false);
    }
    if (request.classification !== "sanitized-public") {
      return failure(config, request, "sensitive_proof", false);
    }

    let artifacts: PreparedArtifact[];
    try {
      artifacts = request.artifacts.map(decodeArtifact);
    } catch {
      return failure(config, request, "artifact_invalid", false);
    }

    try {
      const video = await publishArtifact(config, request, artifacts[0]!, dependencies.transport);
      const poster = await publishArtifact(config, request, artifacts[1]!, dependencies.transport);
      const indexBytes = canonicalJsonBytes({
        version: "codeops.proof-publication-index/v1",
        plugin: request.plugin,
        destinationId: config.destinationId,
        identity: request.identity,
        classification: request.classification,
        artifacts: [video, poster],
      });
      const indexArtifact: PreparedArtifact = {
        kind: "packet-index",
        extension: "json",
        mediaType: "application/json",
        bytes: indexBytes,
        sha256: sha256(indexBytes),
      };
      const index = await publishArtifact(config, request, indexArtifact, dependencies.transport);
      const expiresAt = new Date(now().getTime() + config.retentionDays * 86_400_000).toISOString();
      return proofPublicationReceiptSchema.parse({
        version: "codeops.proof-publication-receipt/v1",
        plugin: "codeops.proof-publisher.s3/v1",
        status: "published",
        destinationId: config.destinationId,
        identity: request.identity,
        artifacts: [video, poster, index],
        expiresAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/drift|conflict/i.test(message)) return failure(config, request, "object_conflict", false);
      if (/verification|ETag/i.test(message)) return failure(config, request, "verification_failed", true);
      return failure(config, request, "upload_failed", true);
    }
  };
}

export function createAwsS3Transport(
  config: S3ProofPublisherConfig,
  fetchImpl: typeof fetch = fetch,
): S3Transport {
  const endpoint = requireHttpsUrl(config.endpoint, "S3 endpoint");
  const bucket = requireSegment(config.bucket, "bucket");
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
    retries: 2,
    initRetryMs: 100,
  });
  const request = async (method: "HEAD" | "PUT", key: string, body?: Uint8Array, headers?: Headers) => {
    const url = new URL(`${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`, endpoint);
    const signed = await client.sign(url, { method, body, headers });
    const response = await fetchImpl(signed, { signal: AbortSignal.timeout(30_000) });
    return { status: response.status, headers: response.headers };
  };
  return {
    head: (key) => request("HEAD", key),
    put: (key, body, headers) => request("PUT", key, body, headers),
  };
}
