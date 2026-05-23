"use client";

import { useState, useEffect, useRef } from "react";

const SAMPLE_TOPICS = [
  {
    label: "Off-plan investing",
    title: "Why Off-Plan Properties in Dubai Offer the Best ROI in 2025",
    keyword: "off-plan properties Dubai ROI",
  },
  {
    label: "Golden Visa",
    title: "How to Get a UAE Golden Visa Through Property Investment",
    keyword: "UAE golden visa property investment",
  },
  {
    label: "DIFC explained",
    title: "What is DIFC and Why Do Global Businesses Choose Dubai",
    keyword: "DIFC Dubai International Financial Centre",
  },
  {
    label: "Business setup",
    title: "Step-by-Step Guide to Setting Up a Business in Dubai",
    keyword: "business setup Dubai free zone",
  },
  {
    label: "Market outlook",
    title: "Dubai Real Estate Market Forecast: What Investors Need to Know",
    keyword: "Dubai real estate market 2025",
  },
  {
    label: "Tax advantages",
    title: "Zero Income Tax in the UAE: A Complete Guide for Expats",
    keyword: "UAE tax benefits expats",
  },
  {
    label: "Luxury areas",
    title: "The Most Exclusive Residential Areas in Dubai for HNW Buyers",
    keyword: "luxury properties Dubai Palm Jumeirah",
  },
  {
    label: "Mortgage guide",
    title: "UAE Mortgage Guide: How Foreigners Can Finance Property in Dubai",
    keyword: "UAE mortgage guide expats",
  },
];

type VideoStatus = "idle" | "scripting" | "rendering" | "ready" | "error";
type InputMode   = "topic" | "script";

