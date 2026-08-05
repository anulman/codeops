import * as acp from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { SessionRuntimeDispatch } from "@renoconcierge/codeops-contracts";
import type {
  AcpWorkspaceLifecycle,
} from "./lifecycle.js";
import type { RuntimeExecutionResult } from "./transport.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 2_000_000;

type PromptDispatch = SessionRuntimeDispatch & {
  readonly command: Extract<
    SessionRuntimeDispatch["command"],
    { readonly type: "prompt" }
  >;
};

export interface AcpPermissionRelay {
  request(
    dispatch: PromptDispatch,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse>;
}

interface StoredAcpState {
  readonly version: "codeops.acp-session-state/v1";
  readonly sessions: Readonly<Record<string, string>>;
}

export interface AcpAgentSessionConnection {
  newSession(cwd: string): Promise<string>;
  loadSession(sessionId: string, cwd: string): Promise<void>;
  prompt(sessionId: string, prompt: string): Promise<void>;
  forkSession(sessionId: string, cwd: string): Promise<string>;
}

export type AcpConnectionFactory = <Result>(
  dispatch: SessionRuntimeDispatch,
  operation: (agent: AcpAgentSessionConnection) => Promise<Result>,
) => Promise<Result>;

function boundedAbsolutePath(name: string, raw: string): string {
  if (!path.isAbsolute(raw) || raw.length > 1_000 || raw.includes("\0")) {
    throw new Error(`${name} must be one bounded absolute path`);
  }
  return path.normalize(raw);
}

async function connectSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unavailable";
  do {
    const socket = net.createConnection(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    } catch (error) {
      socket.destroy();
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      lastError = error instanceof Error ? error.message : String(error);
      if (Date.now() >= deadline) break;
      await delay(100);
    }
  } while (Date.now() < deadline);
  throw new Error(
    `ACP socket was not ready within ${timeoutMs}ms: ${lastError}`,
  );
}

function emptyState(): StoredAcpState {
  return { version: "codeops.acp-session-state/v1", sessions: {} };
}

function parseState(raw: unknown): StoredAcpState {
  if (
    raw === null ||
    typeof raw !== "object" ||
    (raw as { version?: unknown }).version !==
      "codeops.acp-session-state/v1" ||
    (raw as { sessions?: unknown }).sessions === null ||
    typeof (raw as { sessions?: unknown }).sessions !== "object" ||
    Array.isArray((raw as { sessions?: unknown }).sessions)
  ) {
    throw new Error("ACP session state is invalid");
  }
  const sessions = Object.fromEntries(
    Object.entries(
      (raw as { sessions: Record<string, unknown> }).sessions,
    ).map(([sessionId, acpSessionId]) => {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId) ||
        typeof acpSessionId !== "string" ||
        acpSessionId.length < 1 ||
        acpSessionId.length > 500
      ) {
        throw new Error("ACP session state contains invalid identity");
      }
      return [sessionId, acpSessionId];
    }),
  );
  return { version: "codeops.acp-session-state/v1", sessions };
}

export class AcpSessionStateStore {
  readonly #statePath: string;

  constructor(statePath: string) {
    this.#statePath = boundedAbsolutePath("ACP state path", statePath);
  }

