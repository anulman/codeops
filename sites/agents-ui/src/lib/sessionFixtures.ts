import type {
  SessionActionType,
  SessionCapability,
  SessionSnapshot,
} from "@renoconcierge/codeops-contracts/session-broker";

export type SessionState = "running" | "attention" | "queued" | "completed" | "archived";

export type SessionSummary = {
  id: string;
  title: string;
  role: string;
  repo: string;
  branch: string;
  sha: string;
  state: SessionState;
  phase: string;
  updated: string;
  elapsed: string;
  verdict: string;
  findings: number;
  parentRun: string;
  broker: SessionSnapshot;
};

const allActions: readonly SessionActionType[] = [
  "prompt",
  "respond_permission",
  "cancel",
  "checkpoint",
  "hibernate",
  "resume",
  "fork",
  "archive",
  "delete",
];

function capabilities(
  enabled: readonly SessionActionType[],
): readonly SessionCapability[] {
  return allActions.map((action) =>
    enabled.includes(action)
      ? { action, availability: "enabled" as const }
      : {
          action,
          availability: "disabled" as const,
          reason: "The current broker state does not authorize this action.",
        },
  );
}

function brokerSnapshot(input: {
  sessionId: string;
  state: "queued" | "running" | "waiting_permission" | "completed" | "archived";
  branch: string;
  sha: string;
  runId: string;
  eventCursor: number;
  enabled: readonly SessionActionType[];
}): SessionSnapshot {
  const generation = 3;
  const leaseId = "11111111-1111-4111-8111-111111111111";
  return {
    version: "codeops.session-snapshot/v1",
    sessionId: input.sessionId,
    generation,
    state: input.state,
    identity: {
      repository: "anulman/renoconcierge",
      branch: input.branch,
      baseSha: input.sha,
      workflowId: input.runId,
      runId: input.runId,
      parentSessionId: null,
      forkedAtCursor: null,
    },
    lease: input.state === "running" || input.state === "waiting_permission"
      ? {
          leaseId,
          generation,
          status: "active",
          holderId: "codeops-agent-7c8d9",
          acquiredAt: "2026-08-04T03:14:00.000Z",
          expiresAt: "2026-08-04T03:24:00.000Z",
        }
      : {
          leaseId,
          generation,
          status: "released",
          releasedAt: "2026-08-04T03:20:11.000Z",
        },
    checkpoint: input.enabled.includes("resume") || input.enabled.includes("fork")
      ? {
          version: "codeops.session-checkpoint/v1",
          checkpointId: "22222222-2222-4222-8222-222222222222",
          sessionId: input.sessionId,
          generation,
          baseSha: input.sha,
          patchDigest: `sha256:${"a".repeat(64)}`,
          acpSessionId: `acp-${input.sessionId}`,
          eventCursor: input.eventCursor,
          evidenceReferences: [],
          createdAt: "2026-08-04T03:20:11.000Z",
        }
      : null,
    pendingPermission: input.state === "waiting_permission"
      ? {
          requestId: "permission-1",
          title: "Approve dependency installation?",
          description: "The agent requested one reviewed dependency change.",
          options: [
            { optionId: "allow_once", label: "Allow once" },
            { optionId: "deny", label: "Deny" },
          ],
          requestedAt: "2026-08-04T03:20:00.000Z",
        }
      : null,
    eventCursor: input.eventCursor,
    capabilities: [...capabilities(input.enabled)],
    updatedAt: "2026-08-04T03:20:11.000Z",
  };
}

const schedulerSha = "04e48f7f6bf1a872530e288e5bf0f5a0fb479aa8";
const fixtureSha = "bbea48444317465fbe8d731d5cdf648277540517";

