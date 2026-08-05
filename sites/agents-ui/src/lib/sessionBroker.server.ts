import { readFile } from "node:fs/promises";
import {
  sessionCommandSchema,
  sessionCommandSubmissionSchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  type SessionCommand,
  type SessionCommandSubmission,
  type SessionEvent,
  type SessionSnapshot,
} from "@renoconcierge/codeops-contracts/session-broker";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const limit = (maximum: number) =>
  z.number().int().min(1).max(maximum);

const fleetResponseSchema = z
  .object({
    version: z.literal("codeops.session-fleet/v1"),
    sessions: z.array(sessionSnapshotSchema).max(200),
  })
  .strict();
const detailResponseSchema = z
  .object({
    version: z.literal("codeops.session-detail/v1"),
    session: sessionSnapshotSchema,
  })
  .strict();
const eventsResponseSchema = z
  .object({
    version: z.literal("codeops.session-events/v1"),
    sessionId: identifier,
    afterCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    events: z.array(sessionEventSchema).max(500),
  })
  .strict()
  .superRefine((page, context) => {
    for (const [index, event] of page.events.entries()) {
      if (
        event.sessionId !== page.sessionId ||
        event.cursor !== page.afterCursor + index + 1
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "session events must be contiguous and identity-bound",
          path: ["events", index],
        });
      }
    }
    const expectedNext = page.events.at(-1)?.cursor ?? page.afterCursor;
    if (page.nextCursor !== expectedNext) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session event page has an invalid next cursor",
        path: ["nextCursor"],
      });
    }
  });

export interface SessionEventPage {
  readonly sessionId: string;
  readonly afterCursor: number;
  readonly nextCursor: number;
  readonly events: readonly SessionEvent[];
}

export interface SessionBrokerClient {
  listSessions(limit?: number): Promise<readonly SessionSnapshot[]>;
  getSession(sessionId: string): Promise<SessionSnapshot | null>;
  getEvents(input: {
    readonly sessionId: string;
    readonly afterCursor?: number;
    readonly limit?: number;
  }): Promise<SessionEventPage>;
  executeCommand(input: {
    readonly command: SessionCommand;
    readonly principalId: string;
  }): Promise<SessionCommandSubmission>;
}

export function parseSessionBrokerBaseUrl(
  value: string,
  nodeEnv = process.env.NODE_ENV,
): URL {
  const url = new URL(value);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "8080")
  ) {
    throw new Error("session broker URL must be one exact service origin");
  }
  const productionHttpHost =
    url.hostname === "codeops-control-gateway" ||
    url.hostname.endsWith(".svc.cluster.local");
  const developmentHttpHost =
    nodeEnv !== "production" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      productionHttpHost);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (productionHttpHost || developmentHttpHost))
  ) {
    throw new Error("session broker URL requires HTTPS or the cluster service");
  }
  return url;
}

export function createSessionBrokerClient(input: {
  readonly baseUrl: URL;
  readonly readToken: string;
  readonly writeToken: string;
  readonly fetch?: typeof fetch;
}): SessionBrokerClient {
  for (const [purpose, token] of [["read", input.readToken], ["write", input.writeToken]] as const) {
    if (token.length < 32 || token.length > 4_096) {
      throw new Error(`session broker ${purpose} token length is invalid`);
    }
  }
  if (input.readToken === input.writeToken) {
    throw new Error("session broker read and write tokens must be distinct");
  }
  const request = async (
    path: string,
    options: {
      readonly method?: "GET" | "POST";
      readonly token?: string;
      readonly principalId?: string;
      readonly body?: string;
      readonly allowMissing?: boolean;
    } = {},
  ): Promise<unknown> => {
    const response = await (input.fetch ?? fetch)(new URL(path, input.baseUrl), {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.token ?? input.readToken}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.principalId === undefined ? {} : { "X-CodeOps-Principal": options.principalId }),
      },
      body: options.body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (options.allowMissing && response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`session broker returned status ${response.status}`);
    }
    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      throw new Error("session broker response is not JSON");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("session broker response exceeds the size limit");
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      throw new Error("session broker response exceeds the size limit");
    }
    return JSON.parse(body);
  };

  return {
    async listSessions(readLimit = 100) {
      const parsedLimit = limit(200).parse(readLimit);
      const response = fleetResponseSchema.parse(
        await request(`/v1/sessions?limit=${parsedLimit}`),
      );
      return response.sessions;
    },
    async getSession(sessionId) {
      const parsedSessionId = identifier.parse(sessionId);
      const body = await request(`/v1/sessions/${parsedSessionId}`, {
        allowMissing: true,
      });
      if (body === null) return null;
      const response = detailResponseSchema.parse(body);
      if (response.session.sessionId !== parsedSessionId) {
        throw new Error("session broker returned the wrong session identity");
      }
      return response.session;
    },
    async getEvents({ sessionId, afterCursor = 0, limit: readLimit = 100 }) {
      const parsedSessionId = identifier.parse(sessionId);
      const parsedCursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(afterCursor);
      const parsedLimit = limit(500).parse(readLimit);
      const response = eventsResponseSchema.parse(
        await request(
          `/v1/sessions/${parsedSessionId}/events?afterCursor=${parsedCursor}&limit=${parsedLimit}`,
        ),
      );
      if (response.sessionId !== parsedSessionId || response.afterCursor !== parsedCursor) {
        throw new Error("session broker returned the wrong event page identity");
      }
      return response;
    },
    async executeCommand({ command, principalId }) {
      const parsedCommand = sessionCommandSchema.parse(command);
      const parsedPrincipal = z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
        .parse(principalId);
      const result = sessionCommandSubmissionSchema.parse(
        await request(`/v1/sessions/${parsedCommand.sessionId}/commands`, {
          method: "POST",
          token: input.writeToken,
          principalId: parsedPrincipal,
          body: JSON.stringify(parsedCommand),
        }),
      );
      if (
        result.sessionId !== parsedCommand.sessionId ||
        result.generation !== parsedCommand.generation ||
        result.leaseId !== parsedCommand.leaseId ||
        result.idempotencyKey !== parsedCommand.idempotencyKey ||
        result.type !== parsedCommand.type
      ) {
        throw new Error("session broker returned the wrong command identity");
      }
      return result;
    },
  };
}

let client: Promise<SessionBrokerClient> | null = null;

export function sessionBrokerClient(): Promise<SessionBrokerClient> {
  client ??= (async () => {
    const tokenPath = process.env.CODEOPS_SESSION_BROKER_READ_TOKEN_FILE?.trim();
    const writeTokenPath = process.env.CODEOPS_SESSION_BROKER_WRITE_TOKEN_FILE?.trim();
    const baseUrl = process.env.CODEOPS_SESSION_BROKER_URL?.trim();
    if (!tokenPath || !writeTokenPath || !baseUrl) {
      throw new Error("session broker server configuration is incomplete");
    }
    const [readToken, writeToken] = await Promise.all([
      readFile(tokenPath, "utf8").then((value) => value.trim()),
      readFile(writeTokenPath, "utf8").then((value) => value.trim()),
    ]);
    return createSessionBrokerClient({
      baseUrl: parseSessionBrokerBaseUrl(baseUrl),
      readToken,
      writeToken,
    });
  })().catch((error) => {
    client = null;
    throw error;
  });
  return client;
}
