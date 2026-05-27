"use client";

import { useState, useRef } from "react";

type ResultItem = {
  id: number;
  url: string;
  altText: string;
  status: "ok" | "skipped" | "error";
  error?: string;
};

type RunStats = {
  updated:     number;
  skipped:     number;
  unsupported: number;
  errors:      number;
  pages:       number;
};

type Stage = "idle" | "running" | "done" | "error";

export default function AltTextBackfillPage() {
  const [stage, setStage]         = useState<Stage>("idle");
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages]   = useState(0);
  const [totalMedia, setTotalMedia]   = useState(0);
  const [stats, setStats]         = useState<RunStats>({ updated: 0, skipped: 0, unsupported: 0, errors: 0, pages: 0 });
  const [log, setLog]             = useState<ResultItem[]>([]);
  const [error, setError]         = useState("");
  const abortRef                  = useRef(false);
  const logEndRef                 = useRef<HTMLDivElement>(null);

  const addLog = (items: ResultItem[]) => {
    setLog(prev => [...items, ...prev]); // newest at top
  };

  const handleStart = async () => {
    abortRef.current = false;
    setStage("running");
    setLog([]);
    setError("");
    setStats({ updated: 0, skipped: 0, unsupported: 0, errors: 0, pages: 0 });
    setCurrentPage(0);
    setTotalPages(0);

    let page = 1;
    let cumUpdated     = 0;
    let cumSkipped     = 0;
    let cumUnsupported = 0;
    let cumErrors      = 0;
    let pagesRun       = 0;

    while (true) {
      if (abortRef.current) break;

      let data: {
        results:     ResultItem[];
        nextPage:    number | null;
        totalPages:  number;
        totalMedia:  number;
        currentPage: number;
        error?:      string;
      };

      try {
        const res = await fetch("/api/media-alt-backfill", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ page }),
        });
        data = await res.json();
        if (!res.ok || data.error) {
          setError(data.error ?? `Request failed (${res.status})`);
          setStage("error");
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
        setStage("error");
        return;
      }

      setTotalPages(data.totalPages);
      setTotalMedia(data.totalMedia);
      setCurrentPage(data.currentPage);
      pagesRun++;

      const updated     = data.results.filter(r => r.status === "ok").length;
      const skipped     = data.results.filter(r => r.status === "skipped").length;
      const unsupported = data.results.filter(r => r.status === "unsupported").length;
      const errors      = data.results.filter(r => r.status === "error").length;

      cumUpdated     += updated;
      cumSkipped     += skipped;
      cumErrors      += errors;

      setStats({ updated: cumUpdated, skipped: cumSkipped, unsupported: cumUnsupported += unsupported, errors: cumErrors, pages: pagesRun });
      addLog(data.results.filter(r => r.status !== "skipped" && r.status !== "unsupported"));

      if (!data.nextPage) break;
      page = data.nextPage;
    }

    setStage(abortRef.current ? "idle" : "done");
  };

  const handleStop = () => {
    abortRef.current = true;
    setStage("done");
  };

  const progress = totalPages > 0 ? Math.round((currentPage / totalPages) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Alt Text Backfill</h1>
            <p className="text-sm text-white/35 mt-0.5">
              Adds SEO-optimised alt text to all WordPress media missing it
            </p>
          </div>
          <a href="/" className="text-xs text-white/30 hover:text-white/60 transition-colors">
            ← Back to tool
          </a>
        </div>

        {/* Info card */}
        {stage === "idle" && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-3">
            <p className="text-xs text-white/50 font-medium uppercase tracking-widest">What this does</p>
            <ul className="space-y-2">
              {[
                "Scans your WordPress media library page by page",
                "Finds every image with no alt text set",
                "GPT-4o reads each image and writes an 8–12 word SEO alt text",
                "Alt text is keyword-rich and related to Aston VIP's services",
                "Updates each image directly in WordPress",
                "Safe to stop and restart — already-updated images are not touched again",
              ].map((item, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="text-emerald-400/70 text-xs mt-0.5">✓</span>
                  <p className="text-sm text-white/50">{item}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Progress */}
        {(stage === "running" || stage === "done") && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-4">

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: "Updated",     value: stats.updated,     colour: "text-emerald-400" },
                { label: "Skipped",     value: stats.skipped,     colour: "text-white/30"    },
                { label: "Unsupported", value: stats.unsupported, colour: "text-amber-400"   },
                { label: "Errors",      value: stats.errors,      colour: "text-red-400"     },
              ].map(s => (
                <div key={s.label} className="rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-3 text-center">
                  <p className={`text-xl font-semibold tabular-nums ${s.colour}`}>{s.value}</p>
                  <p className="text-[10px] text-white/30 mt-0.5 uppercase tracking-widest">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Progress bar */}
            {totalPages > 0 && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-[10px] text-white/30">
                  <span>Page {currentPage} of {totalPages}</span>
                  <span>{totalMedia > 0 ? `${totalMedia} total media` : ""}</span>
                </div>
                <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#C9A84C] rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${stage === "done" ? 100 : progress}%` }}
                  />
                </div>
                <p className="text-[10px] text-white/20 text-right">{stage === "done" ? "Complete" : `${progress}%`}</p>
              </div>
            )}

            {stage === "done" && (
              <p className="text-sm text-emerald-400 font-medium">
                ✅ Done — {stats.updated} images updated
                {stats.errors > 0 && `, ${stats.errors} failed`}
              </p>
            )}
          </div>
        )}

        {/* Error */}
        {stage === "error" && error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3">
          {(stage === "idle" || stage === "done" || stage === "error") && (
            <button
              onClick={handleStart}
              className="flex-1 flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] text-black font-semibold text-sm py-3 rounded-xl transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
              </svg>
              {stage === "done" || stage === "error" ? "Run again" : "Start backfill"}
            </button>
          )}
          {stage === "running" && (
            <button
              onClick={handleStop}
              className="flex-1 flex items-center justify-center gap-2 bg-white/[0.06] hover:bg-white/[0.10] text-white/70 font-semibold text-sm py-3 rounded-xl transition-colors border border-white/10"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
              </svg>
              Stop
            </button>
          )}
        </div>

        {/* Live log — updated images only */}
        {log.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-white/30 uppercase tracking-widest">Updated images</p>
            <div className="rounded-xl border border-white/[0.07] overflow-hidden divide-y divide-white/[0.04]">
              {log.slice(0, 100).map((item) => (
                <div key={item.id} className="flex items-start gap-3 px-4 py-3">
                  <span className={`text-xs mt-0.5 shrink-0 ${item.status === "ok" ? "text-emerald-400" : "text-red-400"}`}>
                    {item.status === "ok" ? "✓" : "✗"}
                  </span>
                  <div className="min-w-0 flex-1">
                    {item.status === "ok" ? (
                      <p className="text-xs text-white/60 leading-relaxed">{item.altText}</p>
                    ) : (
                      <p className="text-xs text-red-400/70 leading-relaxed">{item.error}</p>
                    )}
                    <p className="text-[10px] text-white/20 mt-0.5 truncate">{item.url}</p>
                  </div>
                  <span className="text-[10px] text-white/20 shrink-0">ID {item.id}</span>
                </div>
              ))}
              {log.length > 100 && (
                <div className="px-4 py-2 text-[10px] text-white/25 text-center">
                  Showing latest 100 — {log.length} total
                </div>
              )}
            </div>
            <div ref={logEndRef} />
          </div>
        )}

      </div>
    </div>
  );
}