  async read(): Promise<StoredAcpState> {
    try {
      return parseState(JSON.parse(await readFile(this.#statePath, "utf8")));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        String(error.code) === "ENOENT"
      ) {
        return emptyState();
      }
      throw error;
    }
  }

  async get(sessionId: string): Promise<string | null> {
    return (await this.read()).sessions[sessionId] ?? null;
  }

  async set(sessionId: string, acpSessionId: string): Promise<void> {
    const current = await this.read();
    const next = parseState({
      ...current,
      sessions: { ...current.sessions, [sessionId]: acpSessionId },
    });
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#statePath);
  }
}

export async function captureWorkspacePatch(workspace: string): Promise<Buffer> {
  const root = boundedAbsolutePath("workspace", workspace);
  const git = ["-c", `safe.directory=${root}`, "-C", root];
  await execFileAsync("git", [...git, "add", "--intent-to-add", "--all", "--"], {
    encoding: "buffer",
    maxBuffer: MAX_PATCH_BYTES + 1,
  });
  const { stdout } = await execFileAsync(
    "git",
    [...git, "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
    { encoding: "buffer", maxBuffer: MAX_PATCH_BYTES + 1 },
  );
  if (stdout.length > MAX_PATCH_BYTES) {
    throw new Error("ACP workspace patch exceeds 2000000 bytes");
  }
  return stdout;
}

export class SocketAcpWorkspaceLifecycle implements AcpWorkspaceLifecycle {
  readonly #socketPath: string;
  readonly #workspace: string;
  readonly #state: AcpSessionStateStore;
  readonly #permissions: AcpPermissionRelay;
  readonly #socketTimeoutMs: number;
  readonly #connect: AcpConnectionFactory;
  readonly #now: () => Date;
  readonly #uuid: () => string;

  constructor(input: {
    readonly socketPath: string;
    readonly workspace: string;
    readonly statePath: string;
    readonly permissions: AcpPermissionRelay;
    readonly socketTimeoutMs?: number;
    readonly now?: () => Date;
    readonly uuid?: () => string;
    readonly connect?: AcpConnectionFactory;
  }) {
    this.#socketPath = boundedAbsolutePath("ACP socket path", input.socketPath);
    this.#workspace = boundedAbsolutePath("workspace", input.workspace);
    this.#state = new AcpSessionStateStore(input.statePath);
    this.#permissions = input.permissions;
    this.#socketTimeoutMs = input.socketTimeoutMs ?? 30_000;
    this.#now = input.now ?? (() => new Date());
    this.#uuid = input.uuid ?? randomUUID;
    if (
      !Number.isSafeInteger(this.#socketTimeoutMs) ||
      this.#socketTimeoutMs < 1_000 ||
      this.#socketTimeoutMs > 60_000
    ) {
      throw new Error("ACP socket timeout must be between 1 and 60 seconds");
    }
    this.#connect = input.connect ?? ((dispatch, operation) =>
      this.#connectSocketAgent(dispatch, operation));
  }

  async #connectSocketAgent<Result>(
    dispatch: SessionRuntimeDispatch,
    operation: (agent: AcpAgentSessionConnection) => Promise<Result>,
  ): Promise<Result> {
    const socket = await connectSocket(this.#socketPath, this.#socketTimeoutMs);
    const stream = acp.ndJsonStream(
      Writable.toWeb(socket),
      Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    );
    try {
      return await acp
        .client({ name: "renoconcierge-session-runtime-worker" })
        .onRequest(
          acp.methods.client.session.requestPermission,
          async ({ params }) => {
            if (dispatch.command.type !== "prompt") {
              return { outcome: { outcome: "cancelled" } };
            }
            return this.#permissions.request(dispatch as PromptDispatch, params);
          },
        )
        .onNotification(acp.methods.client.session.update, () => {})
        .connectWith(stream, async (agent) => {
          await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: {
              name: "renoconcierge-session-runtime-worker",
              version: "0.1.0",
            },
          });
          return operation({
            newSession: async (cwd) =>
              (await agent.request(acp.methods.agent.session.new, {
                cwd,
                mcpServers: [],
              })).sessionId,
            loadSession: async (sessionId, cwd) => {
              await agent.request(acp.methods.agent.session.load, {
                sessionId,
                cwd,
                mcpServers: [],
              });
            },
            prompt: async (sessionId, prompt) => {
              await agent.request(acp.methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: "text", text: prompt }],
              });
            },
            forkSession: async (sessionId, cwd) =>
              (await agent.request(acp.methods.agent.session.fork, {
                sessionId,
                cwd,
                mcpServers: [],
              })).sessionId,
          });
        });
    } finally {
      socket.destroy();
    }
  }

  async #activeAcpSession(
    dispatch: SessionRuntimeDispatch,
    agent: AcpAgentSessionConnection,
  ): Promise<string> {
    const brokerSessionId = dispatch.command.sessionId;
    const stored =
      (await this.#state.get(brokerSessionId)) ??
      dispatch.snapshot.checkpoint?.acpSessionId ??
      null;
    if (stored !== null) {
      await agent.loadSession(stored, this.#workspace);
      await this.#state.set(brokerSessionId, stored);
      return stored;
    }
    const created = await agent.newSession(this.#workspace);
    await this.#state.set(brokerSessionId, created);
    return created;
  }

  async prompt(dispatch: PromptDispatch): Promise<RuntimeExecutionResult> {
    await this.#connect(dispatch, async (agent) => {
      const sessionId = await this.#activeAcpSession(dispatch, agent);
      await agent.prompt(sessionId, dispatch.command.prompt);
    });
    return { type: "prompt" };
  }

  async #checkpoint(
    dispatch: SessionRuntimeDispatch,
    type: "checkpoint" | "hibernate",
  ): Promise<RuntimeExecutionResult> {
    const acpSessionId =
      (await this.#state.get(dispatch.command.sessionId)) ??
      dispatch.snapshot.checkpoint?.acpSessionId ??
      null;
    if (acpSessionId === null) {
      throw new Error("checkpoint requires one established ACP session");
    }
    const patch = await captureWorkspacePatch(this.#workspace);
    const patchDigest = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
    return {
      type,
      material: {
        checkpointId: this.#uuid(),
        patchDigest,
        acpSessionId,
        evidenceReferences: [`patch-${patchDigest.slice(7, 23)}`],
      },
    };
  }

  checkpoint(dispatch: SessionRuntimeDispatch): Promise<RuntimeExecutionResult> {
    return this.#checkpoint(dispatch, "checkpoint");
  }

  hibernate(dispatch: SessionRuntimeDispatch): Promise<RuntimeExecutionResult> {
    return this.#checkpoint(dispatch, "hibernate");
  }

  async resume(dispatch: SessionRuntimeDispatch): Promise<RuntimeExecutionResult> {
    const acpSessionId = dispatch.snapshot.checkpoint?.acpSessionId;
    if (!acpSessionId) throw new Error("resume requires an ACP checkpoint");
    await this.#connect(dispatch, async (agent) => {
      await agent.loadSession(acpSessionId, this.#workspace);
    });
    await this.#state.set(dispatch.command.sessionId, acpSessionId);
    const acquiredAt = this.#now();
    return {
      type: "resume",
      material: {
        leaseId: this.#uuid(),
        holderId: `session-runtime:${dispatch.command.sessionId}`,
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: new Date(acquiredAt.getTime() + 60 * 60_000).toISOString(),
      },
    };
  }

  async fork(dispatch: SessionRuntimeDispatch): Promise<RuntimeExecutionResult> {
    const parentAcpSessionId = dispatch.snapshot.checkpoint?.acpSessionId;
    if (!parentAcpSessionId) throw new Error("fork requires an ACP checkpoint");
    const childBrokerSessionId = `ses_${this.#uuid().replaceAll("-", "")}`;
    const childAcpSessionId = await this.#connect(dispatch, (agent) =>
      agent.forkSession(parentAcpSessionId, this.#workspace));
    await this.#state.set(childBrokerSessionId, childAcpSessionId);
    const acquiredAt = this.#now();
    const suffix = childBrokerSessionId.slice(-12).toLowerCase();
    return {
      type: "fork",
      material: {
        sessionId: childBrokerSessionId,
        branch: `${dispatch.snapshot.identity.branch}-fork-${suffix}`,
        workflowId: `fork-${suffix}`,
        runId: `fork-${suffix}`,
        leaseId: this.#uuid(),
        holderId: `session-runtime:${childBrokerSessionId}`,
        acquiredAt: acquiredAt.toISOString(),
        expiresAt: new Date(acquiredAt.getTime() + 60 * 60_000).toISOString(),
      },
    };
  }
}
