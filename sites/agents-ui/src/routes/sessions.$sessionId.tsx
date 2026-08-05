import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { executeSessionCommand, getSessionDetail, getSessionEvents, getSessionFleet } from "@/lib/sessionBroker.data";
import type {
  SessionCommand,
  SessionActionType,
  SessionCapability,
  SessionEvent,
  SessionSnapshot,
} from "@renoconcierge/codeops-contracts/session-broker";

export const Route = createFileRoute("/sessions/$sessionId")({
  loader: async ({ params }) => {
    const [session, fleet] = await Promise.all([
      getSessionDetail({ data: { sessionId: params.sessionId } }),
      getSessionFleet(),
    ]);
    const events = await getSessionEvents({
      data: {
        sessionId: params.sessionId,
        afterCursor: Math.max(0, (session?.eventCursor ?? 0) - 500),
        limit: 500,
      },
    });
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
      void router.invalidate().finally(() => {
        invalidating = false;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [router, session?.sessionId, session?.state]);
  if (!session) {
    return <AppShell><main className="mx-auto max-w-3xl px-4 py-24 text-center text-white/55">Session not found.</main></AppShell>;
  }
  const relatedSessions = fleet
    .filter((item) =>
      item.identity.workflowId === session.identity.workflowId &&
      item.sessionId !== session.sessionId,
    )
    .slice(0, 6);

  return (
    <AppShell>
      <main className="mx-auto max-w-[1700px] px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-col gap-5 border-b border-white/8 pb-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <Link to="/" className="mb-4 inline-flex items-center gap-2 text-xs text-white/35 transition hover:text-white/70"><span>←</span> All sessions</Link>
            <div className="flex flex-wrap items-center gap-3"><StatusBadge state={session.state} /><span className="font-mono text-[11px] text-white/28">{session.sessionId}</span></div>
            <h1 className="mt-3 text-2xl font-medium tracking-[-0.035em] text-white sm:text-3xl">{session.identity.runId}</h1>
            <p className="mt-2 text-sm text-white/42">{session.identity.workflowId} · <span className="font-mono">{session.identity.baseSha.slice(0, 7)}</span></p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 xl:w-auto xl:grid-cols-5" aria-label="Session actions">
            {session.capabilities.map((capability) => (
              <ActionButton key={capability.action} capability={capability} session={session} />
            ))}
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-w-0 rounded-xl border border-white/8 bg-[#0c0f13]">
            <div className="sticky top-16 z-20 flex flex-col gap-3 border-b border-white/8 bg-[#0c0f13]/95 px-4 py-4 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">Now</div><div className="mt-1 flex items-center gap-2 text-sm capitalize text-white/80"><span className="size-1.5 animate-pulse rounded-full bg-[#c8ff5a]" />{session.state.replaceAll("_", " ")}</div></div>
              <div className="font-mono text-[11px] text-white/30">event cursor · {String(session.eventCursor).padStart(6, "0")}</div>
            </div>
            <div className="px-4 py-3 sm:px-6">
              {events.events.map((event, index) => (
                <article key={event.eventId} className="grid grid-cols-[54px_16px_minmax(0,1fr)] gap-3 py-5">
                  <time className="pt-0.5 font-mono text-[10px] text-white/25">{event.occurredAt.slice(11, 19)}</time>
                  <div className="relative flex justify-center"><span className={`relative z-10 mt-1 size-2 rounded-full ${eventDot(event)}`} />{index < events.events.length - 1 ? <span className="absolute bottom-[-21px] top-3 w-px bg-white/8" /> : null}</div>
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium capitalize text-white/82">{event.type.replaceAll("_", " ")}</h2><span className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] uppercase text-white/30">#{event.cursor}</span></div><p className="mt-2 text-xs leading-5 text-white/42">Generation {event.generation} · durable broker event</p></div>
                </article>
              ))}
              {events.events.length === 0 ? <div className="py-16 text-center text-sm text-white/30">No events after this cursor.</div> : null}
            </div>
          </section>

          <aside className="space-y-4">
            <Panel title="Execution identity"><Fact label="Repository" value={session.identity.repository} /><Fact label="Branch" value={session.identity.branch} /><Fact label="Commit" value={session.identity.baseSha} mono /><Fact label="Worker" value={session.lease?.status === "active" ? session.lease.holderId : "No active worker"} mono /><Fact label="Generation" value={String(session.generation)} /><Fact label="Lease" value={session.lease?.leaseId.slice(0, 8) ?? "Deleted"} mono /></Panel>
            <Panel title="Evidence"><EvidenceRow label="Event cursor" value={String(session.eventCursor)} tone="live" /><EvidenceRow label="Checkpoint" value={session.checkpoint ? "Committed" : "None"} /><EvidenceRow label="References" value={String(session.checkpoint?.evidenceReferences.length ?? 0)} /><EvidenceRow label="Patch" value={session.checkpoint?.patchDigest ?? "Not checkpointed"} mono /></Panel>
            <Panel title="Ensemble">{relatedSessions.map((item) => <RelatedSession key={item.sessionId} session={item} />)}{relatedSessions.length === 0 ? <div className="text-xs text-white/30">No related sessions.</div> : null}</Panel>
            <Panel title="Session boundary"><Fact label="Parent" value={session.identity.parentSessionId ?? "Root session"} mono /><Fact label="Fork cursor" value={session.identity.forkedAtCursor === null ? "—" : String(session.identity.forkedAtCursor)} /><Fact label="Permission" value={session.pendingPermission?.title ?? "None pending"} /></Panel>
            <details className="rounded-xl border border-white/8 bg-[#0c0f13] px-4 py-3"><summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-[0.14em] text-white/38">Protocol diagnostics <span className="float-right text-white/22">＋</span></summary><pre className="mt-4 overflow-x-auto border-t border-white/6 pt-4 font-mono text-[10px] leading-5 text-white/32">session/update{`\n`}broker: {session.sessionId}{`\n`}workflow: {session.identity.workflowId}{`\n`}sequence: {session.eventCursor}{`\n`}transport: server RPC</pre></details>
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

function commandForAction(
  session: SessionSnapshot,
  action: SessionActionType,
): SessionCommand | null {
  if (!session.lease) throw new Error("This session no longer has a durable lease identity.");
  const base = {
    version: "codeops.session-command/v1" as const,
    sessionId: session.sessionId,
    generation: session.generation,
    leaseId: session.lease.leaseId,
    idempotencyKey: crypto.randomUUID(),
  };
  if (action === "prompt") {
    const prompt = window.prompt("Prompt this live session:")?.trim();
    return prompt ? { ...base, type: action, prompt } : null;
  }
  if (action === "respond_permission") {
    const request = session.pendingPermission;
    if (!request) throw new Error("There is no pending permission request.");
    const choices = request.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
    const answer = window.prompt(`${request.title}\n\n${request.description}\n\n${choices}\n\nEnter an option number, or \"deny\".`)?.trim();
    if (!answer) return null;
    if (answer.toLowerCase() === "deny") {
      return { ...base, type: action, permissionRequestId: request.requestId, decision: { outcome: "denied" } };
    }
    const selected = request.options[Number(answer) - 1];
    if (!selected) throw new Error("Choose one of the listed option numbers, or deny.");
    return { ...base, type: action, permissionRequestId: request.requestId, decision: { outcome: "selected", optionId: selected.optionId } };
  }
  if (action === "cancel" || action === "archive" || action === "delete") {
    if (action === "delete" && !window.confirm("Permanently delete this archived session and its checkpoint material?")) return null;
    const reason = window.prompt(`Reason to ${action} this session:`)?.trim();
    if (!reason) return null;
    if (action === "delete") {
      return { ...base, type: action, reason, destructiveAuthorizationId: crypto.randomUUID() };
    }
    return { ...base, type: action, reason };
  }
  if (action === "checkpoint") return { ...base, type: action };
  if (action === "hibernate") {
    const reason = window.prompt("Optional hibernation note:")?.trim();
    return { ...base, type: action, ...(reason ? { reason } : {}) };
  }
  const checkpoint = session.checkpoint;
  if (!checkpoint) {
    throw new Error(`${action} requires a committed checkpoint.`);
  }
  if (action === "resume") {
    return { ...base, type: action, checkpointId: checkpoint.checkpointId };
  }
  if (action === "fork") {
    const title = window.prompt("Title for the forked session:")?.trim();
    return title
      ? {
          ...base,
          type: action,
          checkpointId: checkpoint.checkpointId,
          parentEventCursor: session.eventCursor,
          title,
        }
      : null;
  }
  return null;
}

function ActionButton({ capability, session }: Readonly<{ capability: SessionCapability; session: SessionSnapshot }>) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = capability.availability === "disabled" || pending;
  const danger = capability.action === "cancel" || capability.action === "delete";
  const active = capability.action === "prompt" && !disabled;
  const style = disabled ? "cursor-not-allowed border-white/6 text-white/18" : active ? "border-[#c8ff5a]/30 bg-[#c8ff5a] text-[#151a0c] hover:bg-[#d5ff80]" : danger ? "border-[#ff9f6e]/20 text-[#ffb18b] hover:bg-[#ff9f6e]/8" : "border-white/10 text-white/55 hover:bg-white/5 hover:text-white/80";
  const label = actionLabels[capability.action];
  const unavailableReason = capability.availability === "disabled" ? capability.reason : undefined;
  const run = async () => {
    setError(null);
    try {
      const command = commandForAction(session, capability.action);
      if (!command) return;
      setPending(true);
      await executeSessionCommand({ data: command });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session command failed.");
    } finally {
      setPending(false);
    }
  };
  return <div className="min-w-0"><button type="button" disabled={disabled} onClick={() => void run()} title={unavailableReason ?? error ?? undefined} aria-label={disabled ? `${label} unavailable: ${unavailableReason ?? "Command in progress."}` : label} className={`min-h-10 w-full rounded-lg border px-3 py-2 text-xs font-semibold transition ${style}`}>{pending ? "Working…" : label}</button>{error ? <p role="alert" className="mt-1 text-[10px] leading-4 text-[#ffb18b]">{error}</p> : null}</div>;
}

function Panel({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) { return <section className="rounded-xl border border-white/8 bg-[#0c0f13] p-4"><h2 className="mb-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">{title}</h2><div className="space-y-3">{children}</div></section>; }
function Fact({ label, value, mono = false }: Readonly<{ label: string; value: string; mono?: boolean }>) { return <div className="flex items-start justify-between gap-4 text-xs"><span className="text-white/28">{label}</span><span className={`min-w-0 truncate text-right text-white/58 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span></div>; }
function EvidenceRow({ label, value, tone = "quiet", mono = false }: Readonly<{ label: string; value: string; tone?: "live" | "warn" | "quiet"; mono?: boolean }>) { const color = tone === "live" ? "text-[#c8ff5a]" : tone === "warn" ? "text-[#ffb18b]" : "text-white/58"; return <div className="flex items-center justify-between gap-4 text-xs"><span className="text-white/30">{label}</span><span className={`${color} ${mono ? "font-mono text-[10px]" : ""}`}>{value}</span></div>; }
function RelatedSession({ session }: Readonly<{ session: SessionSnapshot }>) { return <Link to="/sessions/$sessionId" params={{ sessionId: session.sessionId }} className="flex items-center justify-between gap-3 text-xs text-white/48 transition hover:text-white/75"><span className="min-w-0 truncate">{session.identity.runId}</span><span className="shrink-0 capitalize text-[10px] text-white/28">{session.state.replaceAll("_", " ")}</span></Link>; }
function eventDot(event: SessionEvent) { if (event.type === "permission_requested") return "bg-[#ff9f6e] shadow-[0_0_8px_rgba(255,159,110,.55)]"; if (event.type === "acp_update") return "bg-[#8cb8ff]"; if (event.type === "state_changed") return "bg-[#c8ff5a]"; return "bg-white/25"; }
