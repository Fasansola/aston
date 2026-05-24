"use client";

import { useState, useEffect, useRef } from "react";
import type { ScriptSegment } from "@/lib/heygen";

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

type Stage = "idle" | "scripting" | "ready" | "error";

const EMOTION_COLOURS: Record<string, string> = {
  "warm":        "text-amber-400",
  "curious":     "text-sky-400",
  "empathetic":  "text-violet-400",
  "knowing":     "text-violet-400",
  "authoritative": "text-emerald-400",
  "engaged":     "text-emerald-400",
  "direct":      "text-emerald-400",
  "confident":   "text-emerald-400",
  "storytelling":"text-amber-400",
  "calm":        "text-sky-400",
  "clear":       "text-sky-400",
};

function emotionColour(emotion: string): string {
  const lower = emotion.toLowerCase();
  for (const [key, cls] of Object.entries(EMOTION_COLOURS)) {
    if (lower.includes(key)) return cls;
  }
  return "text-white/40";
}

export default function VideoPage() {
  const [title, setTitle]         = useState("");
  const [keyword, setKeyword]     = useState("");
  const [stage, setStage]         = useState<Stage>("idle");
  const [segments, setSegments]   = useState<ScriptSegment[]>([]);
  const [totalWords, setTotalWords] = useState(0);
  const [elapsed, setElapsed]     = useState(0);
  const [error, setError]         = useState("");
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const [copiedSegment, setCopiedSegment] = useState<number | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (stage === "scripting") {
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

  const handleGenerate = async () => {
    if (!title.trim()) return;
    setStage("scripting");
    setElapsed(0);
    setSegments([]);
    setError("");
    setExpandedNotes(new Set());

    try {
      const res = await fetch("/api/generate-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:   title.trim(),
          keyword: keyword.trim() || title.trim(),
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Script generation failed.");
        setStage("error");
        return;
      }

      setSegments(json.segments);
      setTotalWords(json.totalWords);
      setStage("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStage("error");
    }
  };

  const handleCopySegment = async (seg: ScriptSegment) => {
    await navigator.clipboard.writeText(seg.script);
    setCopiedSegment(seg.number);
    setTimeout(() => setCopiedSegment(null), 2000);
  };

  const handleCopyAll = async () => {
    const full = segments.map((s) =>
      `[SEGMENT ${s.number} — ${s.timestamp}]\n${s.script}`
    ).join("\n\n");
    await navigator.clipboard.writeText(full);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const toggleNotes = (num: number) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      next.has(num) ? next.delete(num) : next.add(num);
      return next;
    });
  };

  const estMins = totalWords > 0 ? (totalWords / 145).toFixed(1) : null;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Video Script Generator</h1>
            <p className="text-sm text-white/35 mt-0.5">
              Generates a segmented production brief for HeyGen studio
            </p>
          </div>
          <a href="/" className="text-xs text-white/30 hover:text-white/60 transition-colors">
            ← Back to tool
          </a>
        </div>

        {/* Inputs — always visible */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="block text-xs text-white/40 uppercase tracking-widest">Article Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
              placeholder="e.g. Why Most Businesses Fail at Corporate Banking — and How to Fix It"
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
              placeholder="e.g. international corporate banking account opening"
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

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={!title.trim() || stage === "scripting"}
          className="w-full flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-sm py-3 rounded-xl transition-colors duration-200"
        >
          {stage === "scripting" ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              Writing script… {elapsed}s
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
              </svg>
              {stage === "ready" ? "Regenerate script" : "Generate script"}
            </>
          )}
        </button>

        {/* ── Segmented script output ── */}
        {stage === "ready" && segments.length > 0 && (
          <div className="space-y-5">

            {/* Summary bar */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <p className="text-xs text-white/50">
                  {segments.length} segments
                  <span className="text-white/25 mx-1.5">·</span>
                  {totalWords} words
                  <span className="text-white/25 mx-1.5">·</span>
                  ~{estMins} min
                </p>
              </div>
              <button
                onClick={handleCopyAll}
                className="flex items-center gap-1.5 text-xs text-white/30 hover:text-white/60 transition-colors"
              >
                {copiedAll ? (
                  <span className="text-emerald-400">✓ Copied all</span>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                    Copy all segments
                  </>
                )}
              </button>
            </div>

            {/* Segment cards */}
            {segments.map((seg) => (
              <div
                key={seg.number}
                className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden"
              >
                {/* Segment header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-white/70 bg-white/[0.07] px-2 py-0.5 rounded-md">
                      {seg.number}
                    </span>
                    <span className="text-xs text-white/40">{seg.timestamp}</span>
                    <span className="text-[10px] text-white/25">{seg.duration}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-[10px] font-medium ${emotionColour(seg.emotion)}`}>
                      {seg.emotion}
                    </span>
                    <button
                      onClick={() => handleCopySegment(seg)}
                      className="text-xs text-white/25 hover:text-white/60 transition-colors"
                    >
                      {copiedSegment === seg.number ? (
                        <span className="text-emerald-400">✓</span>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {/* Script text */}
                <div className="px-4 py-4">
                  <p className="text-sm text-white/75 leading-relaxed">{seg.script}</p>
                </div>

                {/* Production notes toggle */}
                <button
                  onClick={() => toggleNotes(seg.number)}
                  className="w-full flex items-center justify-between px-4 py-2.5 border-t border-white/[0.05] text-[10px] text-white/30 hover:text-white/50 hover:bg-white/[0.02] transition-all"
                >
                  <span className="uppercase tracking-widest">HeyGen Studio Notes</span>
                  <svg
                    className={`w-3 h-3 transition-transform ${expandedNotes.has(seg.number) ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {expandedNotes.has(seg.number) && (
                  <div className="px-4 pb-4 space-y-2 border-t border-white/[0.05] bg-white/[0.01]">
                    <div className="flex gap-2 pt-3">
                      <span className="text-[10px] text-white/25 uppercase tracking-widest w-14 shrink-0 pt-0.5">Pace</span>
                      <p className="text-xs text-white/45 leading-relaxed">{seg.pacing}</p>
                    </div>
                    <div className="flex gap-2">
                      <span className="text-[10px] text-white/25 uppercase tracking-widest w-14 shrink-0 pt-0.5">Studio</span>
                      <p className="text-xs text-white/45 leading-relaxed">{seg.heygenNotes}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* How to use in HeyGen */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-4 space-y-2">
              <p className="text-[10px] text-white/30 uppercase tracking-widest">How to use in HeyGen Studio</p>
              <ol className="space-y-1.5">
                {[
                  "Open HeyGen Studio and create a new video",
                  "Add a scene for each segment above",
                  "Paste each segment's script into its scene",
                  "Set the avatar expression and pacing per the Studio Notes",
                  "Generate each scene separately — do not stitch into one long clip",
                  "Download all scenes and edit together in CapCut or Premiere",
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <span className="text-[10px] text-white/20 font-mono mt-0.5">{i + 1}.</span>
                    <p className="text-xs text-white/40 leading-relaxed">{step}</p>
                  </li>
                ))}
              </ol>
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
