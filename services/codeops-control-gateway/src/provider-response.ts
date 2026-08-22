const MAX_PROVIDER_ERROR_BYTES = 4 * 1_024;
const PROVIDER_TIMEOUT_MS = 30_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export interface ProviderResponseBody {
  readonly status: number;
  readonly bytes: Uint8Array;
}

type ProviderMediaType =
  | "json"
  | "text"
  | "application/vnd.github.diff"
  | "application/octet-stream";

async function cancelBody(response: Response): Promise<void> {
  if (response.body !== null && !response.body.locked) {
    await response.body.cancel();
  }
}

function contentLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("provider response Content-Length is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("provider response Content-Length is invalid");
  }
  return parsed;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  let declaredLength: number | null;
  try {
    declaredLength = contentLength(response);
  } catch (error) {
    await cancelBody(response);
    throw error;
  }
  if (declaredLength !== null && declaredLength > maxBytes) {
    await cancelBody(response);
    throw new Error(`provider response exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`provider response exceeds ${maxBytes} bytes`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function mediaTypeMatches(actual: string, expected: ProviderMediaType): boolean {
  if (expected === "json") {
    return actual === "application/json" ||
      (actual.startsWith("application/") && actual.endsWith("+json"));
  }
  if (expected === "text") return actual.startsWith("text/");
  return actual === expected;
}

function requireMediaType(
  response: Response,
  expected: readonly ProviderMediaType[],
): void {
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "" || !expected.some((item) => mediaTypeMatches(mediaType, item))) {
    throw new Error("provider response media type is invalid");
  }
}

function checkLogRedirect(location: string | null): URL {
  if (location === null) {
    throw new Error("GitHub check-log redirect is missing");
  }
  const redirect = new URL(location);
  if (
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  ) {
    throw new Error("GitHub check-log redirect is unsafe");
  }
  return redirect;
}

export async function readProviderResponse(input: {
  readonly fetch: typeof fetch;
  readonly url: URL | string;
  readonly init?: RequestInit;
  readonly maxBytes: number;
  readonly statuses: readonly number[];
  readonly mediaTypes: readonly ProviderMediaType[];
  readonly allowGitHubCheckLogRedirect?: boolean;
  readonly timeoutMs?: number;
}): Promise<ProviderResponseBody> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
    throw new Error("provider response byte limit is invalid");
  }
  const timeoutMs = input.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("provider response timeout is invalid");
  }
  const controller = new AbortController();
  const timeoutError = new DOMException(
    "provider response deadline exceeded",
    "TimeoutError",
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const read = async (): Promise<ProviderResponseBody> => {
    let response = await input.fetch(input.url, {
      ...input.init,
      redirect: "manual",
      signal: controller.signal,
    });
    if (redirectStatuses.has(response.status)) {
      if (!input.allowGitHubCheckLogRedirect) {
        await cancelBody(response);
        throw new Error("provider response redirect is not allowed");
      }
      const redirect = checkLogRedirect(response.headers.get("location"));
      await cancelBody(response);
      response = await input.fetch(redirect, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
      if (redirectStatuses.has(response.status)) {
        await cancelBody(response);
        throw new Error("provider response redirect limit exceeded");
      }
    }

    if (!input.statuses.includes(response.status)) {
      try {
        await readBoundedBytes(response, MAX_PROVIDER_ERROR_BYTES);
      } catch {
        // The error response is still bounded and never exposed.
      }
      throw new Error(`provider request failed with HTTP ${response.status}`);
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      await cancelBody(response);
      return { status: response.status, bytes: new Uint8Array() };
    }
    try {
      requireMediaType(response, input.mediaTypes);
    } catch (error) {
      await cancelBody(response);
      throw error;
    }
    return {
      status: response.status,
      bytes: await readBoundedBytes(response, input.maxBytes),
    };
  };
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function decodeProviderResponseText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("provider response is not valid UTF-8", { cause: error });
  }
}