export default function VideoPage() {
  const [mode, setMode]               = useState<InputMode>("topic");
  const [title, setTitle]             = useState("");
  const [keyword, setKeyword]         = useState("");
  const [rawScript, setRawScript]     = useState("");
  const [status, setStatus]           = useState<VideoStatus>("idle");
  const [progress, setProgress]       = useState("");
  const [elapsed, setElapsed]         = useState(0);
  const [videoUrl, setVideoUrl]       = useState<string | null>(null);
  const [scriptUsed, setScriptUsed]   = useState<string | null>(null);
  const [showScript, setShowScript]   = useState(false);
  const [error, setError]             = useState("");
  const timerRef                      = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live elapsed timer
  useEffect(() => {
    if (status !== "scripting" && status !== "rendering") {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    const start = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status]);

  const isGenerating = status === "scripting" || status === "rendering";

  const canGenerate = mode === "topic"
    ? title.trim().length > 0
    : rawScript.trim().length > 0;

  const handleGenerate = async () => {
    if (!canGenerate) return;

    setStatus("scripting");
    setProgress(mode === "topic" ? "Writing video script…" : "Using provided script…");
    setElapsed(0);
    setVideoUrl(null);
    setScriptUsed(null);
    setError("");

    try {
      const body = mode === "topic"
        ? { title: title.trim(), keyword: keyword.trim() || title.trim() }
        : { title: "Custom Script", script: rawScript.trim() };

      const res = await fetch("/api/generate-heygen-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setError(err.error || "Generation failed.");
        setStatus("error");
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
            const ev = JSON.parse(line) as {
              type: string;
              message?: string;
              videoUrl?: string;
              script?: string;
              duration?: number;
            };
            if (ev.type === "progress") {
              if (ev.message) setProgress(ev.message);
              if (ev.message?.toLowerCase().includes("render")) setStatus("rendering");
            }
            if (ev.type === "done" && ev.videoUrl) {
              setVideoUrl(ev.videoUrl);
              setScriptUsed(ev.script ?? null);
              setStatus("ready");
            }
            if (ev.type === "error") {
              setError(ev.message ?? "Generation failed.");
              setStatus("error");
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setProgress("");
    setElapsed(0);
    setVideoUrl(null);
    setScriptUsed(null);
    setShowScript(false);
    setError("");
  };

  const formatElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  // Progress bar: scripting = 0–25%, rendering = 25–90%
  const progressPct = status === "scripting"
    ? Math.min(elapsed * 3, 25)
    : Math.min(25 + (elapsed / 300) * 65, 90);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">HeyGen Video Tester</h1>
            <p className="text-sm text-white/35 mt-0.5">Generate avatar videos without publishing an article</p>
          </div>
          <a href="/" className="text-xs text-white/30 hover:text-white/60 transition-colors">
            ← Back to tool
          </a>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-1 p-1 bg-white/[0.04] rounded-xl border border-white/[0.07] w-fit">
          {(["topic", "script"] as InputMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                mode === m
                  ? "bg-white/10 text-white"
                  : "text-white/35 hover:text-white/60"
              }`}
            >
              {m === "topic" ? "From topic" : "Paste script"}
            </button>
          ))}
        </div>

        {/* Input — topic mode */}
        {mode === "topic" && (
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="block text-xs text-white/40 uppercase tracking-widest">Article title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Why Off-Plan Properties in Dubai Offer the Best ROI"
                className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
              />
            </div>
            <div className="space-y-2">
              <label className="block text-xs text-white/40 uppercase tracking-widest">
                Focus keyword <span className="text-white/20 normal-case">(optional)</span>
              </label>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="e.g. off-plan properties Dubai"
                className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
              />
            </div>
          </div>
        )}

        {/* Input — script mode */}
        {mode === "script" && (
          <div className="space-y-2">
            <label className="block text-xs text-white/40 uppercase tracking-widest">Script</label>
            <textarea
              value={rawScript}
              onChange={(e) => setRawScript(e.target.value)}
              rows={8}
              placeholder="Paste your spoken script here (aim for 420–450 words for a 3-minute video)…"
              className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 resize-none focus:outline-none focus:border-white/20 transition-colors"
            />
            <p className="text-[10px] text-white/20">
              {rawScript.trim().split(/\s+/).filter(Boolean).length} words
              {" · "}
              ~{Math.round(rawScript.trim().split(/\s+/).filter(Boolean).length / 150)} min at 150 wpm
            </p>
          </div>
        )}

        {/* Sample topics (topic mode only) */}
        {mode === "topic" && (
          <div className="space-y-2">
            <p className="text-xs text-white/30 uppercase tracking-widest">Sample topics</p>
            <div className="grid grid-cols-2 gap-2">
              {SAMPLE_TOPICS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => { setTitle(s.title); setKeyword(s.keyword); }}
                  className="text-left px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-150 group"
                >
                  <p className="text-xs font-medium text-white/60 group-hover:text-white/80 transition-colors">{s.label}</p>
                  <p className="text-[10px] text-white/25 mt-0.5 line-clamp-2 leading-relaxed">{s.title}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Generate button */}
        {(status === "idle" || status === "error") && (
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="w-full flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] disabled:opacity-30 disabled:cursor-not-allowed text-black font-semibold text-sm py-3 rounded-xl transition-colors duration-200"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
            Generate avatar video
          </button>
        )}

        {/* Error */}
        {status === "error" && error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 space-y-1">
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={handleReset} className="text-xs text-white/30 hover:text-white/60 transition-colors">
              Try again
            </button>
          </div>
        )}

        {/* Progress */}
        {isGenerating && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                  status === "scripting"
                    ? "bg-[#C9A84C]/20 text-[#C9A84C]"
                    : "bg-white/[0.06] text-white/30 line-through"
                }`}>
                  1 Script
                </span>
                <span className="text-white/20 text-xs">→</span>
                <span className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
                  status === "rendering"
                    ? "bg-[#C9A84C]/20 text-[#C9A84C]"
                    : "bg-white/[0.06] text-white/30"
                }`}>
                  2 Render
                </span>
              </div>
              <p className="text-xs text-white/30 tabular-nums">{formatElapsed(elapsed)}</p>
            </div>
            <p className="text-sm text-white/60">{progress || "Processing…"}</p>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#C9A84C] rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-[10px] text-white/20">HeyGen typically takes 3–6 minutes to render</p>
          </div>
        )}

        {/* Video preview */}
        {status === "ready" && videoUrl && (
          <div className="space-y-4">
            <video
              src={videoUrl}
              controls
              autoPlay
              className="w-full rounded-xl aspect-video bg-black border border-white/[0.06]"
            />

            {/* Script toggle */}
            {scriptUsed && (
              <button
                onClick={() => setShowScript(!showScript)}
                className="text-xs text-white/30 hover:text-white/60 transition-colors"
              >
                {showScript ? "Hide script ↑" : "View script used ↓"}
              </button>
            )}
            {showScript && scriptUsed && (
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-4">
                <p className="text-xs text-white/50 leading-relaxed whitespace-pre-wrap">{scriptUsed}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleReset}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 text-sm transition-all"
              >
                Try another topic
              </button>
              <a
                href={videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 py-2.5 rounded-xl border border-[#C9A84C]/30 text-[#C9A84C] hover:border-[#C9A84C]/60 text-sm transition-all text-center"
              >
                Open / Download
              </a>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
