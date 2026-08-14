import * as acp from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  sessionPermissionOperationSchema,
  sessionTimelineUpdateSchema,
  workspaceManifestSchema,
  type SessionPermissionOperation,
  type SessionContentBlock,
  type SessionRuntimeDispatch,
  type SessionTimelineUpdate,
  type WorkspaceManifest,
} from "@codeops/codeops-contracts";
import type {
  AcpWorkspaceLifecycle,
} from "./lifecycle.js";
import type {
  RuntimeExecutionContext,
  RuntimeExecutionResult,
} from "./transport.js";
import type {
  WorkspaceCheckpointArtifactStore,
} from "./workspace-artifacts.js";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 2_000_000;
const MAX_SCRATCH_CONTENT_BYTES = 10_000_000;
const MAX_SCRATCH_ENTRIES = 10_000;
const MAX_SCRATCH_PATH_BYTES = 1_000_000;
const MAX_SCRATCH_ARTIFACT_BYTES = 16_000_000;
const MAX_ASSISTANT_RESPONSE_CHARS = 200_000;
const MAX_TIMELINE_UPDATES = 499;
const MAX_TIMELINE_UPDATE_BYTES = 800_000;
const GIT_SHA = /^[0-9a-f]{40}$/;

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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function renderAcpPermissionOperation(
  request: acp.RequestPermissionRequest,
): SessionPermissionOperation {
  const raw = record(request.toolCall.rawInput);
  if (
    raw !== null &&
    typeof raw.server === "string" &&
    typeof raw.tool === "string" &&
    "arguments" in raw
  ) {
    return sessionPermissionOperationSchema.parse({
      kind: "mcp",
      server: raw.server,
      tool: raw.tool,
      argumentsJson: canonical(raw.arguments),
    });
  }
  if (
    request.toolCall.kind === "execute" &&
    raw !== null &&
    typeof raw.command === "string" &&
    typeof raw.cwd === "string"
  ) {
    return sessionPermissionOperationSchema.parse({
      kind: "command",
      command: raw.command,
      cwd: raw.cwd,
    });
  }
  if (request.toolCall.kind === "edit" && request.toolCall.content) {
    const changes = request.toolCall.content.flatMap((content) =>
      content.type === "diff"
        ? [{
            path: content.path,
            oldText: content.oldText ?? null,
            newText: content.newText,
          }]
        : [],
    );
    if (changes.length > 0) {
      return sessionPermissionOperationSchema.parse({
        kind: "file_change",
        changes,
      });
    }
  }
  if (
    request.toolCall.kind === "other" &&
    raw !== null &&
    Array.isArray(raw.permissions)
  ) {
    return sessionPermissionOperationSchema.parse({
      kind: "agent_permissions",
      detailsJson: canonical(raw),
    });
  }
  throw new Error("ACP permission has no safe operation renderer");
}

export function mergeAcpPermissionToolCall(
  current: acp.ToolCallUpdate,
  prior: acp.ToolCall | acp.ToolCallUpdate | undefined,
): acp.ToolCallUpdate {
  if (prior === undefined) return current;
  return {
    toolCallId: current.toolCallId,
    ...(current.kind !== undefined ? { kind: current.kind } : prior.kind !== undefined ? { kind: prior.kind } : {}),
    ...(current.status !== undefined ? { status: current.status } : prior.status !== undefined ? { status: prior.status } : {}),
    ...(current.title !== undefined ? { title: current.title } : prior.title !== undefined ? { title: prior.title } : {}),
    ...(current.name !== undefined ? { name: current.name } : prior.name !== undefined ? { name: prior.name } : {}),
    ...(current.content !== undefined ? { content: current.content } : prior.content !== undefined ? { content: prior.content } : {}),
    ...(current.locations !== undefined ? { locations: current.locations } : prior.locations !== undefined ? { locations: prior.locations } : {}),
    ...(current.rawInput !== undefined ? { rawInput: current.rawInput } : prior.rawInput !== undefined ? { rawInput: prior.rawInput } : {}),
  };
}

