import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ledgerKindSchema = z.enum(["event", "request", "projection"]);
const stableIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const outcomeSchema = z.enum([
  "ignored",
  "request-created",
  "request-enqueued",
  "mutations-applied",
]);

const ledgerRecordSchema = z
  .object({
    version: z.literal("codeops.dedup-ledger/v1"),
    kind: ledgerKindSchema,
    stableId: stableIdSchema,
    payloadDigest: digestSchema,
    state: z.enum(["processing", "complete", "failed"]),
    attempt: z.number().int().positive(),
    leaseId: z.string().uuid(),
    leaseExpiresAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    outcome: outcomeSchema.optional(),
    resultId: stableIdSchema.optional(),
    failure: z.string().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.state === "complete" && record.outcome === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "complete ledger record requires an outcome",
      });
    }
    if (record.state !== "complete" && record.outcome !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "only complete ledger records may carry an outcome",
      });
    }
    if (record.state !== "complete" && record.resultId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultId"],
        message: "only complete ledger records may carry a result identity",
      });
    }
    if (record.state === "failed" && record.failure === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure"],
        message: "failed ledger record requires a bounded failure",
      });
    }
    if (record.state !== "failed" && record.failure !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failure"],
        message: "only failed ledger records may carry a failure",
      });
    }
  });

type LedgerKind = z.infer<typeof ledgerKindSchema>;
type LedgerOutcome = z.infer<typeof outcomeSchema>;
type LedgerRecord = z.infer<typeof ledgerRecordSchema>;

export type DedupClaim =
  | Readonly<{
      status: "acquired";
      kind: LedgerKind;
      stableId: string;
      payloadDigest: string;
      leaseId: string;
      attempt: number;
      leaseExpiresAt: string;
    }>
  | Readonly<{
      status: "busy";
      leaseExpiresAt: string;
    }>
  | Readonly<{
      status: "complete";
      outcome: LedgerOutcome;
      resultId?: string;
    }>;

export interface ResearchDedupLedger {
  claim(input: {
    kind: LedgerKind;
    stableId: string;
    payloadDigest: string;
    now: string;
  }): Promise<DedupClaim>;
  complete(input: {
    claim: Extract<DedupClaim, { status: "acquired" }>;
    outcome: LedgerOutcome;
    resultId?: string;
    now: string;
  }): Promise<void>;
  fail(input: {
    claim: Extract<DedupClaim, { status: "acquired" }>;
    failure: string;
    now: string;
  }): Promise<void>;
}

export type FileResearchDedupLedgerConfig = Readonly<{
  rootDirectory: string;
  leaseDurationMs: number;
  staleLockMs?: number;
}>;

function recordName(kind: LedgerKind, stableId: string): string {
  return `${kind}-${stableId}.json`;
}

function parseInstant(value: string): number {
  return Date.parse(isoDateTimeSchema.parse(value));
}

function boundedFailure(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.slice(0, 1_000) || "unspecified failure";
}

