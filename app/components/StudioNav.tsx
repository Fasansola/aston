"use client";

/**
 * Shared top chrome for every studio route — wordmark, route navigation and
 * the gold hairline. Gives the tool a single product identity instead of
 * five disconnected pages.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Generate" },
  { href: "/admin", label: "Scheduler" },
  { href: "/media", label: "Add media" },
  { href: "/podcast", label: "Podcast" },
  { href: "/video", label: "Video" },
  { href: "/alt-text", label: "Alt text" },
];

export default function StudioNav() {
  const pathname = usePathname();

  return (
    <div className="relative z-20">
      <div className="fixed top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-gold to-transparent z-30" />
      <header className="max-w-5xl mx-auto px-6 pt-7 pb-5 flex items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-3 group shrink-0">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-b from-[#dcbd72] via-gold to-[#a8873a] flex items-center justify-center shadow-[0_6px_18px_-6px_rgba(201,168,76,0.55)] group-hover:shadow-[0_8px_22px_-6px_rgba(201,168,76,0.7)] transition-shadow">
            <span className="font-display text-black font-semibold text-lg leading-none">A</span>
          </div>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold text-white/90 tracking-wide">Aston</p>
            <p className="text-[10px] text-gold/70 tracking-[0.28em] uppercase">Content Studio</p>
          </div>
        </Link>

        <nav className="flex items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] backdrop-blur px-1.5 py-1.5 overflow-x-auto">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all duration-150 ${
                  active
                    ? "bg-gradient-to-b from-[#dcbd72] to-[#b6923a] text-black shadow-[0_4px_14px_-4px_rgba(201,168,76,0.6)]"
                    : "text-white/45 hover:text-white/85 hover:bg-white/[0.06]"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <div className="max-w-5xl mx-auto px-6">
        <div className="gold-rule" />
      </div>
    </div>
  );
}