export function appendAcpAssistantText(
  current: string,
  chunk: string,
): string {
  const response = `${current}${chunk}`;
  if (response.length > MAX_ASSISTANT_RESPONSE_CHARS) {
    throw new Error("ACP assistant response exceeds 200000 characters");
  }
  return response;
}

export interface AcpPromptCapture {
  readonly response: string;
  readonly updates: SessionTimelineUpdate[];
}

function optionalValue<Value>(value: Value | null | undefined): Value | undefined {
  return value === null || value === undefined ? undefined : value;
}

function normalizeAcpContent(content: acp.ContentBlock): SessionContentBlock {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return {
        type: "image",
        data: content.data,
        mimeType: content.mimeType,
        ...(content.uri ? { uri: content.uri } : {}),
      };
    case "audio":
      return { type: "audio", data: content.data, mimeType: content.mimeType };
    case "resource_link":
      return {
        type: "resource_link",
        name: content.name,
        uri: content.uri,
        ...(content.title ? { title: content.title } : {}),
        ...(content.description ? { description: content.description } : {}),
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        ...(content.size !== null && content.size !== undefined
          ? { size: Number(content.size) }
          : {}),
      };
    case "resource": {
      const resource = content.resource;
      return "text" in resource
        ? {
            type: "resource",
            uri: resource.uri,
            text: resource.text,
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          }
        : {
            type: "resource",
            uri: resource.uri,
            blob: resource.blob,
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          };
    }
  }
}

function normalizeToolContent(
  content: acp.ToolCallContent,
): NonNullable<Extract<SessionTimelineUpdate, { kind: "tool_call" }>["content"]>[number] {
  switch (content.type) {
    case "content":
      return { type: "content", content: normalizeAcpContent(content.content) };
    case "diff":
      return {
        type: "diff",
        path: content.path,
        newText: content.newText,
        ...(content.oldText !== undefined ? { oldText: content.oldText } : {}),
      };
    case "terminal":
      return { type: "terminal", terminalId: content.terminalId };
  }
}

function normalizeToolFields(update: acp.ToolCall | acp.ToolCallUpdate) {
  return {
    toolCallId: update.toolCallId,
    ...(optionalValue(update.name) ? { name: optionalValue(update.name) } : {}),
    ...(optionalValue(update.kind) ? { toolKind: optionalValue(update.kind) } : {}),
    ...(optionalValue(update.status) ? { status: optionalValue(update.status) } : {}),
    ...(update.content ? { content: update.content.map(normalizeToolContent) } : {}),
    ...(update.locations
      ? {
          locations: update.locations.map((location) => ({
            path: location.path,
            ...(location.line !== null && location.line !== undefined
              ? { line: location.line }
              : {}),
          })),
        }
      : {}),
  };
}

export function normalizeAcpTimelineUpdate(
  update: acp.SessionUpdate,
): SessionTimelineUpdate | null {
  const normalized = (() => {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        if (update.content.type === "text" && update.content.text.length === 0) return null;
        return {
          kind: "user_content" as const,
          ...(update.messageId !== undefined ? { messageId: update.messageId } : {}),
          content: normalizeAcpContent(update.content),
        };
      case "agent_message_chunk":
        if (update.content.type === "text" && update.content.text.length === 0) return null;
        return {
          kind: "assistant_content" as const,
          ...(update.messageId !== undefined ? { messageId: update.messageId } : {}),
          content: normalizeAcpContent(update.content),
        };
      case "agent_thought_chunk":
        if (update.content.type === "text" && update.content.text.length === 0) return null;
        return {
          kind: "thought" as const,
          ...(update.messageId !== undefined ? { messageId: update.messageId } : {}),
          content: normalizeAcpContent(update.content),
        };
      case "tool_call":
        return { kind: "tool_call" as const, title: update.title, ...normalizeToolFields(update) };
      case "tool_call_update":
        return {
          kind: "tool_call_update" as const,
          ...(optionalValue(update.title) ? { title: optionalValue(update.title) } : {}),
          ...normalizeToolFields(update),
        };
      case "plan":
        return { kind: "plan" as const, entries: update.entries };
      case "plan_update": {
        const plan = update.plan;
        if (plan.type === "items") return { kind: "plan_update" as const, planId: plan.planId, content: { type: "items" as const, entries: plan.entries } };
        if (plan.type === "markdown") return { kind: "plan_update" as const, planId: plan.planId, content: { type: "markdown" as const, markdown: plan.content } };
        return { kind: "plan_update" as const, planId: plan.planId, content: { type: "file" as const, uri: plan.uri } };
      }
      case "plan_removed":
        return { kind: "plan_removed" as const, planId: update.planId };
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
      case "usage_update":
        return null;
    }
  })();
  return normalized === null ? null : sessionTimelineUpdateSchema.parse(normalized);
}

