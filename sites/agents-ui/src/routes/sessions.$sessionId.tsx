import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { executeSessionCommand, getSessionDetail, getSessionEvents, getSessionFleet } from "@/lib/sessionBroker.data";
import type { SessionCommand, SessionActionType, SessionCapability, SessionEvent, SessionSnapshot } from "@renoconcierge/codeops-contracts/session-broker";

export const Route = createFileRoute("/sessions/$sessionId")({
  loader: async ({ params }) => {
    const [session, fleet] = await Promise.all([getSessionDetail({ data: { sessionId: params.sessionId } }), getSessionFleet()]);
    const events = await getSessionEvents({ data: { sessionId: params.sessionId, afterCursor: Math.max(0, (session?.eventCursor ?? 0) - 500), limit: 500 } });
    return { session, events, fleet };
  },
  component: SessionCockpit,
});

function SessionCockpit() {
  const { session, events, fleet } = Route.useLoaderData();
  const router = useRouter();
  useEffect(() => {
    if (!session || session.state === "deleted") return;
    let invalidating = false;
    const timer = window.setInterval(() => {
      if (invalidating) return;
      invalidating = true;
      void router.invalidate().finally(() => { invalidating = false; });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [router, session?.sessionId, session?.state]);
  if (!session) return <AppShell sessions={fleet}><main className="grid min-h-[calc(100dvh-52px)] place-items-center px-4 text-sm text-white/42 lg:min-h-dvh">Session not found.</main></AppShell>;
  const relatedSessions = fleet.filter((item) => item.identity.workflowId === session.identity.workflowId && item.sessionId !== session.sessionId).slice(0, 6);
  const permissionCapability = session.capabilities.find((item) => item.action === "respond_permission");

  return (
    <AppShell sessions={fleet} activeSessionId={session.sessionId}>
      <main className="min-h-[calc(100dvh-52px)] bg-[#111113] lg:min-h-dvh xl:grid xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="relative min-w-0 xl:flex xl:h-dvh xl:min-h-0 xl:flex-col">
          <CockpitHeader session={session} />
          <div className="no-scrollbar flex gap-1 overflow-x-auto border-b border-white/[0.06] bg-[#131315] px-3 py-2 sm:px-5" aria-label="Session actions">
            {session.capabilities.map((capability) => capability.action === "prompt" ? null : <ActionButton key={capability.action} capability={capability} session={session} />)}
          </div>

          <div className="min-h-0 xl:flex-1 xl:overflow-y-auto">
            <div className="mx-auto max-w-3xl px-4 pb-5 pt-6 sm:px-8 sm:pt-9">
              <MobileInspector session={session} />
              {session.pendingPermission && permissionCapability ? <PermissionCard session={session} capability={permissionCapability} /> : null}
              <div className="mb-7 flex items-center gap-3">
                <div className="grid size-8 place-items-center rounded-lg border border-white/[0.07] bg-white/[0.035] text-white/42"><ActivityIcon /></div>
                <div><h2 className="text-sm font-semibold text-white/80">Session activity</h2><p className="mt-0.5 text-[11px] text-white/28">Durable broker events · newest state at cursor {session.eventCursor}</p></div>
              </div>
              <div className="space-y-1">
                {events.events.map((event) => <EventRow key={event.eventId} event={event} />)}
                {events.events.length === 0 ? <div className="py-16 text-center text-sm text-white/28">No events after this cursor.</div> : null}
              </div>
            </div>
            <SessionComposer session={session} />
          </div>
        </section>

        <aside className="hidden h-dvh min-h-0 overflow-y-auto border-l border-white/[0.07] bg-[#151517] px-4 py-5 xl:block">
          <Inspector session={session} relatedSessions={relatedSessions} />
        </aside>
      </main>
    </AppShell>
  );
}

function CockpitHeader({ session }: Readonly<{ session: SessionSnapshot }>) {
  return (
    <header className="sticky top-13 z-2 flex min-h-14 items-center gap-3 border-b border-white/[0.07] bg-[#151517]/95 px-3 backdrop-blur-xl sm:px-5 lg:top-0">
      <Link to="/" className="grid size-8 shrink-0 place-items-center rounded-lg text-white/35 transition hover:bg-white/[0.05] hover:text-white/72 lg:hidden" aria-label="All sessions">←</Link>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2"><h1 className="truncate text-sm font-semibold tracking-[-0.01em] text-white/88">{session.identity.runId}</h1><StatusBadge state={session.state} /></div>
        <p className="mt-0.5 truncate font-mono text-[10px] text-white/27">{session.identity.branch} · {session.identity.baseSha.slice(0, 7)}</p>
      </div>
      <div className="hidden items-center gap-2 text-[10px] text-white/25 sm:flex"><span>Generation {session.generation}</span><span>·</span><span>Cursor {session.eventCursor}</span></div>
    </header>
  );
}

function EventRow({ event }: Readonly<{ event: SessionEvent }>) {
  return (
    <article className="group grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-3.5">
      <div className={`mt-0.5 grid size-7 place-items-center rounded-lg border ${eventTone(event)}`}><EventIcon event={event} /></div>
      <div className="min-w-0 border-b border-white/[0.045] pb-4 group-last:border-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><h3 className="text-sm font-medium capitalize text-white/74">{event.type.replaceAll("_", " ")}</h3><span className="font-mono text-[9px] text-white/22">#{event.cursor}</span><time className="ml-auto font-mono text-[9px] text-white/20">{event.occurredAt.slice(11, 19)}</time></div>
        <p className="mt-1.5 text-xs leading-5 text-white/32">{eventDescription(event)}</p>
      </div>
    </article>
  );
}

function PermissionCard({ session, capability }: Readonly<{ session: SessionSnapshot; capability: SessionCapability }>) {
  const request = session.pendingPermission;
  if (!request) return null;
  return (
    <section className="mb-7 rounded-xl border border-[#ff9b73]/18 bg-[#ff9b73]/[0.055] p-4 shadow-[0_12px_40px_rgba(0,0,0,.16)]">
      <div className="flex items-start gap-3"><span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-[#ff9b73]/10 text-[#ffae8d]">!</span><div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-[#ffae8d]/70">Input required</p><h2 className="mt-1 text-sm font-semibold text-white/86">{request.title}</h2><p className="mt-1.5 text-xs leading-5 text-white/42">{request.description}</p><div className="mt-3"><ActionButton capability={capability} session={session} prominent /></div></div></div>
    </section>
  );
}

function SessionComposer({ session }: Readonly<{ session: SessionSnapshot }>) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capability = useMemo(() => session.capabilities.find((item) => item.action === "prompt"), [session.capabilities]);
  const disabled = !capability || capability.availability === "disabled" || pending || !prompt.trim();
  const send = async () => {
    if (disabled || !session.lease) return;
    setError(null);
    setPending(true);
    try {
      await executeSessionCommand({ data: { version: "codeops.session-command/v1", sessionId: session.sessionId, generation: session.generation, leaseId: session.lease.leaseId, idempotencyKey: crypto.randomUUID(), type: "prompt", prompt: prompt.trim() } });
      setPrompt("");
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session command failed.");
    } finally { setPending(false); }
  };
  return (
    <div className="sticky bottom-0 z-1 bg-gradient-to-t from-[#111113] via-[#111113] to-transparent px-3 pb-3 pt-10 sm:px-6 sm:pb-5">
      <div className="mx-auto max-w-3xl rounded-2xl border border-white/[0.09] bg-[#1a1a1d] p-2 shadow-[0_18px_60px_rgba(0,0,0,.38)] focus-within:border-[#7774ff]/45 focus-within:ring-2 focus-within:ring-[#7774ff]/10">
        <label className="block"><span className="sr-only">Prompt this live session</span><textarea rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={capability?.availability === "disabled" ? capability.reason : "Ask this session to continue, inspect, or change something…"} disabled={capability?.availability === "disabled"} className="max-h-36 min-h-14 w-full resize-none bg-transparent px-2 py-2 text-sm leading-5 text-white/82 outline-none placeholder:text-white/24 disabled:cursor-not-allowed" /></label>
        <div className="flex items-center justify-between gap-3 px-1 pb-1"><div className="flex min-w-0 items-center gap-2 text-[10px] text-white/24"><span className="hidden sm:inline">Enter to send · Shift Enter for a new line</span>{error ? <span role="alert" className="truncate text-[#ff989d]">{error}</span> : null}</div><button type="button" disabled={disabled} onClick={() => void send()} aria-label="Prompt" className="grid size-8 shrink-0 place-items-center rounded-full bg-[#6d6af7] text-white transition hover:bg-[#7c79ff] disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-white/18">{pending ? <span className="size-3 animate-pulse rounded-full bg-current" /> : "↑"}</button></div>
      </div>
    </div>
  );
}

const actionLabels: Record<SessionActionType, string> = { prompt: "Prompt", respond_permission: "Approve / deny", cancel: "Cancel", checkpoint: "Checkpoint", hibernate: "Hibernate", resume: "Resume", fork: "Fork", archive: "Archive", delete: "Delete" };

function commandForAction(session: SessionSnapshot, action: SessionActionType): SessionCommand | null {
  if (!session.lease) throw new Error("This session no longer has a durable lease identity.");
  const base = { version: "codeops.session-command/v1" as const, sessionId: session.sessionId, generation: session.generation, leaseId: session.lease.leaseId, idempotencyKey: crypto.randomUUID() };
  if (action === "prompt") { const prompt = window.prompt("Prompt this live session:")?.trim(); return prompt ? { ...base, type: action, prompt } : null; }
  if (action === "respond_permission") {
    const request = session.pendingPermission; if (!request) throw new Error("There is no pending permission request.");
    const choices = request.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
    const answer = window.prompt(`${request.title}\n\n${request.description}\n\n${choices}\n\nEnter an option number, or "deny".`)?.trim();
    if (!answer) return null;
    if (answer.toLowerCase() === "deny") return { ...base, type: action, permissionRequestId: request.requestId, decision: { outcome: "denied" } };
    const selected = request.options[Number(answer) - 1]; if (!selected) throw new Error("Choose one of the listed option numbers, or deny.");
    return { ...base, type: action, permissionRequestId: request.requestId, decision: { outcome: "selected", optionId: selected.optionId } };
  }
  if (action === "cancel" || action === "archive" || action === "delete") {
    if (action === "delete" && !window.confirm("Permanently delete this archived session and its checkpoint material?")) return null;
    const reason = window.prompt(`Reason to ${action} this session:`)?.trim(); if (!reason) return null;
    return action === "delete" ? { ...base, type: action, reason, destructiveAuthorizationId: crypto.randomUUID() } : { ...base, type: action, reason };
  }
  if (action === "checkpoint") return { ...base, type: action };
  if (action === "hibernate") { const reason = window.prompt("Optional hibernation note:")?.trim(); return { ...base, type: action, ...(reason ? { reason } : {}) }; }
  const checkpoint = session.checkpoint; if (!checkpoint) throw new Error(`${action} requires a committed checkpoint.`);
  if (action === "resume") return { ...base, type: action, checkpointId: checkpoint.checkpointId };
  if (action === "fork") { const title = window.prompt("Title for the forked session:")?.trim(); return title ? { ...base, type: action, checkpointId: checkpoint.checkpointId, parentEventCursor: session.eventCursor, title } : null; }
  return null;
}

function ActionButton({ capability, session, prominent = false }: Readonly<{ capability: SessionCapability; session: SessionSnapshot; prominent?: boolean }>) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null);
  const disabled = capability.availability === "disabled" || pending; const danger = capability.action === "cancel" || capability.action === "delete"; const label = actionLabels[capability.action]; const unavailableReason = capability.availability === "disabled" ? capability.reason : undefined;
  const run = async () => { setError(null); try { const command = commandForAction(session, capability.action); if (!command) return; setPending(true); await executeSessionCommand({ data: command }); await router.invalidate(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Session command failed."); } finally { setPending(false); } };
  const style = disabled ? "cursor-not-allowed border-white/[0.05] text-white/18" : prominent ? "border-[#ff9b73]/20 bg-[#ff9b73]/10 text-[#ffc0a7] hover:bg-[#ff9b73]/15" : danger ? "border-[#ff747b]/13 text-[#ff989d]/70 hover:bg-[#ff747b]/8 hover:text-[#ff989d]" : capability.action === "prompt" ? "border-[#7774ff]/20 bg-[#7774ff]/8 text-[#aaa8ff] hover:bg-[#7774ff]/13" : "border-white/[0.065] bg-white/[0.025] text-white/48 hover:bg-white/[0.055] hover:text-white/78";
  return <div className="shrink-0"><button type="button" disabled={disabled} onClick={() => void run()} title={unavailableReason ?? error ?? undefined} aria-label={disabled ? `${label} unavailable: ${unavailableReason ?? "Command in progress."}` : label} className={`h-8 whitespace-nowrap rounded-lg border px-2.5 text-[11px] font-medium transition ${style}`}>{pending ? "Working…" : label}</button>{error ? <span role="alert" className="sr-only">{error}</span> : null}</div>;
}

function Inspector({ session, relatedSessions }: Readonly<{ session: SessionSnapshot; relatedSessions: readonly SessionSnapshot[] }>) {
  return <div className="space-y-6"><InspectorSection title="Execution"><Fact label="Repository" value={session.identity.repository} /><Fact label="Branch" value={session.identity.branch} mono /><Fact label="Commit" value={session.identity.baseSha.slice(0, 12)} mono /><Fact label="Worker" value={session.lease?.status === "active" ? session.lease.holderId : "No active worker"} mono /></InspectorSection><InspectorSection title="Evidence"><Fact label="Event cursor" value={String(session.eventCursor)} /><Fact label="Checkpoint" value={session.checkpoint ? "Committed" : "None"} tone={session.checkpoint ? "success" : "quiet"} /><Fact label="References" value={String(session.checkpoint?.evidenceReferences.length ?? 0)} /><Fact label="Patch" value={session.checkpoint?.patchDigest?.slice(0, 18) ?? "Not checkpointed"} mono /></InspectorSection><InspectorSection title="Session boundary"><Fact label="Parent" value={session.identity.parentSessionId ?? "Root session"} mono /><Fact label="Fork cursor" value={session.identity.forkedAtCursor === null ? "—" : String(session.identity.forkedAtCursor)} /><Fact label="Permission" value={session.pendingPermission?.title ?? "None pending"} /></InspectorSection><InspectorSection title="Ensemble">{relatedSessions.map((item) => <RelatedSession key={item.sessionId} session={item} />)}{relatedSessions.length === 0 ? <p className="text-xs text-white/28">No related sessions.</p> : null}</InspectorSection><details className="border-t border-white/[0.06] pt-4"><summary className="cursor-pointer list-none text-[10px] font-semibold uppercase tracking-[0.13em] text-white/28">Protocol diagnostics <span className="float-right">＋</span></summary><pre className="mt-4 overflow-x-auto rounded-lg bg-black/20 p-3 font-mono text-[9px] leading-5 text-white/28">session/update{`\n`}broker: {session.sessionId}{`\n`}workflow: {session.identity.workflowId}{`\n`}sequence: {session.eventCursor}{`\n`}transport: server RPC</pre></details></div>;
}

function MobileInspector({ session }: Readonly<{ session: SessionSnapshot }>) {
  return <details className="mb-6 rounded-xl border border-white/[0.07] bg-white/[0.025] px-4 py-3 xl:hidden"><summary className="cursor-pointer list-none text-xs font-medium text-white/48">Session details <span className="float-right text-white/22">＋</span></summary><div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4"><Fact label="Repository" value={session.identity.repository} /><Fact label="Commit" value={session.identity.baseSha.slice(0, 12)} mono /><Fact label="Generation" value={String(session.generation)} /><Fact label="Checkpoint" value={session.checkpoint ? "Committed" : "None"} /></div></details>;
}

function InspectorSection({ title, children }: Readonly<{ title: string; children: ReactNode }>) { return <section><h2 className="mb-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-white/24">{title}</h2><div className="space-y-2.5">{children}</div></section>; }
function Fact({ label, value, mono = false, tone = "quiet" }: Readonly<{ label: string; value: string; mono?: boolean; tone?: "success" | "quiet" }>) { return <div className="flex items-start justify-between gap-4 text-[11px]"><span className="shrink-0 text-white/25">{label}</span><span className={`min-w-0 truncate text-right ${tone === "success" ? "text-[#6ee2a0]" : "text-white/48"} ${mono ? "font-mono text-[10px]" : ""}`}>{value}</span></div>; }
function RelatedSession({ session }: Readonly<{ session: SessionSnapshot }>) { return <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="flex items-center gap-2 text-xs text-white/42 transition hover:text-white/75"><span className={`size-1.5 rounded-full ${session.state === "running" ? "bg-[#54d18b]" : "bg-white/20"}`} /><span className="min-w-0 flex-1 truncate">{session.identity.runId}</span><span className="shrink-0 text-[9px] capitalize text-white/22">{session.state.replaceAll("_", " ")}</span></Link>; }
function ActivityIcon() { return <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true"><path d="M3 10h3l2-5 3.2 10L14 8l1.2 2H17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function EventIcon({ event }: Readonly<{ event: SessionEvent }>) { return <span className="text-[10px] font-bold">{event.type === "permission_requested" ? "?" : event.type === "state_changed" ? "↻" : event.type === "acp_update" ? "·" : "✓"}</span>; }
function eventTone(event: SessionEvent) { if (event.type === "permission_requested") return "border-[#ff9b73]/18 bg-[#ff9b73]/8 text-[#ffae8d]"; if (event.type === "state_changed") return "border-[#54d18b]/15 bg-[#54d18b]/7 text-[#6ee2a0]"; if (event.type === "acp_update") return "border-[#6da8ff]/15 bg-[#6da8ff]/7 text-[#8dbbff]"; return "border-white/[0.06] bg-white/[0.025] text-white/34"; }
function eventDescription(event: SessionEvent) { if (event.type === "permission_requested") return `The runtime paused for operator input in generation ${event.generation}.`; if (event.type === "state_changed") return `The broker committed a lifecycle state transition in generation ${event.generation}.`; if (event.type === "acp_update") return `The ACP runtime recorded a durable progress update in generation ${event.generation}.`; if (event.type === "command_committed") return `The broker committed an exact session command in generation ${event.generation}.`; return `Durable broker event recorded in generation ${event.generation}.`; }
