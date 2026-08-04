import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { sessions, stateCounts, type SessionState } from "@/lib/sessionFixtures";

export const Route = createFileRoute("/")({
  component: SessionsPage,
});

const filters = ["all", "running", "attention", "completed", "archived"] as const;
type Filter = (typeof filters)[number];

function SessionsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const counts = stateCounts(sessions);
  const visibleSessions = useMemo(() => sessions.filter((session) => {
    const matchesState = filter === "all" || session.state === filter || (filter === "running" && session.state === "queued");
    const searchable = `${session.title} ${session.role} ${session.branch} ${session.sha}`.toLowerCase();
    return matchesState && searchable.includes(query.trim().toLowerCase());
  }), [filter, query]);

  return (
    <AppShell>
      <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <section className="grid gap-8 border-b border-white/8 pb-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div>
            <div className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#c8ff5a]/72">
              <span className="h-px w-7 bg-[#c8ff5a]/50" /> Live control plane
            </div>
            <h1 className="max-w-3xl text-4xl font-medium leading-[0.98] tracking-[-0.055em] text-[#f6f4ef] sm:text-5xl lg:text-6xl">
              See what every agent is doing.
            </h1>
            <p className="mt-5 max-w-2xl text-sm leading-6 text-white/48 sm:text-base">
              One operating surface for live work, review evidence, interventions, and durable session history.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-white/8 bg-white/8">
            <Metric label="Active" value={counts.active} tone="lime" />
            <Metric label="Needs attention" value={counts.attention} tone="orange" />
            <Metric label="Archived" value={counts.archived} />
          </div>
        </section>

        <section className="mt-8">
          <div className="flex flex-col gap-4 border-b border-white/8 pb-5 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-1.5" aria-label="Session filters">
              {filters.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setFilter(item)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition ${filter === item ? "bg-white text-[#0b0d10]" : "text-white/42 hover:bg-white/6 hover:text-white/70"}`}
                >
                  {item}
                </button>
              ))}
            </div>
            <label className="relative block w-full md:w-72">
              <span className="sr-only">Search sessions</span>
              <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/28" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search task, branch, SHA…" className="h-9 w-full rounded-lg border border-white/8 bg-white/[0.025] pl-9 pr-3 text-xs text-white/80 outline-none placeholder:text-white/24 focus:border-[#c8ff5a]/35 focus:ring-2 focus:ring-[#c8ff5a]/8" />
            </label>
          </div>

          <div className="mt-4 hidden grid-cols-[minmax(280px,1.5fr)_minmax(180px,0.9fr)_120px_120px_100px] gap-4 px-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/28 lg:grid">
            <span>Session</span><span>Now</span><span>State</span><span>Evidence</span><span>Updated</span>
          </div>
          <div className="mt-2 divide-y divide-white/6 border-y border-white/8">
            {visibleSessions.map((session) => <SessionRow key={session.id} session={session} />)}
            {visibleSessions.length === 0 ? <div className="py-20 text-center text-sm text-white/35">No sessions match this view.</div> : null}
          </div>
        </section>
      </main>
    </AppShell>
  );
}

function Metric({ label, value, tone = "quiet" }: Readonly<{ label: string; value: number; tone?: "lime" | "orange" | "quiet" }>) {
  const valueStyle = tone === "lime" ? "text-[#c8ff5a]" : tone === "orange" ? "text-[#ffb18b]" : "text-white/65";
  return <div className="min-w-24 bg-[#0c0f13] px-4 py-3.5"><div className={`text-2xl font-medium tracking-[-0.04em] ${valueStyle}`}>{value}</div><div className="mt-1 max-w-24 text-[9px] font-semibold uppercase leading-4 tracking-[0.13em] text-white/30">{label}</div></div>;
}

function SessionRow({ session }: Readonly<{ session: (typeof sessions)[number] }>) {
  return (
    <Link to="/sessions/$sessionId" params={{ sessionId: session.id }} className="group grid gap-4 px-3 py-5 transition hover:bg-white/[0.025] sm:px-4 lg:grid-cols-[minmax(280px,1.5fr)_minmax(180px,0.9fr)_120px_120px_100px] lg:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`size-1.5 shrink-0 rounded-full ${stateDot(session.state)}`} />
          <span className="truncate text-sm font-medium tracking-[-0.01em] text-white/88 group-hover:text-white">{session.role}</span>
        </div>
        <div className="mt-1.5 truncate pl-3.5 text-xs text-white/36">{session.title} · <span className="font-mono">{session.sha}</span></div>
      </div>
      <div><div className="text-xs text-white/65">{session.phase}</div><div className="mt-1 text-[11px] text-white/28">{session.elapsed}</div></div>
      <div><StatusBadge state={session.state} /></div>
      <div className="text-xs text-white/46">{session.verdict}<span className="ml-1 text-white/24">· {session.findings}</span></div>
      <div className="flex items-center justify-between text-xs text-white/32"><span>{session.updated}</span><span className="translate-x-0 text-white/20 transition group-hover:translate-x-1 group-hover:text-[#c8ff5a]">→</span></div>
    </Link>
  );
}

function stateDot(state: SessionState) {
  if (state === "running") return "bg-[#c8ff5a] shadow-[0_0_8px_rgba(200,255,90,0.8)]";
  if (state === "attention") return "bg-[#ff9f6e] shadow-[0_0_8px_rgba(255,159,110,0.7)]";
  if (state === "queued") return "bg-[#8cb8ff]";
  return "bg-white/25";
}
