"use client";

import { useState, useEffect, useRef } from "react";

const SAMPLE_TOPICS = [
  {
    label: "UAE Free Zone",
    title: "How to Set Up a Business in a UAE Free Zone: What You Need to Know",
    keyword: "UAE free zone business setup",
  },
  {
    label: "Holding structures",
    title: "How International Holding Structures Work and Why They Matter",
    keyword: "international holding company structure",
  },
  {
    label: "Corporate banking",
    title: "Why Most Businesses Fail at Corporate Banking — and How to Fix It",
    keyword: "international corporate banking account opening",
  },
  {
    label: "Nominee directors",
    title: "Nominee Directors Explained: What They Are and When You Actually Need One",
    keyword: "nominee director services international",
  },
  {
    label: "UAE vs UK",
    title: "UAE vs UK Company Formation: Which Structure Is Right for You",
    keyword: "UAE UK company formation comparison",
  },
  {
    label: "Offshore vehicles",
    title: "Seychelles and Panama Companies: What They're Actually Used For",
    keyword: "offshore company Seychelles Panama",
  },
  {
    label: "Tax structuring",
    title: "International Tax Structuring: How to Stay Compliant While Operating Efficiently",
    keyword: "international tax advisory structuring",
  },
  {
    label: "Banking approval",
    title: "How to Structure Your Company So Banks Will Actually Approve It",
    keyword: "corporate banking approval company structure",
  },
];

type Stage =
  | "idle"
  | "scripting"       // GPT is writing the script
  | "script_ready"    // script shown, waiting for user to approve
  | "rendering"       // ElevenLabs + HeyGen rendering
  | "ready"           // video ready
  | "error";