export function createFileResearchDedupLedger(
  config: FileResearchDedupLedgerConfig,
): ResearchDedupLedger {
  if (!path.isAbsolute(config.rootDirectory)) {
    throw new Error("dedup ledger root must be an absolute path");
  }
  if (
    !Number.isSafeInteger(config.leaseDurationMs) ||
    config.leaseDurationMs < 1_000 ||
    config.leaseDurationMs > 60 * 60 * 1_000
  ) {
    throw new Error("dedup ledger lease must be between 1s and 1h");
  }
  const staleLockMs = config.staleLockMs ?? 30_000;
  if (
    !Number.isSafeInteger(staleLockMs) ||
    staleLockMs < 1_000 ||
    staleLockMs > 5 * 60 * 1_000
  ) {
    throw new Error("dedup ledger stale lock must be between 1s and 5m");
  }

  async function ensureRoot(): Promise<void> {
    await mkdir(config.rootDirectory, { recursive: true, mode: 0o700 });
    const root = await lstat(config.rootDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("dedup ledger root must be a real directory");
    }
  }

  function paths(kind: LedgerKind, stableId: string): {
    recordPath: string;
    lockPath: string;
  } {
    const safeKind = ledgerKindSchema.parse(kind);
    const safeId = stableIdSchema.parse(stableId);
    const recordPath = path.join(
      config.rootDirectory,
      recordName(safeKind, safeId),
    );
    return { recordPath, lockPath: `${recordPath}.lock` };
  }

  async function acquireLock(lockPath: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
      }
      const lock = await stat(lockPath);
      if (Date.now() - lock.mtimeMs <= staleLockMs) {
        throw new Error("dedup ledger record is locked");
      }
      await rmdir(lockPath);
    }
    throw new Error("could not acquire dedup ledger record lock");
  }

  async function readRecord(recordPath: string): Promise<LedgerRecord | undefined> {
    try {
      return ledgerRecordSchema.parse(
        JSON.parse(await readFile(recordPath, "utf8")) as unknown,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async function writeRecord(
    recordPath: string,
    record: LedgerRecord,
  ): Promise<void> {
    const parsed = ledgerRecordSchema.parse(record);
    const temporaryPath = `${recordPath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, recordPath);
      const rootHandle = await open(config.rootDirectory, "r");
      try {
        await rootHandle.sync();
      } finally {
        await rootHandle.close();
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async function withRecordLock<T>(
    kind: LedgerKind,
    stableId: string,
    callback: (recordPath: string) => Promise<T>,
  ): Promise<T> {
    await ensureRoot();
    const { recordPath, lockPath } = paths(kind, stableId);
    await acquireLock(lockPath);
    try {
      return await callback(recordPath);
    } finally {
      await rmdir(lockPath);
    }
  }

  async function transition(
    input:
      | {
          type: "complete";
          claim: Extract<DedupClaim, { status: "acquired" }>;
          outcome: LedgerOutcome;
          resultId?: string;
          now: string;
        }
      | {
          type: "fail";
          claim: Extract<DedupClaim, { status: "acquired" }>;
          failure: string;
          now: string;
        },
  ): Promise<void> {
    await withRecordLock(input.claim.kind, input.claim.stableId, async (recordPath) => {
      const record = await readRecord(recordPath);
      if (
        record === undefined ||
        record.payloadDigest !== input.claim.payloadDigest ||
        record.state !== "processing" ||
        record.leaseId !== input.claim.leaseId
      ) {
        throw new Error("dedup ledger lease no longer owns the record");
      }
      const now = isoDateTimeSchema.parse(input.now);
      await writeRecord(recordPath, {
        ...record,
        state: input.type === "complete" ? "complete" : "failed",
        updatedAt: now,
        ...(input.type === "complete"
          ? {
              outcome: outcomeSchema.parse(input.outcome),
              ...(input.resultId === undefined
                ? {}
                : { resultId: stableIdSchema.parse(input.resultId) }),
            }
          : { failure: boundedFailure(input.failure) }),
      });
    });
  }

  return {
    async claim(input): Promise<DedupClaim> {
      const kind = ledgerKindSchema.parse(input.kind);
      const stableId = stableIdSchema.parse(input.stableId);
      const payloadDigest = digestSchema.parse(input.payloadDigest);
      const now = isoDateTimeSchema.parse(input.now);
      const nowMs = parseInstant(now);
      return withRecordLock(kind, stableId, async (recordPath) => {
        const existing = await readRecord(recordPath);
        if (
          existing !== undefined &&
          existing.payloadDigest !== payloadDigest
        ) {
          throw new Error(
            "dedup ledger stable identity was reused with different content",
          );
        }
        if (existing?.state === "complete") {
          return {
            status: "complete",
            outcome: existing.outcome as LedgerOutcome,
            ...(existing.resultId === undefined
              ? {}
              : { resultId: existing.resultId }),
          };
        }
        if (
          existing?.state === "processing" &&
          parseInstant(existing.leaseExpiresAt) > nowMs
        ) {
          return {
            status: "busy",
            leaseExpiresAt: existing.leaseExpiresAt,
          };
        }

        const leaseId = randomUUID();
        const leaseExpiresAt = new Date(
          nowMs + config.leaseDurationMs,
        ).toISOString();
        const attempt = (existing?.attempt ?? 0) + 1;
        await writeRecord(recordPath, {
          version: "codeops.dedup-ledger/v1",
          kind,
          stableId,
          payloadDigest,
          state: "processing",
          attempt,
          leaseId,
          leaseExpiresAt,
          updatedAt: now,
        });
        return {
          status: "acquired",
          kind,
          stableId,
          payloadDigest,
          leaseId,
          attempt,
          leaseExpiresAt,
        };
      });
    },

    async complete(input): Promise<void> {
      await transition({ type: "complete", ...input });
    },

    async fail(input): Promise<void> {
      await transition({ type: "fail", ...input });
    },
  };
}
