import * as acp from "@agentclientprotocol/sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import {
  boundedText,
  requireLowerHex,
  requireRunId,
} from "./safety.js";

const execFileAsync = promisify(execFile);
const MAX_PROMPT_BYTES = 100_000;
const MAX_PATCH_BYTES = 2_000_000;

interface SafeEvent {
  readonly sequence: number;
  readonly type: string;
  readonly toolCallId?: string;
  readonly title?: string;
  readonly status?: string;
}

interface Checkpoint {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly baseSha: string;
  readonly sessionId?: string;
  readonly stopReason?: string;
  readonly response: string;
  readonly events: readonly SafeEvent[];
  readonly patch: {
    readonly path: "changes.patch";
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly error?: string;
}

function getPrompt(): string {
  const encoded = process.env.CODEOPS_PROMPT_B64;
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("CODEOPS_PROMPT_B64 must contain canonical base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PROMPT_BYTES) {
    throw new Error("decoded CodeOps prompt must contain 1 to 100000 bytes");
  }
  const prompt = bytes.toString("utf8").trim();
  if (!prompt || Buffer.from(prompt).length > MAX_PROMPT_BYTES) {
    throw new Error("decoded CodeOps prompt must be non-empty UTF-8");
  }
  return prompt;
}

async function connectSocket(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function safeEvent(sequence: number, update: acp.SessionUpdate): SafeEvent {
  const record = update as unknown as Record<string, unknown>;
  return {
    sequence,
    type: update.sessionUpdate,
    ...(typeof record.toolCallId === "string"
      ? { toolCallId: record.toolCallId }
      : {}),
    ...(typeof record.title === "string"
      ? { title: boundedText(record.title, 500) }
      : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
  };
}

async function capturePatch(workspace: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspace, "diff", "--binary", "--no-ext-diff", "--"],
    {
      encoding: "buffer",
      maxBuffer: MAX_PATCH_BYTES + 1,
    },
  );
  if (stdout.length > MAX_PATCH_BYTES) {
    throw new Error("CodeOps patch exceeds the 2000000-byte Trial 0 limit");
  }
  return stdout;
}

async function writeCheckpoint(
  checkpointDirectory: string,
  checkpoint: Omit<Checkpoint, "patch">,
  patch: Uint8Array,
): Promise<void> {
  await mkdir(checkpointDirectory, { recursive: true });
  const patchPath = path.join(checkpointDirectory, "changes.patch");
  const checkpointPath = path.join(checkpointDirectory, "checkpoint.json");
  const temporaryPath = `${checkpointPath}.tmp`;
  await writeFile(patchPath, patch, { mode: 0o600 });
  await writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        ...checkpoint,
        patch: {
          path: "changes.patch",
          sha256: createHash("sha256").update(patch).digest("hex"),
          bytes: patch.length,
        },
      } satisfies Checkpoint,
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await rename(temporaryPath, checkpointPath);
}

export async function runGateway(): Promise<void> {
  const runId = requireRunId(process.env.CODEOPS_RUN_ID);
  const baseSha = requireLowerHex("CODEOPS_BASE_SHA", process.env.CODEOPS_BASE_SHA, 40);
  const workspace = process.env.CODEOPS_WORKSPACE ?? "/workspace";
  const checkpointDirectory =
    process.env.CODEOPS_CHECKPOINT_DIR ?? "/checkpoint";
  const socketPath = process.env.CODEOPS_ACP_SOCKET ?? "/run/codeops/agent.sock";
  const prompt = getPrompt();
  const events: SafeEvent[] = [];
  let response = "";
  let sessionId: string | undefined;
  let stopReason: string | undefined;
  let failure: string | undefined;

  try {
    const socket = await connectSocket(socketPath);
    const stream = acp.ndJsonStream(
      Writable.toWeb(socket),
      Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    );
    try {
      await acp
        .client({ name: "renoconcierge-codeops-session-gateway" })
        .onRequest(acp.methods.client.session.requestPermission, (context) => {
          const option = context.params.options.find(
            (candidate) => candidate.kind === "allow_once",
          );
          if (!option) return { outcome: { outcome: "cancelled" } };
          return {
            outcome: { outcome: "selected", optionId: option.optionId },
          };
        })
        .onNotification(acp.methods.client.session.update, (context) => {
          const update = context.params.update;
          events.push(safeEvent(events.length + 1, update));
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          ) {
            response = boundedText(response + update.content.text);
          }
        })
        .connectWith(stream, async (agent) => {
          await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: {
              name: "renoconcierge-codeops-session-gateway",
              version: "0.1.0",
            },
          });
          const session = await agent.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [],
          });
          sessionId = session.sessionId;
          const result = await agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: prompt }],
          });
          stopReason = result.stopReason;
        });
    } finally {
      socket.destroy();
    }
  } catch (error) {
    failure = boundedText(error instanceof Error ? error.message : String(error), 2_000);
  }

  let patch: Uint8Array = new Uint8Array();
  try {
    patch = await capturePatch(workspace);
  } catch (error) {
    failure ??= boundedText(
      error instanceof Error ? error.message : String(error),
      2_000,
    );
  }
  await writeCheckpoint(
    checkpointDirectory,
    {
      schemaVersion: 1,
      runId,
      baseSha,
      ...(sessionId ? { sessionId } : {}),
      ...(stopReason ? { stopReason } : {}),
      response: boundedText(response),
      events,
      ...(failure ? { error: failure } : {}),
    },
    patch,
  );
  await writeFile(path.dirname(socketPath) + "/done", "", { mode: 0o600 });
  if (failure) throw new Error(failure);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runGateway();
}