export const sessions: readonly SessionSummary[] = [
  {
    id: "ses_91a4",
    title: "Review PR #155 scheduler",
    role: "Correctness reviewer",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: schedulerSha,
    state: "running",
    phase: "Running controller tests",
    updated: "12s ago",
    elapsed: "8m 42s",
    verdict: "Pending",
    findings: 2,
    parentRun: "run_155_04e48f7",
    broker: brokerSnapshot({ sessionId: "ses_91a4", state: "running", branch: "feat/codeops-contracts-ci", sha: schedulerSha, runId: "run-155-04e48f7", eventCursor: 184, enabled: ["prompt", "cancel", "checkpoint", "hibernate"] }),
  },
  {
    id: "ses_f840",
    title: "Review PR #155 scheduler",
    role: "Security reviewer",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: schedulerSha,
    state: "attention",
    phase: "Waiting for approval",
    updated: "1m ago",
    elapsed: "11m 03s",
    verdict: "Blocked",
    findings: 1,
    parentRun: "run_155_04e48f7",
    broker: brokerSnapshot({ sessionId: "ses_f840", state: "waiting_permission", branch: "feat/codeops-contracts-ci", sha: schedulerSha, runId: "run-155-security", eventCursor: 92, enabled: ["respond_permission", "cancel", "checkpoint", "hibernate"] }),
  },
  {
    id: "ses_6cd2",
    title: "Review PR #155 scheduler",
    role: "Product reviewer",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: schedulerSha,
    state: "completed",
    phase: "Review complete",
    updated: "3m ago",
    elapsed: "6m 18s",
    verdict: "Passed",
    findings: 0,
    parentRun: "run_155_04e48f7",
    broker: brokerSnapshot({ sessionId: "ses_6cd2", state: "completed", branch: "feat/codeops-contracts-ci", sha: schedulerSha, runId: "run-155-product", eventCursor: 137, enabled: ["fork", "archive"] }),
  },
  {
    id: "ses_b22e",
    title: "Synthesize PR #155 reviews",
    role: "Synthesis",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: schedulerSha,
    state: "queued",
    phase: "Waiting for reviewers",
    updated: "4m ago",
    elapsed: "—",
    verdict: "Pending",
    findings: 0,
    parentRun: "run_155_04e48f7",
    broker: brokerSnapshot({ sessionId: "ses_b22e", state: "queued", branch: "feat/codeops-contracts-ci", sha: schedulerSha, runId: "run-155-synthesis", eventCursor: 1, enabled: ["cancel"] }),
  },
  {
    id: "ses_31bc",
    title: "QANBRDAUTH fixture implementation",
    role: "Coding agent",
    repo: "anulman/renoconcierge",
    branch: "feat/qanbrdauth-routing-fixtures",
    sha: fixtureSha,
    state: "archived",
    phase: "Evidence retained",
    updated: "6d ago",
    elapsed: "24m 11s",
    verdict: "Passed",
    findings: 0,
    parentRun: "run_qanbrdauth_2",
    broker: brokerSnapshot({ sessionId: "ses_31bc", state: "archived", branch: "feat/qanbrdauth-routing-fixtures", sha: fixtureSha, runId: "run-qanbrdauth-2", eventCursor: 311, enabled: ["resume", "fork", "delete"] }),
  },
];

export const selectedSession = sessions[0]!;

export const timeline = [
  { time: "03:14:02", kind: "system", title: "Session admitted", detail: "Worker generation 3 · exact base 04e48f7" },
  { time: "03:14:08", kind: "agent", title: "Review plan", detail: "Inspecting scheduler invariants, replay behavior, and cancellation boundaries." },
  { time: "03:15:31", kind: "tool", title: "Read 14 files", detail: "services/codeops-plane-controller · packages/codeops-contracts" },
  { time: "03:18:44", kind: "finding", title: "Finding recorded", detail: "Merge reconciliation should reject a stale head ref even when the bound SHA matches." },
  { time: "03:20:11", kind: "tool", title: "Running tests", detail: "node --test services/codeops-plane-controller/test/*.test.mjs · 61 / 92 passed" },
] as const;

export function stateCounts(items: readonly SessionSummary[]) {
  return {
    active: items.filter((item) => item.state === "running" || item.state === "queued").length,
    attention: items.filter((item) => item.state === "attention").length,
    archived: items.filter((item) => item.state === "archived").length,
    total: items.length,
  };
}