export function captureAcpTimelineUpdate(
  current: AcpPromptCapture,
  update: acp.SessionUpdate,
): AcpPromptCapture {
  const normalized = normalizeAcpTimelineUpdate(update);
  const response =
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? appendAcpAssistantText(current.response, update.content.text)
      : current.response;
  if (normalized === null) return { response, updates: current.updates };
  const updates = [...current.updates];
  const previous = updates.at(-1);
  if (
    (normalized.kind === "user_content" ||
      normalized.kind === "assistant_content" ||
      normalized.kind === "thought") &&
    previous?.kind === normalized.kind &&
    previous.messageId === normalized.messageId &&
    previous.content.type === "text" &&
    normalized.content.type === "text"
  ) {
    updates[updates.length - 1] = sessionTimelineUpdateSchema.parse({
      ...previous,
      content: {
        type: "text",
        text: appendAcpAssistantText(previous.content.text, normalized.content.text),
      },
    });
  } else {
    updates.push(normalized);
  }
  if (updates.length > MAX_TIMELINE_UPDATES) throw new Error("ACP timeline exceeds 499 retained updates");
  if (Buffer.byteLength(JSON.stringify(updates)) > MAX_TIMELINE_UPDATE_BYTES) {
    throw new Error("ACP timeline exceeds 800000 retained bytes");
  }
  return { response, updates };
}

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

export function createAcpPermissionRelay(input: {
  readonly context: RuntimeExecutionContext;
  readonly now?: () => Date;
}): AcpPermissionRelay {
  const now = input.now ?? (() => new Date());
  return {
    request: async (dispatch, request) => {
      if (request.sessionId.length < 1 || request.sessionId.length > 500) {
        throw new Error("ACP permission session identity is invalid");
      }
      if (
        request.toolCall.toolCallId.length < 1 ||
        request.toolCall.toolCallId.length > 500
      ) {
        throw new Error("ACP permission tool-call identity is invalid");
      }
      const operation = renderAcpPermissionOperation(request);
      const requestId = `permission-${createHash("sha256")
        .update(canonical(operation))
        .update("\0")
        .update(dispatch.dispatchId)
        .update("\0")
        .update(request.toolCall.toolCallId)
        .digest("hex")}`;
      const operationDigest = `sha256:${createHash("sha256")
        .update(canonical(operation))
        .digest("hex")}`;
      const title =
        request.toolCall.title?.trim() ||
        request.toolCall.name?.trim() ||
        request.toolCall.kind?.trim() ||
        "Agent tool permission";
      const description = `ACP tool call ${request.toolCall.toolCallId} requests operator permission.`;
      const options = request.options.map((option, index) => ({
        optionId: `option-${index + 1}`,
        label: option.name,
      }));
      const decision = await input.context.requestPermission({
        request: {
          requestId,
          title,
          description,
          operation,
          operationDigest,
          options,
          requestedAt: now().toISOString(),
        },
        acpSessionId: request.sessionId,
        toolCallId: request.toolCall.toolCallId,
        options: request.options.map((option, index) => ({
          optionId: `option-${index + 1}`,
          acpOptionId: option.optionId,
        })),
      });
      return decision.outcome === "denied"
        ? { outcome: { outcome: "cancelled" } }
        : {
            outcome: {
              outcome: "selected",
              optionId: decision.acpOptionId,
            },
          };
    },
  };
}

