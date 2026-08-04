import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="min-h-screen bg-[#090b0e] text-[#f4f2ed]">
      <header className="sticky top-0 z-30 border-b border-white/8 bg-[#090b0e]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" className="group flex items-center gap-3" aria-label="Agent Sessions home">
            <span className="grid size-8 place-items-center rounded-lg border border-[#c8ff5a]/30 bg-[#c8ff5a]/10 text-[#c8ff5a] shadow-[inset_0_0_18px_rgba(200,255,90,0.08)]">
              <PulseMark />
            </span>
            <span>
              <span className="block text-[13px] font-semibold leading-none tracking-[-0.01em]">Agent Sessions</span>
              <span className="mt-1 block text-[10px] font-medium uppercase tracking-[0.18em] text-white/38">RenoConcierge CodeOps</span>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-white/8 bg-white/[0.025] px-3 py-1.5 text-[11px] text-white/48 sm:flex">
              <span className="size-1.5 rounded-full bg-[#c8ff5a] shadow-[0_0_10px_rgba(200,255,90,0.9)]" />
              Broker connected
            </div>
            <div className="grid size-8 place-items-center rounded-full bg-[#e3b6ff] text-xs font-bold text-[#22142a]">AA</div>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function PulseMark() {
  return (
    <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
      <path d="M2 10h3l2-5 3.2 10L13 8l1.4 2H18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
