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
};

export const sessions: readonly SessionSummary[] = [
  {
    id: "ses_91a4",
    title: "Review PR #155 scheduler",
    role: "Correctness reviewer",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: "04e48f7",
    state: "running",
    phase: "Running controller tests",
    updated: "12s ago",
    elapsed: "8m 42s",
    verdict: "Pending",
    findings: 2,
    parentRun: "run_155_04e48f7",
  },
  {
    id: "ses_f840",
    title: "Review PR #155 scheduler",
    role: "Security reviewer",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: "04e48f7",
    state: "attention",
    phase: "Waiting for approval",
    updated: "1m ago",
    elapsed: "11m 03s",
    verdict: "Blocked",
    findings: 1,
    parentRun: "run_155_04e48f7",
  },
  {
    id: "ses_6cd2",
    title: "Review PR #155 scheduler",
    role: "Product reviewer",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: "04e48f7",
    state: "completed",
    phase: "Review complete",
    updated: "3m ago",
    elapsed: "6m 18s",
    verdict: "Passed",
    findings: 0,
    parentRun: "run_155_04e48f7",
  },
  {
    id: "ses_b22e",
    title: "Synthesize PR #155 reviews",
    role: "Synthesis",
    repo: "anulman/renoconcierge",
    branch: "feat/codeops-contracts-ci",
    sha: "04e48f7",
    state: "queued",
    phase: "Waiting for reviewers",
    updated: "4m ago",
    elapsed: "—",
    verdict: "Pending",
    findings: 0,
    parentRun: "run_155_04e48f7",
  },
  {
    id: "ses_31bc",
    title: "QANBRDAUTH fixture implementation",
    role: "Coding agent",
    repo: "anulman/renoconcierge",
    branch: "feat/qanbrdauth-routing-fixtures",
    sha: "bbea484",
    state: "archived",
    phase: "Evidence retained",
    updated: "6d ago",
    elapsed: "24m 11s",
    verdict: "Passed",
    findings: 0,
    parentRun: "run_qanbrdauth_2",
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