interface StoredAcpState {
  readonly version: "codeops.acp-session-state/v1";
  readonly sessions: Readonly<Record<string, string>>;
}

export interface AcpAgentSessionConnection {
  newSession(cwd: string): Promise<string>;
  loadSession(sessionId: string, cwd: string): Promise<void>;
  prompt(sessionId: string, prompt: string): Promise<{
    readonly response: string;
    readonly stopReason: acp.PromptResponse["stopReason"];
    readonly updates?: SessionTimelineUpdate[];
  }>;
  forkSession(sessionId: string, cwd: string): Promise<string>;
}

export type AcpConnectionFactory = <Result>(
  dispatch: SessionRuntimeDispatch,
  operation: (agent: AcpAgentSessionConnection) => Promise<Result>,
) => Promise<Result>;

export async function forkOrCreateAcpSession(input: {
  readonly fork: () => Promise<string>;
  readonly create: () => Promise<string>;
}): Promise<string> {
  try {
    return await input.fork();
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== -32601
    ) {
      throw error;
    }
    return input.create();
  }
}

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

export async function waitForAcpSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const exactPath = boundedAbsolutePath("ACP socket path", socketPath);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 60_000
  ) {
    throw new Error("ACP socket timeout must be between 1 and 60 seconds");
  }
  const socket = await connectSocket(exactPath, timeoutMs);
  socket.destroy();
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

async function requirePlainDirectory(label: string, target: string): Promise<void> {
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`${label} must be one directory, not a symbolic link`);
  }
}

