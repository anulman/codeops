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
  const [optimisticPrompt, setOptimisticPrompt] = useState<{
    readonly text: string;
    readonly afterCursor: number;
  } | null>(null);
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
  useEffect(() => {
    if (
      optimisticPrompt !== null &&
      events.events.some(
        (event) =>
          event.cursor > optimisticPrompt.afterCursor &&
          event.message?.role === "user" &&
          event.message.text === optimisticPrompt.text,
      )
    ) {
      setOptimisticPrompt(null);
    }
  }, [events.events, optimisticPrompt]);
  if (!session) return <AppShell sessions={fleet}><main className="grid min-h-[calc(100dvh-52px)] place-items-center px-4 text-sm text-white/42 lg:min-h-dvh">Session not found.</main></AppShell>;
  const relatedSessions = fleet.filter((item) => item.identity.workflowId === session.identity.workflowId && item.sessionId !== session.sessionId).slice(0, 6);
  const permissionCapability = session.capabilities.find((item) => item.action === "respond_permission");

  return (
    <AppShell sessions={fleet} activeSessionId={session.sessionId}>
      <main className="min-h-[calc(100dvh-52px)] bg-[#111113] lg:min-h-dvh xl:grid xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="relative min-w-0 xl:flex xl:h-dvh xl:min-h-0 xl:flex-col">
          <CockpitHeader session={session} />
          <div className="no-scrollbar flex gap-1 overflow-x-auto border-b border-white/[0.06] bg-[#131315] px-3 py-2 sm:px-5" aria-label="Session actions">
            {session.capabilities.map((capability) => ["prompt", "respond_permission"].includes(capability.action) ? null : <ActionButton key={capability.action} capability={capability} session={session} />)}
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
                {optimisticPrompt ? <PendingPrompt text={optimisticPrompt.text} /> : null}
                {events.events.length === 0 && !optimisticPrompt ? <div className="py-16 text-center text-sm text-white/28">No events after this cursor.</div> : null}
              </div>
            </div>
            <SessionComposer
              session={session}
              onSubmitted={(text) => setOptimisticPrompt({
                text,
                afterCursor: session.eventCursor,
              })}
            />
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
  if (event.message) return <MessageRow event={event} message={event.message} />;
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

function MessageRow({ event, message }: Readonly<{ event: SessionEvent; message: NonNullable<SessionEvent["message"]> }>) {
  if (message.role === "user") {
    return (
      <article className="ml-auto max-w-[88%] py-2 sm:max-w-[78%]">
        <div className="rounded-2xl rounded-br-md border border-[#7774ff]/18 bg-[#7774ff]/10 px-4 py-3 text-sm leading-6 text-white/80 shadow-[0_10px_30px_rgba(0,0,0,.12)]">
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        </div>
        <div className="mt-1.5 flex justify-end gap-2 px-1 font-mono text-[9px] text-white/20"><span>You</span><span>#{event.cursor}</span><time>{event.occurredAt.slice(11, 19)}</time></div>
      </article>
    );
  }
  return (
    <article className="max-w-[94%] py-3 sm:max-w-[88%]">
      <div className="mb-2 flex items-center gap-2"><span className="grid size-6 place-items-center rounded-lg bg-[#6d6af7] text-[9px] text-white">⌁</span><span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/30">Agent</span><span className="font-mono text-[9px] text-white/18">#{event.cursor}</span></div>
      <div className="pl-8 text-sm leading-6 text-white/68">
        <p className="whitespace-pre-wrap break-words">{message.text || "The agent completed without a textual response."}</p>
        {message.stopReason !== "end_turn" ? <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[#ffae8d]/70">Stopped: {message.stopReason.replaceAll("_", " ")}</p> : null}
      </div>
      <time className="mt-2 block pl-8 font-mono text-[9px] text-white/18">{event.occurredAt.slice(11, 19)}</time>
    </article>
  );
}

function PendingPrompt({ text }: Readonly<{ text: string }>) {
  return <article className="ml-auto max-w-[88%] py-2 opacity-65 sm:max-w-[78%]"><div className="rounded-2xl rounded-br-md border border-[#7774ff]/12 bg-[#7774ff]/7 px-4 py-3 text-sm leading-6 text-white/62"><p className="whitespace-pre-wrap break-words">{text}</p></div><div className="mt-1.5 flex items-center justify-end gap-2 px-1 text-[9px] text-white/24"><span className="size-1.5 animate-pulse rounded-full bg-[#8e8bff]" /><span>Waiting for agent</span></div></article>;
}

function PermissionCard({ session, capability }: Readonly<{ session: SessionSnapshot; capability: SessionCapability }>) {
  const request = session.pendingPermission;
  const router = useRouter();
  const [pendingOption, setPendingOption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!request) return null;
  const disabled = capability.availability === "disabled" || pendingOption !== null;
  const respond = async (optionId: string | null) => {
    if (disabled || !session.lease) return;
    setError(null);
    setPendingOption(optionId ?? "deny");
    try {
      await executeSessionCommand({ data: {
        version: "codeops.session-command/v1",
        sessionId: session.sessionId,
        generation: session.generation,
        leaseId: session.lease.leaseId,
        idempotencyKey: crypto.randomUUID(),
        type: "respond_permission",
        permissionRequestId: request.requestId,
        decision: optionId === null ? { outcome: "denied" } : { outcome: "selected", optionId },
      } });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Permission response failed.");
    } finally {
      setPendingOption(null);
    }
  };
  return (
    <section className="mb-7 rounded-xl border border-[#ff9b73]/18 bg-[#ff9b73]/[0.055] p-4 shadow-[0_12px_40px_rgba(0,0,0,.16)]">
      <div className="flex items-start gap-3"><span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-[#ff9b73]/10 text-[#ffae8d]">!</span><div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-[#ffae8d]/70">Input required</p><h2 className="mt-1 text-sm font-semibold text-white/86">{request.title}</h2><p className="mt-1.5 text-xs leading-5 text-white/42">{request.description}</p><div className="mt-3 flex flex-wrap gap-2">{request.options.map((option) => <button key={option.optionId} type="button" disabled={disabled} onClick={() => void respond(option.optionId)} className="h-10 rounded-lg border border-[#ff9b73]/20 bg-[#ff9b73]/10 px-3 text-[11px] font-medium text-[#ffc0a7] transition hover:bg-[#ff9b73]/16 disabled:cursor-not-allowed disabled:opacity-40 sm:h-8">{pendingOption === option.optionId ? "Working…" : option.label}</button>)}<button type="button" disabled={disabled} onClick={() => void respond(null)} className="h-10 rounded-lg border border-white/[0.07] px-3 text-[11px] font-medium text-white/42 transition hover:bg-white/[0.05] hover:text-white/70 disabled:cursor-not-allowed disabled:opacity-40 sm:h-8">{pendingOption === "deny" ? "Working…" : "Deny"}</button></div>{error ? <p role="alert" className="mt-3 text-[11px] leading-4 text-[#ff989d]">{error}</p> : null}</div></div>
    </section>
  );
}

function SessionComposer({ session, onSubmitted }: Readonly<{ session: SessionSnapshot; onSubmitted: (prompt: string) => void }>) {
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
      const submittedPrompt = prompt.trim();
      await executeSessionCommand({ data: { version: "codeops.session-command/v1", sessionId: session.sessionId, generation: session.generation, leaseId: session.lease.leaseId, idempotencyKey: crypto.randomUUID(), type: "prompt", prompt: submittedPrompt } });
      onSubmitted(submittedPrompt);
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
        <div className="flex items-center justify-between gap-3 px-1 pb-1"><div className="flex min-w-0 items-center gap-2 text-[10px] text-white/24"><span className="hidden sm:inline">Enter to send · Shift Enter for a new line</span>{error ? <span role="alert" className="truncate text-[#ff989d]">{error}</span> : null}</div><button type="button" disabled={disabled} onClick={() => void send()} aria-label="Prompt" className="grid size-10 shrink-0 place-items-center rounded-full bg-[#6d6af7] text-white transition hover:bg-[#7c79ff] disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-white/18 sm:size-8">{pending ? <span className="size-3 animate-pulse rounded-full bg-current" /> : "↑"}</button></div>
      </div>
    </div>
  );
}

const actionLabels: Record<SessionActionType, string> = { prompt: "Prompt", respond_permission: "Approve / deny", cancel: "Cancel", checkpoint: "Checkpoint", hibernate: "Hibernate", resume: "Resume", fork: "Fork", archive: "Archive", delete: "Delete" };

interface SteeringInput {
  readonly reason?: string;
  readonly title?: string;
}

const sheetActions = new Set<SessionActionType>(["cancel", "hibernate", "fork", "archive", "delete"]);

function commandForAction(session: SessionSnapshot, action: SessionActionType, input: SteeringInput = {}): SessionCommand | null {
  if (!session.lease) throw new Error("This session no longer has a durable lease identity.");
  const base = { version: "codeops.session-command/v1" as const, sessionId: session.sessionId, generation: session.generation, leaseId: session.lease.leaseId, idempotencyKey: crypto.randomUUID() };
  if (action === "prompt" || action === "respond_permission") return null;
  if (action === "cancel" || action === "archive" || action === "delete") {
    const reason = input.reason?.trim(); if (!reason) return null;
    return action === "delete" ? { ...base, type: action, reason, destructiveAuthorizationId: crypto.randomUUID() } : { ...base, type: action, reason };
  }
  if (action === "checkpoint") return { ...base, type: action };
  if (action === "hibernate") { const reason = input.reason?.trim(); return { ...base, type: action, ...(reason ? { reason } : {}) }; }
  const checkpoint = session.checkpoint; if (!checkpoint) throw new Error(`${action} requires a committed checkpoint.`);
  if (action === "resume") return { ...base, type: action, checkpointId: checkpoint.checkpointId };
  if (action === "fork") { const title = input.title?.trim(); return title ? { ...base, type: action, checkpointId: checkpoint.checkpointId, parentEventCursor: session.eventCursor, title } : null; }
  return null;
}

function ActionButton({ capability, session }: Readonly<{ capability: SessionCapability; session: SessionSnapshot }>) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState<string | null>(null); const [sheetOpen, setSheetOpen] = useState(false);
  const disabled = capability.availability === "disabled" || pending; const danger = capability.action === "cancel" || capability.action === "delete"; const label = actionLabels[capability.action]; const unavailableReason = capability.availability === "disabled" ? capability.reason : undefined;
  const run = async (input: SteeringInput = {}) => { setError(null); try { const command = commandForAction(session, capability.action, input); if (!command) return; setPending(true); await executeSessionCommand({ data: command }); setSheetOpen(false); await router.invalidate(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Session command failed."); } finally { setPending(false); } };
  const invoke = () => { if (sheetActions.has(capability.action)) setSheetOpen(true); else void run(); };
  const style = disabled ? "cursor-not-allowed border-white/[0.05] text-white/18" : danger ? "border-[#ff747b]/13 text-[#ff989d]/70 hover:bg-[#ff747b]/8 hover:text-[#ff989d]" : "border-white/[0.065] bg-white/[0.025] text-white/48 hover:bg-white/[0.055] hover:text-white/78";
  return <div className="shrink-0"><button type="button" disabled={disabled} onClick={invoke} title={unavailableReason ?? error ?? undefined} aria-label={disabled ? `${label} unavailable: ${unavailableReason ?? "Command in progress."}` : label} className={`h-10 whitespace-nowrap rounded-lg border px-3 text-[11px] font-medium transition sm:h-8 sm:px-2.5 ${style}`}>{pending ? "Working…" : label}</button>{error && !sheetOpen ? <span role="alert" className="sr-only">{error}</span> : null}{sheetOpen ? <SteeringSheet action={capability.action} pending={pending} error={error} onClose={() => setSheetOpen(false)} onSubmit={run} /> : null}</div>;
}

function SteeringSheet({ action, pending, error, onClose, onSubmit }: Readonly<{ action: SessionActionType; pending: boolean; error: string | null; onClose: () => void; onSubmit: (input: SteeringInput) => Promise<void> }>) {
  const [value, setValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const isFork = action === "fork";
  const isDelete = action === "delete";
  const isOptional = action === "hibernate";
  const valid = (isOptional || value.trim().length > 0) && (!isDelete || confirmed);
  const title = isFork ? "Fork this session" : `${actionLabels[action]} this session`;
  const description = isFork ? "Create a child from the exact committed checkpoint and event cursor." : isDelete ? "Permanently remove the archived session and its checkpoint material." : action === "hibernate" ? "Commit a checkpoint and release the live worker until this session resumes." : `Record why this session should ${action}.`;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !pending) onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, pending]);
  return <div className="fixed inset-0 z-50 grid items-end bg-black/55 p-0 backdrop-blur-[2px] sm:place-items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby={`steering-${action}-title`} className="w-full rounded-t-2xl border border-white/[0.09] bg-[#1a1a1d] p-4 shadow-[0_-20px_70px_rgba(0,0,0,.45)] sm:max-w-md sm:rounded-2xl sm:p-5"><div className="flex items-start gap-4"><div className="min-w-0 flex-1"><h2 id={`steering-${action}-title`} className="text-sm font-semibold text-white/86">{title}</h2><p className="mt-1.5 text-xs leading-5 text-white/38">{description}</p></div><button type="button" disabled={pending} onClick={onClose} aria-label="Close" className="grid size-10 place-items-center rounded-lg text-white/28 transition hover:bg-white/[0.05] hover:text-white/65 sm:size-7">×</button></div><label className="mt-5 block"><span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/28">{isFork ? "Child title" : isOptional ? "Note (optional)" : "Reason"}</span>{isFork ? <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} maxLength={500} placeholder="What should the child session do?" className="h-10 w-full rounded-xl border border-white/[0.08] bg-black/15 px-3 text-sm text-white/80 outline-none placeholder:text-white/22 focus:border-[#7774ff]/45 focus:ring-2 focus:ring-[#7774ff]/10" /> : <textarea autoFocus rows={3} value={value} onChange={(event) => setValue(event.target.value)} maxLength={2000} placeholder={isOptional ? "Why pause here?" : `Why ${action} this session?`} className="w-full resize-none rounded-xl border border-white/[0.08] bg-black/15 px-3 py-2.5 text-sm leading-5 text-white/80 outline-none placeholder:text-white/22 focus:border-[#7774ff]/45 focus:ring-2 focus:ring-[#7774ff]/10" />}</label>{isDelete ? <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-xs leading-5 text-white/45"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 accent-[#ff747b]" /><span>I understand that this permanently deletes the archived session and checkpoint material.</span></label> : null}{error ? <p role="alert" className="mt-3 text-[11px] leading-4 text-[#ff989d]">{error}</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={pending} onClick={onClose} className="h-11 rounded-lg px-4 text-xs font-medium text-white/40 transition hover:bg-white/[0.04] hover:text-white/68 sm:h-9 sm:px-3">Keep session</button><button type="button" disabled={!valid || pending} onClick={() => void onSubmit(isFork ? { title: value } : { reason: value })} className={`h-11 rounded-lg px-4 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 sm:h-9 sm:px-3 ${isDelete || action === "cancel" ? "bg-[#ff747b]/14 text-[#ff9ca1] hover:bg-[#ff747b]/20" : "bg-[#6d6af7] text-white hover:bg-[#7c79ff]"}`}>{pending ? "Working…" : actionLabels[action]}</button></div></section></div>;
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
