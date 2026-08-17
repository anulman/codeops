import { sx } from "@/styles/sx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { SessionSnapshot } from "@codeops/codeops-contracts/session-broker";
import { sessionDisplayName, sessionSearchText, sessionWorkspaceLabel } from "@/lib/sessionIdentity";
import { SessionNotifications } from "./SessionNotifications";

interface AppShellProps {
  readonly children: ReactNode;
  readonly sessions?: readonly SessionSnapshot[];
  readonly activeSessionId?: string;
}

export function AppShell({ children, sessions = [], activeSessionId }: AppShellProps) {
  return (
    <div {...sx("min-h-dvh bg-[#111113] text-[#f3f3f1] lg:grid lg:grid-cols-[304px_minmax(0,1fr)]")}>
      <SessionNotifications />
      <aside {...sx("sticky top-0 hidden h-dvh min-h-0 flex-col border-r border-white/[0.07] bg-[#171719] lg:flex")}>
        <SidebarHeader />
        <SessionNavigator sessions={sessions} activeSessionId={activeSessionId} />
        <div {...sx("flex min-h-11 shrink-0 items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2 text-[11px] text-white/38")}>
          <span {...sx("flex items-center gap-2")}><span {...sx("size-1.5 rounded-full bg-[#54d18b] shadow-[0_0_7px_rgba(84,209,139,.7)]")} />Broker connected</span>
          <a href="https://github.com/anulman/codeops#license" target="_blank" rel="noreferrer" {...sx("transition hover:text-white/65")}>Legal &amp; source</a>
        </div>
      </aside>

      <div {...sx("min-w-0")}>
        <header {...sx("sticky top-0 z-2 flex h-13 items-center justify-between border-b border-white/[0.07] bg-[#151517]/94 px-4 backdrop-blur-xl lg:hidden")}>
          <Link to="/" {...sx("flex min-w-0 items-center gap-2.5")} aria-label="Agent Sessions home">
            <span {...sx("grid size-7 shrink-0 place-items-center rounded-lg bg-[#6d6af7] text-white shadow-[0_0_0_1px_rgba(255,255,255,.12)_inset]")}><PulseMark /></span>
            <span {...sx("truncate text-sm font-semibold tracking-[-0.02em]")}>Agent Sessions</span>
          </Link>
          <span {...sx("flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.12em] text-white/35")}>
            <span {...sx("flex items-center gap-1.5")}><span {...sx("size-1.5 rounded-full bg-[#54d18b]")} />Live</span>
            <a href="https://github.com/anulman/codeops#license" target="_blank" rel="noreferrer" {...sx("transition hover:text-white/65")}>Legal &amp; source</a>
          </span>
        </header>
        {children}
      </div>
    </div>
  );
}

function SidebarHeader() {
  return (
    <div {...sx("flex h-13 shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-3.5")}>
      <Link to="/" {...sx("flex min-w-0 items-center gap-2.5")} aria-label="Agent Sessions home">
        <span {...sx("grid size-7 shrink-0 place-items-center rounded-lg bg-[#6d6af7] text-white shadow-[0_0_0_1px_rgba(255,255,255,.12)_inset]")}><PulseMark /></span>
        <span {...sx("truncate text-sm font-semibold tracking-[-0.02em]")}>Agent Sessions</span>
      </Link>
      <Link to="/new" {...sx("ml-auto grid size-7 place-items-center rounded-lg border border-[#7774ff]/25 bg-[#7774ff]/10 text-lg text-[#a8a6ff] transition hover:bg-[#7774ff]/18 hover:text-white")} aria-label="New session">＋</Link>
    </div>
  );
}

