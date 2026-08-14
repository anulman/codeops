import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  githubCheckLogsInputSchema,
  githubChecksInputSchema,
  githubProtectedBranchInputSchema,
  githubPullRequestDiffInputSchema,
  githubPullRequestGetInputSchema,
  githubReadResultSchema,
  githubReviewThreadsInputSchema,
  githubSearchInputSchema,
  type GitHubReadOperation,
  type SessionRuntimeDispatch,
} from "@codeops/codeops-contracts";
import type {
  RuntimeExecutionContext,
  RuntimeGitHubReadRequest,
} from "./transport.js";

const MAX_BODY_BYTES = 4 * 1_024;

const routes = new Map<string, GitHubReadOperation>([
  ["/v1/github/pull-request/get", "pull_request_get"],
  ["/v1/github/pull-request/diff", "pull_request_diff"],
  ["/v1/github/pull-request/review-threads", "review_threads"],
  ["/v1/github/checks", "checks"],
  ["/v1/github/check-logs", "check_logs"],
  ["/v1/github/protected-branch", "protected_branch"],
  ["/v1/github/search", "search"],
]);

function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function readRequest(
  dispatchId: string,
  operation: GitHubReadOperation,
  rawInput: unknown,
): RuntimeGitHubReadRequest {
  const operationId = (input: unknown) => `githubread-${createHash("sha256")
    .update(canonical({ dispatchId, operation, input }))
    .digest("hex")}`;
  switch (operation) {
    case "pull_request_get": {
      const input = githubPullRequestGetInputSchema.parse(rawInput);
      return { operation, operationId: operationId(input), input };
    }
    case "pull_request_diff": {
      const input = githubPullRequestDiffInputSchema.parse(rawInput);
      return { operation, operationId: operationId(input), input };
    }
    case "review_threads": {
      const input = githubReviewThreadsInputSchema.parse(rawInput);
      return { operation, operationId: operationId(input), input };
    }
    case "checks": {
      const input = githubChecksInputSchema.parse(rawInput);
      return { operation, operationId: operationId(input), input };
    }
    case "check_logs": {
      const input = githubCheckLogsInputSchema.parse(rawInput);
      return { operation, operationId: operationId(input), input };
    }
    case "protected_branch": {
      const input = githubProtectedBranchInputSchema.parse(rawInput);
      return { operation, operationId: operationId(input), input };
    }
    case "search": {
      const input = githubSearchInputSchema.parse(rawInput);
      return { operation, operationId: operationId(input), input };
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("GitHub read request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "content-length": String(encoded.byteLength),
  });
  response.end(encoded);
}

export class GitHubReadsBroker {
  readonly #server;
  #active:
    | {
        readonly dispatch: SessionRuntimeDispatch;
        readonly context: RuntimeExecutionContext;
      }
    | undefined;

  constructor() {
    this.#server = createServer((request, response) => {
      void this.#serve(request, response);
    });
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const operation = request.url === undefined ? undefined : routes.get(request.url);
    if (request.method !== "POST" || operation === undefined) {
      json(response, 404, { status: "not-found" });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { status: "unsupported-media-type" });
      return;
    }
    const active = this.#active;
    if (active === undefined || active.dispatch.command.type !== "prompt") {
      json(response, 409, { status: "no-active-prompt" });
      return;
    }
    try {
      json(response, 200, githubReadResultSchema.parse(
        await active.context.readGitHub(readRequest(
          active.dispatch.dispatchId,
          operation,
          await readJson(request),
        )),
      ));
    } catch {
      json(response, 503, { status: "unavailable" });
    }
  }

  async listen(port: number): Promise<number> {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error("GitHub reads broker port is invalid");
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw new Error("GitHub reads broker did not bind a TCP port");
    }
    return address.port;
  }

  async run<Result>(
    dispatch: SessionRuntimeDispatch,
    context: RuntimeExecutionContext,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#active !== undefined) throw new Error("GitHub reads broker is already active");
    this.#active = { dispatch, context };
    try {
      return await operation();
    } finally {
      this.#active = undefined;
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
