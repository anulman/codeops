import { useMemo, useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { getProviderEffectFleet, getSessionFleet, reconcileProviderEffect } from "@/lib/sessionBroker.data";
import { sessionDisplayName, sessionSearchText, sessionWorkspaceDetail, sessionWorkspaceLabel } from "@/lib/sessionIdentity";
import type { SessionSnapshot } from "@codeops/codeops-contracts/session-broker";
import type { ProviderEffectReceipt } from "@codeops/codeops-contracts/github-mutations";

export const Route = createFileRoute("/")({
  loader: async () => {
    const [sessions, providerEffects] = await Promise.all([
      getSessionFleet(),
      getProviderEffectFleet(),
    ]);
    return { sessions, providerEffects };
  },
  component: SessionsPage,
});

const filters = ["all", "running", "attention", "completed", "archived"] as const;
type Filter = (typeof filters)[number];

function SessionsPage() {
  const { sessions, providerEffects } = Route.useLoaderData();
  return (
    <AppShell sessions={sessions}>
      <DesktopOverview sessions={sessions} providerEffects={providerEffects} />
      <MobileFleet sessions={sessions} providerEffects={providerEffects} />
    </AppShell>
  );
}

function DesktopOverview({ sessions, providerEffects }: Readonly<{ sessions: readonly SessionSnapshot[]; providerEffects: readonly ProviderEffectReceipt[] }>) {
  const counts = stateCounts(sessions);
  const attention = sessions.filter((session) => matchesFilter(session, "attention"));
  const active = sessions.filter((session) => matchesFilter(session, "running"));
  const recent = sessions.filter((session) => !attention.includes(session) && !active.includes(session)).slice(0, 6);
  const unknownEffects = providerEffects.filter((effect) => effect.state === "unknown" || effect.state === "attempting");
  return (
    <main className="hidden min-h-dvh bg-[#111113] lg:block">
      <div className="flex h-13 items-center justify-between border-b border-white/[0.07] px-5">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-[-0.01em]">Sessions <span className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-white/35">{sessions.length}</span></div>
        <div className="flex items-center gap-3"><div className="flex items-center gap-2 text-[11px] text-white/35"><span className="size-1.5 rounded-full bg-[#54d18b]" />Live broker state</div><Link to="/new" className="grid h-8 place-items-center rounded-lg bg-[#6d6af7] px-3 text-[11px] font-semibold text-white transition hover:bg-[#7c79ff]">New session</Link></div>
      </div>
      <div className="mx-auto max-w-5xl px-8 py-10 xl:px-12">
        <div className="flex items-end justify-between gap-8 border-b border-white/[0.07] pb-7">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/28">CodeOps control surface</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] text-white/92">Agent Sessions</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-white/40">Follow active work, respond when an agent needs you, and reopen durable session history.</p>
          </div>
          <div className="grid grid-cols-3 divide-x divide-white/[0.07] overflow-hidden rounded-xl border border-white/[0.07] bg-[#171719]">
            <Metric label="Active" value={counts.active} tone="active" />
            <Metric label="Needs attention" value={counts.attention} tone="attention" />
            <Metric label="Archived" value={counts.archived} />
          </div>
        </div>

        <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]">
          <div className="space-y-8">
            <OverviewGroup title="Working now" description="Sessions with an active or pending runtime." sessions={active} empty="No agents are working right now." />
            {attention.length > 0 ? <OverviewGroup title="Needs attention" description="Permission requests and failed sessions." sessions={attention} tone="attention" /> : null}
            {unknownEffects.length > 0 ? <ProviderEffectAttention effects={unknownEffects} /> : null}
          </div>
          <section>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold text-white/72">Recent history</h2><span className="text-[10px] text-white/24">Latest first</span></div>
            <div className="divide-y divide-white/[0.055] rounded-xl border border-white/[0.07] bg-[#151517] px-3">
              {recent.map((session) => <CompactSession key={session.sessionId} session={session} />)}
              {recent.length === 0 ? <div className="py-10 text-center text-xs text-white/28">No session history yet.</div> : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function MobileFleet({ sessions, providerEffects }: Readonly<{ sessions: readonly SessionSnapshot[]; providerEffects: readonly ProviderEffectReceipt[] }>) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const counts = stateCounts(sessions);
  const visibleSessions = useMemo(() => sessions.filter((session) => {
    const searchable = sessionSearchText(session.identity).toLowerCase();
    return matchesFilter(session, filter) && searchable.includes(query.trim().toLowerCase());
  }), [filter, query, sessions]);
  return (
    <main className="px-4 pb-10 pt-6 lg:hidden">
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/28">CodeOps</p><h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">Sessions</h1></div>
        <div className="flex items-center gap-3 pt-1 text-[11px] text-white/35"><span><strong className="text-[#6ee2a0]">{counts.active}</strong> Active</span><Link to="/new" className="grid size-9 place-items-center rounded-xl bg-[#6d6af7] text-xl text-white" aria-label="New session">＋</Link></div>
      </div>
      <label className="relative mt-5 block">
        <span className="sr-only">Search sessions</span><SearchIcon />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" className="h-10 w-full rounded-xl border border-white/[0.07] bg-white/[0.035] pl-9 pr-3 text-sm text-white/82 outline-none placeholder:text-white/28 focus:border-[#7774ff]/55 focus:ring-2 focus:ring-[#7774ff]/10" />
      </label>
      <div className="no-scrollbar -mx-4 mt-4 flex gap-1 overflow-x-auto border-b border-white/[0.07] px-4 pb-3" role="group" aria-label="Session filters">
        {filters.map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition ${filter === item ? "bg-white/[0.09] text-white" : "text-white/38"}`}>{item}</button>)}
      </div>
      <div className="mt-2 divide-y divide-white/[0.055]">
        {visibleSessions.map((session) => <MobileSessionRow key={session.sessionId} session={session} />)}
        {visibleSessions.length === 0 ? <div className="py-20 text-center text-sm text-white/30">No sessions match this view.</div> : null}
      </div>
      {providerEffects.some((effect) => effect.state === "unknown" || effect.state === "attempting") ? (
        <div className="mt-8">
          <ProviderEffectAttention effects={providerEffects.filter((effect) => effect.state === "unknown" || effect.state === "attempting")} />
        </div>
      ) : null}
    </main>
  );
}

function ProviderEffectAttention({ effects }: Readonly<{ effects: readonly ProviderEffectReceipt[] }>) {
  return (
    <section>
      <div className="mb-3"><h2 className="text-xs font-semibold text-[#ffae8d]">Provider effects need reconciliation</h2><p className="mt-1 text-[11px] text-white/32">CodeOps will not retry these GitHub mutations automatically.</p></div>
      <div className="divide-y divide-white/[0.055] overflow-hidden rounded-xl border border-[#ff9b73]/18 bg-[#151517]">
        {effects.map((effect) => (
          <div key={effect.effectId} className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-medium text-white/78">{effect.repository} · {effect.operation.replaceAll("_", " ")}</span><span className="rounded-md bg-[#ff9b73]/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#ffae8d]">{effect.state}</span></div>
            <div className="mt-2 grid gap-1 font-mono text-[10px] text-white/32 sm:grid-cols-2">
              <span>Target: {effect.pullRequestNumber === null ? effect.targetId : `PR #${effect.pullRequestNumber}`}</span>
              <span>Expected: {effect.expectedHeadSha.slice(0, 12)}</span>
              <span>Attempt: {effect.attemptedAt ?? "not started"}</span>
              <span>Action: {effect.reconciliationAction.replaceAll("_", " ")}</span>
            </div>
            {effect.state === "unknown" ? <ReconcileEffectButton effectId={effect.effectId} /> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ReconcileEffectButton({ effectId }: Readonly<{ effectId: string }>) {
  const router = useRouter();
  const reconcile = useServerFn(reconcileProviderEffect);
  const [status, setStatus] = useState<"idle" | "working" | "failed">("idle");
  return (
    <button
      type="button"
      disabled={status === "working"}
      onClick={async () => {
        setStatus("working");
        try {
          await reconcile({ data: { effectId } });
          await router.invalidate();
          setStatus("idle");
        } catch {
          setStatus("failed");
        }
      }}
      className="mt-3 rounded-lg border border-[#ff9b73]/25 bg-[#ff9b73]/8 px-3 py-1.5 text-[11px] font-semibold text-[#ffbc9f] transition hover:bg-[#ff9b73]/14 disabled:opacity-45"
    >
      {status === "working" ? "Reconciling…" : status === "failed" ? "Reconciliation failed — retry read" : "Run reconciliation read"}
    </button>
  );
}

function OverviewGroup({ title, description, sessions, empty, tone = "default" }: Readonly<{ title: string; description: string; sessions: readonly SessionSnapshot[]; empty?: string; tone?: "default" | "attention" }>) {
  return (
    <section>
      <div className="mb-3"><h2 className="text-xs font-semibold text-white/72">{title}</h2><p className="mt-1 text-[11px] text-white/28">{description}</p></div>
      <div className={`divide-y divide-white/[0.055] overflow-hidden rounded-xl border bg-[#151517] ${tone === "attention" ? "border-[#ff9b73]/18" : "border-white/[0.07]"}`}>
        {sessions.map((session) => <DesktopSessionRow key={session.sessionId} session={session} />)}
        {sessions.length === 0 ? <div className="px-4 py-10 text-center text-xs text-white/28">{empty}</div> : null}
      </div>
    </section>
  );
}

function DesktopSessionRow({ session }: Readonly<{ session: SessionSnapshot }>) {
  return (
    <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-5 px-4 py-3.5 transition hover:bg-white/[0.035]">
      <div className="min-w-0"><div className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${stateDot(session)}`} /><span className="truncate text-sm font-medium text-white/78 group-hover:text-white">{sessionDisplayName(session.identity)}</span></div><p className="mt-1 truncate pl-3.5 font-mono text-[10px] text-white/26">{sessionWorkspaceDetail(session.identity)}</p></div>
      <StatusBadge state={session.state} />
      <span className="font-mono text-[10px] text-white/22">{session.updatedAt.slice(11, 16)}</span>
    </Link>
  );
}

function CompactSession({ session }: Readonly<{ session: SessionSnapshot }>) {
  return <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="group flex items-center gap-2.5 py-3 text-xs"><span className={`size-1.5 shrink-0 rounded-full ${stateDot(session)}`} /><span className="min-w-0 flex-1 truncate text-white/52 group-hover:text-white/78">{sessionDisplayName(session.identity)}</span><span className="font-mono text-[9px] text-white/20">{session.updatedAt.slice(11, 16)}</span></Link>;
}

function MobileSessionRow({ session }: Readonly<{ session: SessionSnapshot }>) {
  return (
    <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="group block py-4">
      <div className="flex items-center gap-2"><span className={`size-1.5 shrink-0 rounded-full ${stateDot(session)}`} /><span className="min-w-0 flex-1 truncate text-[15px] font-medium text-white/82">{sessionDisplayName(session.identity)}</span><span className="font-mono text-[10px] text-white/24">{session.updatedAt.slice(11, 16)}</span></div>
      <div className="mt-1.5 flex items-center justify-between gap-3 pl-3.5"><span className="min-w-0 truncate text-xs text-white/34">{sessionWorkspaceLabel(session.identity)}</span><StatusBadge state={session.state} /></div>
    </Link>
  );
}

function Metric({ label, value, tone = "quiet" }: Readonly<{ label: string; value: number; tone?: "active" | "attention" | "quiet" }>) {
  const color = tone === "active" ? "text-[#6ee2a0]" : tone === "attention" ? "text-[#ffae8d]" : "text-white/60";
  return <div className="min-w-24 px-4 py-3"><div className={`text-xl font-semibold tracking-[-0.035em] ${color}`}>{value}</div><div className="mt-1 max-w-24 text-[8px] font-semibold uppercase leading-3 tracking-[0.12em] text-white/25">{label}</div></div>;
}

function SearchIcon() { return <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/26" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m12.5 12.5 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>; }
function stateDot(session: SessionSnapshot) { if (session.state === "running") return "bg-[#54d18b] shadow-[0_0_7px_rgba(84,209,139,.65)]"; if (session.state === "waiting_permission" || session.state === "failed") return "bg-[#ff9b73]"; if (session.state === "queued" || session.state === "checkpointing") return "bg-[#6da8ff]"; return "bg-white/22"; }
function matchesFilter(session: SessionSnapshot, filter: Filter): boolean { if (filter === "all") return true; if (filter === "running") return ["queued", "running", "checkpointing"].includes(session.state); if (filter === "attention") return ["waiting_permission", "failed"].includes(session.state); if (filter === "completed") return ["completed", "cancelled"].includes(session.state); return ["hibernated", "archived"].includes(session.state); }
function stateCounts(items: readonly SessionSnapshot[]) { return { active: items.filter((item) => matchesFilter(item, "running")).length, attention: items.filter((item) => matchesFilter(item, "attention")).length, archived: items.filter((item) => matchesFilter(item, "archived")).length }; }
