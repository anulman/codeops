import type { IncomingHttpHeaders } from "node:http";
import { authenticateBearer } from "./core.js";
import {
  listSessionSnapshots,
  loadSessionEvents,
  loadSessionSnapshot,
  type TransactionClient,
} from "./session-broker-repository.js";

export interface SessionBrokerHttpResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

const sessionPath = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const eventsPath = /^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/events$/;

function authorization(headers: IncomingHttpHeaders): string | undefined {
  return typeof headers.authorization === "string"
    ? headers.authorization
    : undefined;
}

function exactInteger(
  url: URL,
  name: string,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0]!)) {
    throw new InvalidSessionReadRequestError(`${name} must be one integer`);
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InvalidSessionReadRequestError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requireOnly(url: URL, names: readonly string[]): void {
  const allowed = new Set(names);
  for (const name of url.searchParams.keys()) {
    if (!allowed.has(name)) {
      throw new InvalidSessionReadRequestError(`unknown query parameter ${name}`);
    }
  }
}

export class InvalidSessionReadRequestError extends Error {}

export async function serveSessionBrokerRead(input: {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly token: string;
  readonly database: TransactionClient;
}): Promise<SessionBrokerHttpResult | null> {
  if (input.method !== "GET" || input.url === undefined) return null;
  const url = new URL(input.url, "http://codeops.internal");
  const snapshotMatch = url.pathname.match(sessionPath);
  const eventMatch = url.pathname.match(eventsPath);
  const fleet = url.pathname === "/v1/sessions";
  if (!fleet && snapshotMatch === null && eventMatch === null) return null;

  if (!authenticateBearer(authorization(input.headers), input.token)) {
    return { status: 401, body: { status: "unauthorized" } };
  }

  if (fleet) {
    requireOnly(url, ["limit"]);
    const limit = exactInteger(url, "limit", 100, 200);
    return {
      status: 200,
      body: {
        version: "codeops.session-fleet/v1",
        sessions: await listSessionSnapshots(input.database, limit),
      },
    };
  }

  if (snapshotMatch !== null) {
    requireOnly(url, []);
    const session = await loadSessionSnapshot(
      input.database,
      snapshotMatch[1]!,
    );
    return session === null
      ? { status: 404, body: { status: "not-found" } }
      : {
          status: 200,
          body: { version: "codeops.session-detail/v1", session },
        };
  }

  requireOnly(url, ["afterCursor", "limit"]);
  const afterCursor = exactInteger(url, "afterCursor", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = exactInteger(url, "limit", 100, 500);
  const events = await loadSessionEvents(input.database, {
    sessionId: eventMatch![1]!,
    afterCursor,
    limit,
  });
  return {
    status: 200,
    body: {
      version: "codeops.session-events/v1",
      sessionId: eventMatch![1]!,
      afterCursor,
      nextCursor: events.at(-1)?.cursor ?? afterCursor,
      events,
    },
  };
}
