import type { SessionState } from "@renoconcierge/codeops-contracts/session-broker";

const styles: Record<SessionState, string> = {
  queued: "border-[#8cb8ff]/20 bg-[#8cb8ff]/8 text-[#a9c8ff]",
  running: "border-[#c8ff5a]/22 bg-[#c8ff5a]/8 text-[#c8ff5a]",
  waiting_permission: "border-[#ff9f6e]/25 bg-[#ff9f6e]/9 text-[#ffb18b]",
  checkpointing: "border-[#8cb8ff]/20 bg-[#8cb8ff]/8 text-[#a9c8ff]",
  hibernated: "border-white/8 bg-transparent text-white/36",
  completed: "border-white/10 bg-white/[0.035] text-white/58",
  failed: "border-[#ff9f6e]/25 bg-[#ff9f6e]/9 text-[#ffb18b]",
  cancelled: "border-white/10 bg-white/[0.035] text-white/58",
  archived: "border-white/8 bg-transparent text-white/36",
  deleted: "border-white/8 bg-transparent text-white/24",
};

export function StatusBadge({ state }: Readonly<{ state: SessionState }>) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${styles[state]}`}>
      <span className={`size-1 rounded-full ${state === "running" ? "animate-pulse bg-current" : "bg-current"}`} />
      {state.replaceAll("_", " ")}
    </span>
  );
}