export default function VideoPage() {
  const [title, setTitle]       = useState("");
  const [keyword, setKeyword]   = useState("");
  const [stage, setStage]       = useState<Stage>("idle");
  const [script, setScript]     = useState("");
  const [wordCount, setWordCount] = useState(0);
  const [progress, setProgress] = useState("");
  const [elapsed, setElapsed]   = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError]       = useState("");
  const [copied, setCopied]     = useState(false);
  const timerRef                = useRef<ReturnType<typeof setInterval> | null>(null);

  // Timer — runs during scripting and rendering
  useEffect(() => {
    if (stage === "scripting" || stage === "rendering") {
      const start = Date.now();
      timerRef.current = setInterval(
        () => setElapsed(Math.round((Date.now() - start) / 1000)),
        1000
      );
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [stage]);

  // ── Step 1: generate script ──────────────────────────────────
  const handleGenerateScript = async () => {
    if (!title.trim()) return;
    setStage("scripting");
    setElapsed(0);
    setScript("");
    setVideoUrl(null);
    setError("");

    try {
      const res = await fetch("/api/generate-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), keyword: keyword.trim() || title.trim() }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Script generation failed.");
        setStage("error");
        return;
      }

      setScript(json.script);
      setWordCount(json.wordCount);
      setStage("script_ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("error");
    }
  };

  // ── Step 2: generate video from approved script ──────────────
  const handleGenerateVideo = async () => {
    if (!script.trim()) return;
    setStage("rendering");
    setProgress("Generating voice audio with ElevenLabs…");
    setElapsed(0);
    setVideoUrl(null);
    setError("");

    try {
      const res = await fetch("/api/generate-heygen-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), script: script.trim() }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setError(err.error || "Video generation failed.");
        setStage("error");
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
            };
            if (ev.type === "progress" && ev.message) setProgress(ev.message);
            if (ev.type === "done" && ev.videoUrl) {
              setVideoUrl(ev.videoUrl);
              setStage("ready");
            }
            if (ev.type === "error") {
              setError(ev.message ?? "Video generation failed.");
              setStage("error");
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("error");
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(script);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setStage("idle");
    setScript("");
    setWordCount(0);
    setVideoUrl(null);
    setProgress("");
    setElapsed(0);
    setError("");
  };

  const formatElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  };

  const estMins = wordCount > 0 ? (wordCount / 145).toFixed(1) : null;

  // Progress bar: scripting stays short, rendering fills over 4 min
  const progressPct =
    stage === "scripting"
      ? Math.min(elapsed * 5, 90)
      : Math.min((elapsed / 240) * 95, 95);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">HeyGen Video Tester</h1>
            <p className="text-sm text-white/35 mt-0.5">Generate and preview avatar videos before publishing</p>
          </div>
          <a href="/" className="text-xs text-white/30 hover:text-white/60 transition-colors">
            ← Back to tool
          </a>
        </div>

        {/* ── STAGE: idle or script_ready (show inputs) ── */}
        {(stage === "idle" || stage === "script_ready" || stage === "error") && (
          <>
            {/* Inputs */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="block text-xs text-white/40 uppercase tracking-widest">Article Title</label>
                <input
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); if (stage === "script_ready") setStage("idle"); }}
                  placeholder="e.g. Why Off-Plan Properties in Dubai Offer the Best ROI in 2025"
                  className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs text-white/40 uppercase tracking-widest">
                  Focus Keyword <span className="text-white/20 normal-case tracking-normal">(optional)</span>
                </label>
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="e.g. off-plan properties Dubai ROI"
                  className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
                />
              </div>
            </div>

            {/* Sample topics */}
            {stage === "idle" && (
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

            {/* Error */}
            {stage === "error" && error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Generate Script button */}
            <button
              onClick={handleGenerateScript}
              disabled={!title.trim()}
              className="w-full flex items-center justify-center gap-2 bg-white/[0.07] hover:bg-white/[0.11] disabled:opacity-30 disabled:cursor-not-allowed text-white font-semibold text-sm py-3 rounded-xl border border-white/10 transition-all duration-200"
            >
              <svg className="w-4 h-4 text-white/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
              </svg>
              {stage === "script_ready" ? "Regenerate script" : "Generate script"}
            </button>
          </>
        )}

        {/* ── STAGE: scripting — spinner ── */}
        {stage === "scripting" && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-6 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-white/60">Writing your video script…</p>
              <p className="text-xs text-white/30 tabular-nums">{formatElapsed(elapsed)}</p>
            </div>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#C9A84C] rounded-full transition-all duration-500 ease-linear"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="text-[10px] text-white/20">GPT-4o is crafting a natural 3–4 minute spoken script</p>
          </div>
        )}

        {/* ── STAGE: script_ready — show script ── */}
        {stage === "script_ready" && script && (
          <div className="space-y-4">
            {/* Script header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <p className="text-xs text-white/50">Script ready</p>
                {estMins && (
                  <span className="text-[10px] text-white/25">
                    · {wordCount} words · ~{estMins} min
                  </span>
                )}
              </div>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/60 transition-colors"
              >
                {copied ? (
                  <>
                    <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                    </svg>
                    <span className="text-emerald-400">Copied</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                    Copy script
                  </>
                )}
              </button>
            </div>

            {/* Editable script */}
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              rows={14}
              className="w-full bg-white/[0.03] border border-white/[0.08] rounded-xl px-4 py-4 text-sm text-white/70 leading-relaxed resize-none focus:outline-none focus:border-white/20 transition-colors"
            />

            <p className="text-[10px] text-white/20">
              You can edit the script above before generating the video.
            </p>

            {/* Generate Video button */}
            <button
              onClick={handleGenerateVideo}
              disabled={!script.trim()}
              className="w-full flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] disabled:opacity-30 disabled:cursor-not-allowed text-black font-semibold text-sm py-3 rounded-xl transition-colors duration-200"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
              </svg>
              Generate video with this script
            </button>
          </div>
        )}

        {/* ── STAGE: rendering — progress bar ── */}
        {stage === "rendering" && (
          <div className="space-y-6">
            {/* Script preview (collapsed) */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
              <p className="text-[10px] text-white/30 uppercase tracking-widest mb-2">Script being rendered</p>
              <p className="text-xs text-white/40 line-clamp-3 leading-relaxed">{script}</p>
            </div>

            {/* Progress */}
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-white/[0.06] text-white/30 line-through">1 Script</span>
                  <span className="text-white/20 text-xs">→</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[#C9A84C]/20 text-[#C9A84C]">2 Render</span>
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
              <p className="text-[10px] text-white/20">1080p Avatar V videos typically take 4–8 minutes to render</p>
            </div>
          </div>
        )}

        {/* ── STAGE: ready — video player ── */}
        {stage === "ready" && videoUrl && (
          <div className="space-y-4">
            <video
              src={videoUrl}
              controls
              autoPlay
              className="w-full rounded-xl aspect-video bg-black border border-white/[0.06]"
            />

            <div className="flex gap-3">
              <button
                onClick={handleReset}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 text-sm transition-all"
              >
                Start over
              </button>
              <button
                onClick={() => setStage("script_ready")}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 text-sm transition-all"
              >
                Edit script &amp; re-render
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