async function rejectGitObjectAlternates(objects: string): Promise<void> {
  for (const name of ["alternates", "http-alternates"]) {
    try {
      await lstat(path.join(objects, "info", name));
      throw new Error("workspace Git object alternates are not permitted");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        String(error.code) === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}

export async function captureWorkspacePatch(
  workspace: string,
  baseSha: string,
  captureRoot: string,
): Promise<Buffer> {
  const root = boundedAbsolutePath("workspace", workspace);
  const exactBaseSha = baseSha.trim().toLowerCase();
  if (!GIT_SHA.test(exactBaseSha)) {
    throw new Error("workspace patch base SHA must be one exact Git commit");
  }
  const privateRoot = boundedAbsolutePath("Git capture root", captureRoot);
  const repository = path.join(root, ".git");
  const objects = path.join(repository, "objects");
  await requirePlainDirectory("workspace Git directory", repository);
  await requirePlainDirectory("workspace Git object directory", objects);
  await rejectGitObjectAlternates(objects);
  await mkdir(privateRoot, { recursive: true });
  const captureDirectory = await mkdtemp(
    path.join(privateRoot, ".codeops-git-capture-"),
  );
  try {
    await mkdir(path.join(captureDirectory, "objects"));
    await mkdir(path.join(captureDirectory, "refs", "heads"), { recursive: true });
    await writeFile(
      path.join(captureDirectory, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
      { mode: 0o600 },
    );
    await writeFile(path.join(captureDirectory, "HEAD"), `${exactBaseSha}\n`, {
      mode: 0o600,
    });
    const env = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_DIR: captureDirectory,
      GIT_INDEX_FILE: path.join(captureDirectory, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_WORK_TREE: root,
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    };
    await execFileAsync("git", ["read-tree", exactBaseSha], {
      encoding: "buffer",
      env,
      maxBuffer: MAX_PATCH_BYTES + 1,
    });
    await execFileAsync("git", ["add", "--intent-to-add", "--all", "--"], {
      encoding: "buffer",
      env,
      maxBuffer: MAX_PATCH_BYTES + 1,
    });
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--binary", "--no-ext-diff", exactBaseSha, "--"],
      { encoding: "buffer", env, maxBuffer: MAX_PATCH_BYTES + 1 },
    );
    if (stdout.length > MAX_PATCH_BYTES) {
      throw new Error("ACP workspace patch exceeds 2000000 bytes");
    }
    return stdout;
  } finally {
    await rm(captureDirectory, { recursive: true, force: true });
  }
}

interface ScratchBundleEntry {
  readonly path: string;
  readonly type: "directory" | "file";
  readonly executable?: boolean;
  readonly contentBase64?: string;
}

async function collectScratchEntry(
  entries: ScratchBundleEntry[],
  handle: FileHandle,
  relative: string,
  total: { bytes: number; entries: number; pathBytes: number },
): Promise<void> {
  total.entries += 1;
  total.pathBytes += Buffer.byteLength(relative);
  if (
    total.entries > MAX_SCRATCH_ENTRIES ||
    total.pathBytes > MAX_SCRATCH_PATH_BYTES
  ) {
    throw new Error("scratch artifact tree exceeds its metadata bounds");
  }
  const stat = await handle.stat();
  if (stat.isDirectory()) {
    entries.push({ path: relative, type: "directory" });
    const directory = `/proc/self/fd/${handle.fd}`;
    const children = (await readdir(directory)).sort();
    for (const name of children) {
      let child: FileHandle;
      try {
        child = await open(
          `${directory}/${name}`,
          fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          String(error.code) === "ELOOP"
        ) {
          throw new Error(
            "scratch artifacts must not contain symbolic links",
            { cause: error },
          );
        }
        throw error;
      }
      try {
        await collectScratchEntry(
          entries,
          child,
          path.posix.join(relative, name),
          total,
        );
      } finally {
        await child.close();
      }
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error("scratch artifacts may contain only files and directories");
  }
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const remaining = MAX_SCRATCH_CONTENT_BYTES - total.bytes;
    const buffer = Buffer.alloc(Math.min(64 * 1_024, remaining + 1));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      position,
    );
    if (bytesRead === 0) break;
    total.bytes += bytesRead;
    if (total.bytes > MAX_SCRATCH_CONTENT_BYTES) {
      throw new Error("scratch artifact bundle exceeds 10000000 bytes");
    }
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  entries.push({
    path: relative,
    type: "file",
    executable: (stat.mode & 0o111) !== 0,
    contentBase64: Buffer.concat(chunks).toString("base64"),
  });
}

export async function captureScratchArtifact(
  scratchRoot: string,
): Promise<{ readonly digest: string; readonly content: Buffer }> {
  const root = boundedAbsolutePath("scratch workspace", scratchRoot);
  const entries: ScratchBundleEntry[] = [];
  let rootHandle: FileHandle;
  try {
    rootHandle = await open(
      root,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      String(error.code) === "ELOOP"
    ) {
      throw new Error("scratch artifacts must not contain symbolic links", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await collectScratchEntry(entries, rootHandle, ".", {
      bytes: 0,
      entries: 0,
      pathBytes: 0,
    });
  } finally {
    await rootHandle.close();
  }
  const content = Buffer.from(JSON.stringify({
    version: "codeops.scratch-artifact/v1",
    entries,
  }));
  if (content.byteLength > MAX_SCRATCH_ARTIFACT_BYTES) {
    throw new Error("scratch artifact exceeds 16000000 encoded bytes");
  }
  return {
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    content,
  };
}

export async function captureScratchArtifactDigest(
  scratchRoot: string,
): Promise<string> {
  return (await captureScratchArtifact(scratchRoot)).digest;
}

async function captureWorkspaceCheckpointArtifacts(
  workspaceRoot: string,
  rawManifest: WorkspaceManifest,
  captureRoot: string,
) {
  const root = boundedAbsolutePath("workspace", workspaceRoot);
  const manifest = workspaceManifestSchema.parse(rawManifest);
  const sourcePatches = [];
  for (const source of manifest.sources) {
    const content = await captureWorkspacePatch(
      path.join(root, source.checkoutPath),
      source.resolvedSha,
      captureRoot,
    );
    sourcePatches.push({
      catalogKey: source.catalogKey,
      repository: source.repository,
      baseSha: source.resolvedSha,
      patchDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      content,
    });
  }
  const scratch = await captureScratchArtifact(path.join(root, manifest.scratchPath));
  return {
    workspaceManifestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex")}`,
    sourcePatches,
    scratch,
  };
}

export async function captureWorkspaceCheckpoint(
  workspaceRoot: string,
  rawManifest: WorkspaceManifest,
  captureRoot: string,
): Promise<{
  readonly workspaceManifestDigest: string;
  readonly sourcePatches: {
    readonly catalogKey: string;
    readonly repository: string;
    readonly baseSha: string;
    readonly patchDigest: string;
  }[];
  readonly scratchArtifactDigest: string;
}> {
  const captured = await captureWorkspaceCheckpointArtifacts(
    workspaceRoot,
    rawManifest,
    captureRoot,
  );
  return {
    workspaceManifestDigest: captured.workspaceManifestDigest,
    sourcePatches: captured.sourcePatches.map(({ content: _content, ...patch }) => patch),
    scratchArtifactDigest: captured.scratch.digest,
  };
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
  readonly #artifacts?: WorkspaceCheckpointArtifactStore;
  readonly #captureRoot: string;

  constructor(input: {
    readonly socketPath: string;
    readonly workspace: string;
    readonly statePath: string;
    readonly permissions: AcpPermissionRelay;
    readonly socketTimeoutMs?: number;
    readonly now?: () => Date;
    readonly uuid?: () => string;
    readonly connect?: AcpConnectionFactory;
    readonly artifacts?: WorkspaceCheckpointArtifactStore;
  }) {
    this.#socketPath = boundedAbsolutePath("ACP socket path", input.socketPath);
    this.#workspace = boundedAbsolutePath("workspace", input.workspace);
    const statePath = boundedAbsolutePath("ACP state path", input.statePath);
    this.#state = new AcpSessionStateStore(statePath);
    this.#captureRoot = path.dirname(statePath);
    this.#permissions = input.permissions;
    this.#socketTimeoutMs = input.socketTimeoutMs ?? 30_000;
    this.#now = input.now ?? (() => new Date());
    this.#uuid = input.uuid ?? randomUUID;
    this.#artifacts = input.artifacts;
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
    const promptOutput = new Map<string, AcpPromptCapture>();
    const toolCalls = new Map<string, acp.ToolCall | acp.ToolCallUpdate>();
    try {
      return await acp
        .client({ name: "codeops-session-runtime-worker" })
        .onRequest(
          acp.methods.client.session.requestPermission,
          async ({ params }) => {
            if (dispatch.command.type !== "prompt") {
              return { outcome: { outcome: "cancelled" } };
            }
            const key = `${params.sessionId}\0${params.toolCall.toolCallId}`;
            return this.#permissions.request(dispatch as PromptDispatch, {
              ...params,
              toolCall: mergeAcpPermissionToolCall(
                params.toolCall,
                toolCalls.get(key),
              ),
            });
          },
        )
        .onNotification(
          acp.methods.client.session.update,
          ({ params }) => {
            const { sessionId, update } = params;
            if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update"
            ) {
              const key = `${sessionId}\0${update.toolCallId}`;
              toolCalls.set(
                key,
                mergeAcpPermissionToolCall(update, toolCalls.get(key)),
              );
              if (toolCalls.size > MAX_TIMELINE_UPDATES) {
                toolCalls.delete(toolCalls.keys().next().value!);
              }
            }
            promptOutput.set(
              sessionId,
              captureAcpTimelineUpdate(
                promptOutput.get(sessionId) ?? { response: "", updates: [] },
                update,
              ),
            );
          },
        )
        .connectWith(stream, async (agent) => {
          await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: {
              name: "codeops-session-runtime-worker",
              version: "0.1.0",
            },
          });
          return operation({
            newSession: async (cwd) =>
              (await agent.request(acp.methods.agent.session.new, {
                cwd,
                mcpServers: [{
                  name: "codeops-work-items",
                  command: "/usr/local/bin/node",
                  args: ["/opt/codeops-agent/work-items-mcp.mjs"],
                  env: [],
                }],
              })).sessionId,
            loadSession: async (sessionId, cwd) => {
              await agent.request(acp.methods.agent.session.load, {
                sessionId,
                cwd,
                mcpServers: [{
                  name: "codeops-work-items",
                  command: "/usr/local/bin/node",
                  args: ["/opt/codeops-agent/work-items-mcp.mjs"],
                  env: [],
                }],
              });
            },
            prompt: async (sessionId, prompt) => {
              promptOutput.set(sessionId, { response: "", updates: [] });
              const result = await agent.request(acp.methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: "text", text: prompt }],
              });
              const capture = promptOutput.get(sessionId) ?? { response: "", updates: [] };
              return { ...capture, stopReason: result.stopReason };
            },
            forkSession: async (sessionId, cwd) =>
              forkOrCreateAcpSession({
                fork: async () =>
                  (await agent.request(acp.methods.agent.session.fork, {
                    sessionId,
                    cwd,
                    mcpServers: [{
                      name: "codeops-work-items",
                      command: "/usr/local/bin/node",
                      args: ["/opt/codeops-agent/work-items-mcp.mjs"],
                      env: [],
                    }],
                  })).sessionId,
                create: async () =>
                  (await agent.request(acp.methods.agent.session.new, {
                    cwd,
                    mcpServers: [{
                      name: "codeops-work-items",
                      command: "/usr/local/bin/node",
                      args: ["/opt/codeops-agent/work-items-mcp.mjs"],
                      env: [],
                    }],
                  })).sessionId,
              }),
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
    const material = await this.#connect(dispatch, async (agent) => {
      const sessionId = await this.#activeAcpSession(dispatch, agent);
      return agent.prompt(sessionId, dispatch.command.prompt);
    });
    return { type: "prompt", material };
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
    if ("version" in dispatch.snapshot.identity) {
      if (this.#artifacts === undefined) {
        throw new Error("workspace checkpoint requires durable artifact storage");
      }
      const checkpointId = this.#uuid();
      const captured = await captureWorkspaceCheckpointArtifacts(
        this.#workspace,
        dispatch.snapshot.identity.workspace,
        this.#captureRoot,
      );
      const evidenceReferences = [];
      for (const patch of captured.sourcePatches) {
        const artifactId = `artifact:${checkpointId}:source:${patch.catalogKey}`;
        await this.#artifacts.put({
          artifactId,
          sessionId: dispatch.command.sessionId,
          generation: dispatch.command.generation,
          checkpointId,
          kind: "source-patch",
          catalogKey: patch.catalogKey,
          digest: patch.patchDigest,
          content: patch.content,
        });
        evidenceReferences.push(artifactId);
      }
      const scratchArtifactId = `artifact:${checkpointId}:scratch`;
      await this.#artifacts.put({
        artifactId: scratchArtifactId,
        sessionId: dispatch.command.sessionId,
        generation: dispatch.command.generation,
        checkpointId,
        kind: "scratch-bundle",
        digest: captured.scratch.digest,
        content: captured.scratch.content,
      });
      evidenceReferences.push(scratchArtifactId);
      return {
        type,
        material: {
          version: "codeops.session-workspace-checkpoint-material/v1",
          checkpointId,
          workspaceManifestDigest: captured.workspaceManifestDigest,
          sourcePatches: captured.sourcePatches.map(
            ({ content: _content, ...patch }) => patch,
          ),
          scratchArtifactDigest: captured.scratch.digest,
          acpSessionId,
          evidenceReferences,
        },
      };
    }
    const patch = await captureWorkspacePatch(
      this.#workspace,
      dispatch.snapshot.identity.baseSha,
      this.#captureRoot,
    );
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
        ...("version" in dispatch.snapshot.identity
          ? { workspace: true as const }
          : { branch: `${dispatch.snapshot.identity.branch}-fork-${suffix}` }),
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
