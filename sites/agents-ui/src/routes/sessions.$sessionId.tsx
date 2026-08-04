import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { selectedSession, sessions, timeline } from "@/lib/sessionFixtures";
import type {
  SessionActionType,
  SessionCapability,
} from "@renoconcierge/codeops-contracts/session-broker";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionCockpit,
});

function SessionCockpit() {
  const { sessionId } = Route.useParams();
  const session = sessions.find((item) => item.id === sessionId) ?? selectedSession;

  return (
    <AppShell>
      <main className="mx-auto max-w-[1700px] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col gap-5 border-b border-white/8 pb-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <Link to="/" className="mb-4 inline-flex items-center gap-2 text-xs text-white/35 transition hover:text-white/70"><span>←</span> All sessions</Link>
            <div className="flex flex-wrap items-center gap-3"><StatusBadge state={session.state} /><span className="font-mono text-[11px] text-white/28">{session.id}</span></div>
            <h1 className="mt-3 text-2xl font-medium tracking-[-0.035em] text-white sm:text-3xl">{session.role}</h1>
            <p className="mt-2 text-sm text-white/42">{session.title} · <span className="font-mono">{session.sha.slice(0, 7)}</span></p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 xl:w-auto xl:grid-cols-5" aria-label="Session actions">
            {session.broker.capabilities.map((capability) => (
              <ActionButton key={capability.action} capability={capability} />
            ))}
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-w-0 rounded-xl border border-white/8 bg-[#0c0f13]">
            <div className="sticky top-16 z-20 flex flex-col gap-3 border-b border-white/8 bg-[#0c0f13]/95 px-4 py-4 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">Now</div><div className="mt-1 flex items-center gap-2 text-sm text-white/80"><span className="size-1.5 animate-pulse rounded-full bg-[#c8ff5a]" />{session.phase}</div></div>
              <div className="font-mono text-[11px] text-white/30">event cursor · {String(session.broker.eventCursor).padStart(6, "0")}</div>
            </div>
            <div className="px-4 py-3 sm:px-6">
              {timeline.map((event, index) => (
                <article key={`${event.time}-${event.title}`} className="grid grid-cols-[54px_16px_minmax(0,1fr)] gap-3 py-5">
                  <time className="pt-0.5 font-mono text-[10px] text-white/25">{event.time}</time>
                  <div className="relative flex justify-center"><span className={`relative z-10 mt-1 size-2 rounded-full ${eventDot(event.kind)}`} />{index < timeline.length - 1 ? <span className="absolute bottom-[-21px] top-3 w-px bg-white/8" /> : null}</div>
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium text-white/82">{event.title}</h2><span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] uppercase text-white/30">{event.kind}</span></div><p className="mt-2 text-xs leading-5 text-white/42">{event.detail}</p>{event.kind === "tool" ? <div className="mt-3 overflow-hidden rounded-lg border border-white/8 bg-[#07090b]"><div className="flex items-center justify-between border-b border-white/6 px-3 py-2 font-mono text-[10px] text-white/30"><span>stdout</span><span className="text-[#c8ff5a]/65">running</span></div><pre className="overflow-x-auto p-3 font-mono text-[11px] leading-5 text-white/48">✓ scheduler accepts one stacked child{`\n`}✓ third unmerged PR is held{`\n`}✓ stale merge identity rejected</pre></div> : null}</div>
                </article>
              ))}
            </div>
          </section>

          <aside className="space-y-4">
            <Panel title="Execution identity"><Fact label="Repository" value={session.repo} /><Fact label="Branch" value={session.branch} /><Fact label="Commit" value={session.sha} mono /><Fact label="Worker" value={session.broker.lease?.status === "active" ? session.broker.lease.holderId : "No active worker"} mono /><Fact label="Generation" value={String(session.broker.generation)} /><Fact label="Lease" value={session.broker.lease?.leaseId.slice(0, 8) ?? "Deleted"} mono /><Fact label="Model" value="gpt-5.6-sol" /></Panel>
            <Panel title="Evidence"><EvidenceRow label="Changed files" value="3" /><EvidenceRow label="Tests" value="61 / 92 passing" tone="live" /><EvidenceRow label="Findings" value={`${session.findings} open`} tone={session.findings > 0 ? "warn" : "quiet"} /><EvidenceRow label="Patch" value="sha256:a4d9…2c10" mono /></Panel>
            <Panel title="Ensemble"><EnsembleRow role="Correctness" state="running" /><EnsembleRow role="Security" state="attention" /><EnsembleRow role="Product" state="completed" /><EnsembleRow role="Synthesis" state="queued" /></Panel>
            <details className="rounded-xl border border-white/8 bg-[#0c0f13] px-4 py-3"><summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-[0.14em] text-white/38">Protocol diagnostics <span className="float-right text-white/22">＋</span></summary><pre className="mt-4 overflow-x-auto border-t border-white/6 pt-4 font-mono text-[10px] leading-5 text-white/32">session/update{`\n`}broker: ses_91a4{`\n`}backend: th_8f20…{`\n`}sequence: 184{`\n`}transport: sse</pre></details>
          </aside>
        </div>
      </main>
    </AppShell>
  );
}

const actionLabels: Record<SessionActionType, string> = {
  prompt: "Prompt",
  respond_permission: "Approve / deny",
  cancel: "Cancel",
  checkpoint: "Checkpoint",
  hibernate: "Hibernate",
  resume: "Resume",
  fork: "Fork",
  archive: "Archive",
  delete: "Delete",
};

function ActionButton({ capability }: Readonly<{ capability: SessionCapability }>) {
  const disabled = capability.availability === "disabled";
  const danger = capability.action === "cancel" || capability.action === "delete";
  const active = capability.action === "prompt" && !disabled;
  const style = disabled ? "cursor-not-allowed border-white/6 text-white/18" : active ? "border-[#c8ff5a]/30 bg-[#c8ff5a] text-[#151a0c] hover:bg-[#d5ff80]" : danger ? "border-[#ff9f6e]/20 text-[#ffb18b] hover:bg-[#ff9f6e]/8" : "border-white/10 text-white/55 hover:bg-white/5 hover:text-white/80";
  const label = actionLabels[capability.action];
  return <button type="button" disabled={disabled} title={disabled ? capability.reason : undefined} aria-label={disabled ? `${label} unavailable: ${capability.reason}` : label} className={`min-h-10 rounded-lg border px-3 py-2 text-xs font-semibold transition ${style}`}>{label}</button>;
}

function Panel({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) { return <section className="rounded-xl border border-white/8 bg-[#0c0f13] p-4"><h2 className="mb-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">{title}</h2><div className="space-y-3">{children}</div></section>; }
function Fact({ label, value, mono = false }: Readonly<{ label: string; value: string; mono?: boolean }>) { return <div className="flex items-start justify-between gap-4 text-xs"><span className="text-white/28">{label}</span><span className={`min-w-0 truncate text-right text-white/58 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span></div>; }
function EvidenceRow({ label, value, tone = "quiet", mono = false }: Readonly<{ label: string; value: string; tone?: "live" | "warn" | "quiet"; mono?: boolean }>) { const color = tone === "live" ? "text-[#c8ff5a]" : tone === "warn" ? "text-[#ffb18b]" : "text-white/58"; return <div className="flex items-center justify-between gap-4 text-xs"><span className="text-white/30">{label}</span><span className={`${color} ${mono ? "font-mono text-[10px]" : ""}`}>{value}</span></div>; }
function EnsembleRow({ role, state }: Readonly<{ role: string; state: "running" | "attention" | "completed" | "queued" }>) { const dot = state === "running" ? "bg-[#c8ff5a]" : state === "attention" ? "bg-[#ff9f6e]" : state === "completed" ? "bg-white/30" : "bg-[#8cb8ff]"; return <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-2 text-white/55"><span className={`size-1.5 rounded-full ${dot}`} />{role}</span><span className="text-[10px] capitalize text-white/28">{state}</span></div>; }
function eventDot(kind: (typeof timeline)[number]["kind"]) { if (kind === "finding") return "bg-[#ff9f6e] shadow-[0_0_8px_rgba(255,159,110,.55)]"; if (kind === "tool") return "bg-[#8cb8ff]"; if (kind === "agent") return "bg-[#c8ff5a]"; return "bg-white/25"; }
