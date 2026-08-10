import type { SessionState } from "@renoconcierge/codeops-contracts/session-broker";

const styles: Record<SessionState, string> = {
  queued: "border-[#6da8ff]/18 bg-[#6da8ff]/8 text-[#8dbbff]",
  running: "border-[#54d18b]/18 bg-[#54d18b]/8 text-[#6ee2a0]",
  waiting_permission: "border-[#ff9b73]/22 bg-[#ff9b73]/8 text-[#ffae8d]",
  checkpointing: "border-[#6da8ff]/18 bg-[#6da8ff]/8 text-[#8dbbff]",
  hibernated: "border-white/[0.07] bg-white/[0.025] text-white/38",
  completed: "border-white/[0.07] bg-white/[0.035] text-white/55",
  failed: "border-[#ff747b]/22 bg-[#ff747b]/8 text-[#ff989d]",
  cancelled: "border-white/[0.07] bg-white/[0.035] text-white/48",
  archived: "border-white/[0.07] bg-white/[0.02] text-white/34",
};

export function StatusBadge({ state }: Readonly<{ state: SessionState }>) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.11em] ${styles[state]}`}>
      <span className={`size-1 rounded-full ${state === "running" ? "animate-pulse bg-current" : "bg-current"}`} />
      {state.replaceAll("_", " ")}
    </span>
  );
}