function SessionNavigator({ sessions, activeSessionId }: Readonly<{ sessions: readonly SessionSnapshot[]; activeSessionId?: string }>) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => sessionSearchText(session.identity).toLowerCase().includes(needle));
  }, [query, sessions]);
  const attention = filtered.filter((session) => ["waiting_permission", "failed"].includes(session.state));
  const active = filtered.filter((session) => ["queued", "running", "checkpointing"].includes(session.state));
  const history = filtered.filter((session) => !attention.includes(session) && !active.includes(session));

  return (
    <div {...sx("flex min-h-0 flex-1 flex-col")}>
      <div {...sx("px-2.5 pb-2 pt-3")}>
        <label {...sx("relative block")}>
          <span {...sx("sr-only")}>Search sessions</span>
          <SearchIcon />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" {...sx("h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.035] pl-8 pr-3 text-xs text-white/80 outline-none placeholder:text-white/28 focus:border-[#7774ff]/55 focus:bg-white/[0.05] focus:ring-2 focus:ring-[#7774ff]/10")} />
          <span {...sx("pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-white/[0.07] px-1 py-0.5 font-mono text-[8px] text-white/22")}>⌘K</span>
        </label>
      </div>
      <nav {...sx("min-h-0 flex-1 overflow-y-auto px-2 pb-3")} aria-label="Agent sessions">
        <SessionGroup label="Needs attention" sessions={attention} activeSessionId={activeSessionId} />
        <SessionGroup label="Working" sessions={active} activeSessionId={activeSessionId} />
        <SessionGroup label="History" sessions={history.slice(0, 20)} activeSessionId={activeSessionId} quiet />
        {filtered.length === 0 ? <div {...sx("px-2 py-8 text-center text-xs text-white/28")}>No matching sessions.</div> : null}
      </nav>
    </div>
  );
}

function SessionGroup({ label, sessions, activeSessionId, quiet = false }: Readonly<{ label: string; sessions: readonly SessionSnapshot[]; activeSessionId?: string; quiet?: boolean }>) {
  if (sessions.length === 0) return null;
  return (
    <section {...sx("mt-3 first:mt-1")}>
      <h2 {...sx("px-2 pb-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/25")}>{label}</h2>
      <div {...sx("space-y-0.5")}>
        {sessions.map((session) => {
          const selected = session.sessionId === activeSessionId;
          return (
            <Link key={session.sessionId} to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} aria-current={selected ? "page" : undefined} {...sx(`group block rounded-lg px-2.5 py-2 transition ${selected ? "bg-white/[0.075] text-white shadow-[0_1px_0_rgba(255,255,255,.06)_inset]" : "text-white/64 hover:bg-white/[0.045] hover:text-white/88"}`)}>
              <div {...sx("flex min-w-0 items-center gap-2")}>
                <span {...sx(`size-1.5 shrink-0 rounded-full ${stateDot(session)}`)} />
                <span {...sx(`min-w-0 flex-1 truncate text-xs font-medium ${quiet && !selected ? "text-white/45" : ""}`)}>{sessionDisplayName(session.identity)}</span>
                <span {...sx(`shrink-0 font-mono text-[9px] tabular-nums ${selected ? "text-white/60" : "text-white/22"}`)}>{session.updatedAt.slice(11, 16)}</span>
              </div>
              <div {...sx(`mt-1 truncate pl-3.5 text-[10px] ${selected ? "text-white/65" : "text-white/28"}`)}>{sessionWorkspaceLabel(session.identity)}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function SearchIcon() {
  return <svg viewBox="0 0 20 20" {...sx("pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/26")} aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m12.5 12.5 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function PulseMark() {
  return <svg viewBox="0 0 20 20" {...sx("size-4")} aria-hidden="true"><path d="M2 10h3l2-5 3.2 10L13 8l1.4 2H18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function stateDot(session: SessionSnapshot) {
  if (session.state === "running") return "bg-[#54d18b] shadow-[0_0_7px_rgba(84,209,139,.65)]";
  if (session.state === "waiting_permission" || session.state === "failed") return "bg-[#ff9b73] shadow-[0_0_7px_rgba(255,155,115,.55)]";
  if (session.state === "queued" || session.state === "checkpointing") return "bg-[#6da8ff]";
  return "bg-current opacity-30";
}
