"use client";

import { useState, useRef } from "react";

const SAMPLE_TOPICS = [
  { label: "UAE Free Zone",      title: "How to Set Up a Business in a UAE Free Zone",                keyword: "UAE free zone business setup" },
  { label: "Corporate banking",  title: "Why Most Businesses Fail at Corporate Banking and How to Fix It", keyword: "international corporate banking" },
  { label: "Holding structures", title: "How International Holding Structures Work and Why They Matter",   keyword: "international holding company" },
  { label: "UAE vs UK",          title: "UAE vs UK Company Formation: Which Structure Is Right for You",   keyword: "UAE UK company formation" },
  { label: "Offshore vehicles",  title: "Seychelles and BVI Companies: What They Are Actually Used For",  keyword: "offshore company formation" },
  { label: "Tax structuring",    title: "International Tax Structuring: How to Stay Compliant",           keyword: "international tax advisory" },
];

type Status = "idle" | "generating" | "rendering" | "ready" | "error";

export default function VideoPage() {
  const [title, setTitle]       = useState("");
  const [status, setStatus]     = useState<Status>("idle");
  const [progress, setProgress] = useState("");
  const [elapsed, setElapsed]   = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [renderId, setRenderId] = useState<string | null>(null);
  const [error, setError]       = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimers = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (pollRef.current)  { clearInterval(pollRef.current);  pollRef.current  = null; }
  };

  const startElapsed = () => {
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
  };

  const startPolling = (id: string) => {
    const started = Date.now();
    const MAX_MS  = 15 * 60 * 1000;

    pollRef.current = setInterval(async () => {
      if (Date.now() - started > MAX_MS) {
        stopTimers();
        setStatus("error");
        setError("Render timed out after 15 minutes.");
        return;
      }
      try {
        const res  = await fetch(`/api/check-video-render?id=${id}`);
        const data = await res.json() as { status: string; url?: string; error?: string };
        const labels: Record<string, string> = {
          queued:    "Queued on Shotstack…",
          fetching:  "Loading assets…",
          rendering: "Rendering video frames…",
          saving:    "Finalising video file…",
        };
        if (data.status === "done" && data.url) {
          stopTimers();
          setVideoUrl(data.url);
          setStatus("ready");
          setProgress("Video ready!");
        } else if (data.status === "failed") {
          stopTimers();
          setStatus("error");
          setError(`Render failed: ${data.error ?? "unknown error"}`);
        } else {
          setProgress(labels[data.status] ?? `Rendering (${data.status})…`);
        }
      } catch { /* retry next tick */ }
    }, 12_000);
  };

  const handleGenerate = async () => {
    if (!title.trim()) return;
    stopTimers();
    setStatus("generating");
    setProgress("Writing video script and generating scenes…");
    setVideoUrl(null);
    setRenderId(null);
    setError("");
    startElapsed();

    try {
      const res = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        stopTimers();
        setStatus("error");
        setError(err.error || "Request failed.");
        return;
      }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "progress") {
              setProgress(String(event.message ?? ""));
            } else if (event.type === "submitted") {
              const rId = String(event.renderId);
              setRenderId(rId);
              setStatus("rendering");
              setProgress(String(event.message ?? "Rendering…"));
              stopTimers();
              startPolling(rId);
              return;
            } else if (event.type === "error") {
              stopTimers();
              setStatus("error");
              setError(String(event.message ?? "Generation failed."));
              return;
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      stopTimers();
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  const handleReset = () => {
    stopTimers();
    setStatus("idle");
    setProgress("");
    setVideoUrl(null);
    setRenderId(null);
    setError("");
    setElapsed(0);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Video Generator</h1>
            <p className="text-sm text-white/35 mt-0.5">
              Narrated slideshow video · Shotstack · {process.env.NEXT_PUBLIC_SHOTSTACK_ENV === "production" ? "Production" : "Sandbox"}
            </p>
          </div>
          <a href="/" className="text-xs text-white/30 hover:text-white/60 transition-colors">← Back to tool</a>
        </div>

        {/* Input */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="block text-xs text-white/40 uppercase tracking-widest">Video Topic / Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
              placeholder="e.g. How to Set Up a Business in a UAE Free Zone"
              className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
            />
          </div>
        </div>

        {/* Sample topics */}
        {status === "idle" && (
          <div className="space-y-2">
            <p className="text-xs text-white/25 uppercase tracking-widest">Quick topics</p>
            <div className="grid grid-cols-2 gap-2">
              {SAMPLE_TOPICS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => setTitle(s.title)}
                  className="text-left px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-150 group"
                >
                  <p className="text-xs font-medium text-white/60 group-hover:text-white/80 transition-colors">{s.label}</p>
                  <p className="text-[10px] text-white/25 mt-0.5 line-clamp-2 leading-relaxed">{s.title}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Generating — asset preparation phase */}
        {status === "generating" && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-white/60">{progress}</p>
              <p className="text-xs text-white/30 tabular-nums">{elapsed}s</p>
            </div>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#C9A84C] rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${Math.min((elapsed / 150) * 90, 90)}%` }}
              />
            </div>
            <p className="text-[10px] text-white/20">Writing script · generating 7 scene images · preparing audio (~2–3 min)</p>
          </div>
        )}

        {/* Rendering — Shotstack phase */}
        {status === "rendering" && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-3">
            <div className="flex items-center gap-3">
              <svg className="w-4 h-4 text-[#C9A84C] animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4" strokeDashoffset="10" />
              </svg>
              <p className="text-sm text-white/60">{progress || "Rendering on Shotstack…"}</p>
            </div>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div className="h-full bg-[#C9A84C] rounded-full animate-pulse" style={{ width: "55%" }} />
            </div>
            {renderId && (
              <p className="text-[10px] text-white/20 font-mono">Render ID: {renderId}</p>
            )}
            <p className="text-[10px] text-white/20">Checking every 12 s · Shotstack sandbox typically renders in 2–5 min</p>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-4 space-y-3">
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={handleReset} className="text-xs text-white/40 hover:text-white/70 transition-colors">
              Try again
            </button>
          </div>
        )}

        {/* Ready — video player */}
        {status === "ready" && videoUrl && (
          <div className="space-y-4">
            <video
              src={videoUrl}
              controls
              autoPlay
              loop
              className="w-full rounded-xl aspect-video bg-black border border-white/[0.06]"
            />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <p className="text-xs text-white/50">Video ready · sandbox watermark visible</p>
              </div>
              <div className="flex items-center gap-4">
                <a
                  href={videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-white/40 hover:text-white/70 transition-colors"
                >
                  Open direct URL ↗
                </a>
                <button onClick={handleReset} className="text-xs text-white/30 hover:text-white/60 transition-colors">
                  Generate another
                </button>
              </div>
            </div>
            {renderId && (
              <p className="text-[10px] text-white/20 font-mono">Render ID: {renderId}</p>
            )}
          </div>
        )}

        {/* Generate / Reset button */}
        {(status === "idle" || status === "ready" || status === "error") && (
          <button
            onClick={handleGenerate}
            disabled={!title.trim()}
            className="w-full flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-sm py-3 rounded-xl transition-colors duration-200"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
            {status === "ready" ? "Generate another video" : "Generate video"}
          </button>
        )}

        {/* What to expect */}
        {status === "idle" && (
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-4 space-y-3">
            <p className="text-[10px] text-white/25 uppercase tracking-widest">What gets generated</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {[
                ["7 scenes", "script segmented by topic"],
                ["7 images", "purpose-generated per scene (Imagen 4)"],
                ["Narration", "text-to-speech via Kokoro"],
                ["Dark overlay", "55% opacity over each image"],
                ["Title cards", "navy/gold Aston brand labels"],
                ["Background music", "soft corporate ambience"],
                ["Logo watermark", "bottom right throughout"],
                ["CTA end card", "aston.ae, 8 seconds"],
              ].map(([label, desc]) => (
                <div key={label} className="flex items-start gap-2">
                  <div className="w-1 h-1 rounded-full bg-[#C9A84C] mt-1.5 shrink-0" />
                  <div>
                    <span className="text-xs text-white/50">{label}</span>
                    <span className="text-[11px] text-white/25 ml-1.5">{desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
