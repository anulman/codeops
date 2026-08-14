import { useMemo, useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import {
  createWorkspaceLaunch,
  getWorkspaceCatalog,
} from "@/lib/workspaceLaunch.data";
import {
  MAX_CONTEXT_ATTACHMENTS,
  MAX_CONTEXT_ATTACHMENTS_TOTAL_BYTES,
  contextAttachmentSummary,
  workspaceContextAttachmentFromFile,
} from "@/lib/contextAttachments";
import { workspaceLaunchSessionId } from "@codeops/codeops-contracts/workspace-launch";
import type { WorkspaceContextAttachment } from "@codeops/codeops-contracts/workspace-launch";
import type { InteractiveSessionMode } from "@codeops/codeops-contracts/session-policy";

const sessionModes: readonly {
  readonly id: InteractiveSessionMode;
  readonly label: string;
  readonly summary: string;
  readonly policy: string;
}[] = [
  { id: "explore", label: "Explore", summary: "Investigate and explain without changing files.", policy: "Read-only · Sol · medium reasoning" },
  { id: "plan", label: "Plan", summary: "Produce a durable plan without changing files.", policy: "Read-only · Sol · high reasoning" },
  { id: "implement", label: "Implement", summary: "Make bounded changes inside the admitted workspace.", policy: "Bounded writes · Sol · medium reasoning" },
  { id: "review", label: "Review", summary: "Critique the exact workspace without changing it.", policy: "Read-only · Sol · high reasoning" },
];

export const Route = createFileRoute("/new")({
  loader: () => getWorkspaceCatalog(),
  component: NewSessionPage,
});

function NewSessionPage() {
  const catalog = Route.useLoaderData();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<InteractiveSessionMode>("implement");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [contextAttachments, setContextAttachments] = useState<readonly WorkspaceContextAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const valid = prompt.trim().length > 0 && prompt.length <= 100_000 &&
    title.length <= 200 && selected.length <= 4;
  const selectedRepositories = useMemo(
    () => catalog.repositories.filter((repository) => selected.includes(repository.key)),
    [catalog.repositories, selected],
  );

  const toggleRepository = (key: string) => {
    if (submitting) return;
    setSelected((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : current.length < 4
          ? [...current, key]
          : current,
    );
  };

  const addContextAttachments = async (files: FileList | null) => {
    if (!files || submitting) return;
    setError(null);
    try {
      const incoming = Array.from(files);
      if (contextAttachments.length + incoming.length > MAX_CONTEXT_ATTACHMENTS) {
        throw new Error("You can attach up to four context files.");
      }
      const duplicate = incoming.find((file, index) =>
        contextAttachments.some((attachment) => attachment.name === file.name) ||
        incoming.findIndex((candidate) => candidate.name === file.name) !== index,
      );
      if (duplicate) throw new Error(`An attachment named ${duplicate.name} is already selected.`);
      const additions = await Promise.all(incoming.map(workspaceContextAttachmentFromFile));
      const totalBytes = [...contextAttachments, ...additions].reduce((total, item) => total + item.sizeBytes, 0);
      if (totalBytes > MAX_CONTEXT_ATTACHMENTS_TOTAL_BYTES) {
        throw new Error("Context attachments exceed the 512 KiB combined limit.");
      }
      setContextAttachments((current) => [...current, ...additions]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const launch = await createWorkspaceLaunch({
        data: {
          version: "codeops.workspace-launch-request/v1",
          idempotencyKey: crypto.randomUUID(),
          mode,
          prompt: prompt.trim(),
          ...(contextAttachments.length > 0 ? { contextAttachments } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
          sources: selected.map((catalogKey) => ({ catalogKey })),
        },
      });
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: workspaceLaunchSessionId(launch.launchId) },
        replace: true,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const locked = submitting;
  return (
    <AppShell>
      <main className="min-h-[calc(100dvh-52px)] bg-[#111113] px-4 py-8 lg:min-h-dvh lg:px-8 lg:py-12">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/28">Workspace launch</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] text-white/92">New session</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-white/40">Give the agent a prompt and choose the source repositories it can work with.</p>
            </div>
            <Link to="/" className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/[0.07] text-lg text-white/35 transition hover:bg-white/[0.04] hover:text-white/70" aria-label="Close new session">×</Link>
          </div>

          <section className="mt-8 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#171719] shadow-[0_24px_80px_rgba(0,0,0,.22)]">
            <div className="p-5 sm:p-7">
              <label className="block">
                <span className="text-xs font-semibold text-white/72">What should the agent do?</span>
                <textarea autoFocus required disabled={locked} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={100_000} rows={7} placeholder="Build, investigate, write, or analyze…" className="mt-3 w-full resize-y rounded-xl border border-white/[0.08] bg-black/15 px-4 py-3 text-sm leading-6 text-white/82 outline-none placeholder:text-white/22 focus:border-[#7774ff]/50 focus:ring-2 focus:ring-[#7774ff]/10 disabled:opacity-55" />
              </label>

              <label className="mt-6 block">
                <span className="text-xs font-semibold text-white/72">Title <span className="font-normal text-white/28">Optional</span></span>
                <input disabled={locked} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} placeholder="A short label for this session" className="mt-3 h-11 w-full rounded-xl border border-white/[0.08] bg-black/15 px-4 text-sm text-white/82 outline-none placeholder:text-white/22 focus:border-[#7774ff]/50 focus:ring-2 focus:ring-[#7774ff]/10 disabled:opacity-55" />
              </label>

              <fieldset className="mt-7" disabled={locked}>
                <legend className="text-xs font-semibold text-white/72">Session mode</legend>
                <p className="mt-1.5 text-[11px] leading-5 text-white/32">CodeOps binds this policy to the launch, runtime, and model authority. The session cannot expand it.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {sessionModes.map((option) => {
                    const checked = mode === option.id;
                    return <label key={option.id} className={`cursor-pointer rounded-xl border p-3.5 transition ${checked ? "border-[#7774ff]/45 bg-[#7774ff]/10" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.13]"}`}>
                      <span className="flex items-center gap-2"><input type="radio" name="session-mode" value={option.id} checked={checked} onChange={() => setMode(option.id)} className="sr-only" /><span className={`size-2 rounded-full ${checked ? "bg-[#8c89ff]" : "bg-white/15"}`} /><span className="text-sm font-medium text-white/76">{option.label}</span></span>
                      <span className="mt-2 block text-[11px] leading-4 text-white/38">{option.summary}</span>
                      <span className="mt-2 block font-mono text-[9px] text-white/24">{option.policy}</span>
                    </label>;
                  })}
                </div>
                <p className="mt-2 text-[10px] text-white/24">Validate is deterministic and uses no model. Interactive launch stays disabled until CodeOps provides a deterministic validation action.</p>
              </fieldset>

              <fieldset className="mt-7" disabled={locked}>
                <legend className="text-xs font-semibold text-white/72">Repositories <span className="font-normal text-white/28">Optional · up to four</span></legend>
                <p className="mt-1.5 text-[11px] leading-5 text-white/32">Each repository is resolved to its exact default-branch commit before the session starts.</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {catalog.repositories.map((repository) => {
                    const checked = selected.includes(repository.key);
                    return (
                      <label key={repository.key} className={`relative flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition ${checked ? "border-[#7774ff]/45 bg-[#7774ff]/10" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.13] hover:bg-white/[0.035]"}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleRepository(repository.key)} className="peer sr-only" />
                        <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] ${checked ? "border-[#8c89ff] bg-[#6d6af7] text-white" : "border-white/20 text-transparent"}`}>✓</span>
                        <span className="min-w-0"><span className="block truncate text-sm font-medium text-white/76">{repository.label}</span><span className="mt-1 block truncate font-mono text-[10px] text-white/28">{repository.repository} · {repository.defaultRef}</span></span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <fieldset className="mt-7" disabled={locked}>
                <legend className="text-xs font-semibold text-white/72">Context files <span className="font-normal text-white/28">Optional · up to four</span></legend>
                <p className="mt-1.5 text-[11px] leading-5 text-white/32">Each file is bound to its SHA-256 digest. The runtime verifies the exact bytes again before it sends them to the agent.</p>
                <label className="mt-3 flex min-h-11 cursor-pointer items-center justify-center rounded-xl border border-dashed border-white/[0.11] bg-white/[0.02] px-4 text-xs font-medium text-white/42 transition hover:border-[#7774ff]/35 hover:bg-[#7774ff]/[0.05] hover:text-white/68">
                  <input type="file" multiple className="sr-only" onChange={(event) => { void addContextAttachments(event.target.files); event.target.value = ""; }} />
                  Add files · 256 KiB each · 512 KiB total
                </label>
                {contextAttachments.length > 0 ? <div className="mt-3 space-y-2">{contextAttachments.map((attachment) => <div key={attachment.attachmentId} className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5"><span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#6da8ff]/8 text-[11px] text-[#8dbbff]">↗</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-white/66">{attachment.name}</span><span className="mt-0.5 block truncate font-mono text-[9px] text-white/25">{contextAttachmentSummary(attachment)}</span></span><button type="button" disabled={locked} onClick={() => setContextAttachments((current) => current.filter((item) => item.attachmentId !== attachment.attachmentId))} aria-label={`Remove ${attachment.name}`} className="grid size-8 shrink-0 place-items-center rounded-lg text-white/25 transition hover:bg-white/[0.05] hover:text-white/65">×</button></div>)}</div> : null}
              </fieldset>

              <div className={`mt-5 flex items-start gap-3 rounded-xl border px-4 py-3 ${selectedRepositories.length === 0 ? "border-[#6da8ff]/16 bg-[#6da8ff]/7" : "border-white/[0.06] bg-white/[0.02]"}`}>
                <span className="mt-0.5 text-sm text-[#8dbbff]">{selectedRepositories.length === 0 ? "✦" : "↳"}</span>
                <div><p className="text-xs font-medium text-white/62">{selectedRepositories.length === 0 ? "Scratch workspace" : `${selectedRepositories.length} source ${selectedRepositories.length === 1 ? "repository" : "repositories"}`}</p><p className="mt-1 text-[11px] leading-4 text-white/30">{mode === "implement" ? selectedRepositories.length === 0 ? "The agent starts with an empty bounded writable workspace. Files remain session artifacts until you choose to publish them." : "The agent receives fixed checkouts plus a bounded writable scratch area. Publication always requires a later explicit action." : "The complete workspace is mounted read-only for this mode. The agent can inspect it but cannot change source or scratch files."}</p></div>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-white/[0.07] bg-black/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
              <div aria-live="polite" className="min-h-5 text-[11px] text-white/34">
                {error ? <span role="alert" className="text-[#ff989d]">{error}</span> : submitting ? <span className="flex items-center gap-2"><span className="size-1.5 animate-pulse rounded-full bg-[#6da8ff]" />Creating the session…</span> : "The initial prompt is delivered exactly once after the session is ready."}
              </div>
              <div className="flex shrink-0 gap-2">
                <Link to="/" className="grid h-11 place-items-center rounded-lg px-4 text-xs font-medium text-white/40 transition hover:bg-white/[0.04] hover:text-white/68">Cancel</Link>
                <button type="button" disabled={!valid || locked} onClick={() => void submit()} className="h-11 rounded-lg bg-[#6d6af7] px-5 text-xs font-semibold text-white shadow-[0_8px_24px_rgba(73,69,225,.2)] transition hover:bg-[#7c79ff] disabled:cursor-not-allowed disabled:opacity-35">{submitting ? "Creating…" : "Create session"}</button>
              </div>
            </div>
          </section>
        </div>
      </main>
    </AppShell>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Workspace launch failed.";
}
