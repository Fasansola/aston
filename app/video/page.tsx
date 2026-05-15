"use client";

import { useState, useEffect } from "react";

const SAMPLE_PROMPTS = [
  {
    label: "Dubai skyline",
    prompt: "Cinematic slow aerial drift over the Dubai skyline at golden hour, glass skyscrapers reflecting amber light across the waterfront, no people, professional and aspirational atmosphere.",
  },
  {
    label: "Modern office",
    prompt: "Smooth dolly shot through a sleek glass-walled boardroom overlooking a gleaming city skyline, empty chairs around a polished conference table, warm afternoon light, no people visible.",
  },
  {
    label: "Financial district",
    prompt: "Slow upward tilt from street level to the top of a steel and glass tower in the Dubai International Financial Centre, dramatic blue-hour lighting, no people or text in frame.",
  },
  {
    label: "Business documents",
    prompt: "Extreme close-up macro shot of a luxury fountain pen resting on a crisp contract document, shallow depth of field, warm desk-lamp light, slow pull-back reveal of a modern office desk.",
  },
  {
    label: "Tech / screens",
    prompt: "Cinematic slow pan across multiple glowing monitors displaying charts and dashboards in a dark modern office, no people, cool blue ambient light, subtle lens flare.",
  },
  {
    label: "Architecture",
    prompt: "Low-angle tracking shot along the base of a curved glass facade in DIFC, abstract reflections of clouds moving across the surface, dawn light, no people or text.",
  },
  {
    label: "UAE flag / branding",
    prompt: "Slow cinematic zoom into a polished metal company logo plaque mounted on a marble wall, warm spotlighting, soft bokeh background of a modern lobby, no people.",
  },
  {
    label: "Abstract luxury",
    prompt: "Macro cinematic shot of rippling water reflecting a golden sunset, slow motion, abstract and aspirational, no people or text anywhere in the frame.",
  },
];

type VideoStatus = "idle" | "generating" | "ready" | "uploading" | "uploaded" | "error";

export default function VideoPage() {
  const [prompt, setPrompt]           = useState("");
  const [status, setStatus]           = useState<VideoStatus>("idle");
  const [progress, setProgress]       = useState("");
  const [elapsed, setElapsed]         = useState(0);
  const [videoBase64, setVideoBase64] = useState<string | null>(null);
  const [videoMime, setVideoMime]     = useState("video/mp4");
  const [error, setError]             = useState("");

  // Live elapsed timer
  useEffect(() => {
    if (status !== "generating") return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [status]);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setStatus("generating");
    setProgress("Submitting to Veo 2…");
    setElapsed(0);
    setVideoBase64(null);
    setError("");

    try {
      const res = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: prompt.trim(), keyword: prompt.trim() }),
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
              type: string; message?: string;
              videoBase64?: string; mimeType?: string;
            };
            if (ev.type === "progress" && ev.message) setProgress(ev.message);
            if (ev.type === "done" && ev.videoBase64) {
              setVideoBase64(ev.videoBase64);
              setVideoMime(ev.mimeType ?? "video/mp4");
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
    setVideoBase64(null);
    setError("");
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Video Generator</h1>
            <p className="text-sm text-white/35 mt-0.5">Test Veo 2 prompts without generating an article</p>
          </div>
          <a href="/" className="text-xs text-white/30 hover:text-white/60 transition-colors">
            ← Back to tool
          </a>
        </div>

        {/* Prompt input */}
        <div className="space-y-3">
          <label className="block text-xs text-white/40 uppercase tracking-widest">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="Describe the scene — no people, no text/signs, no logos…"
            className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 resize-none focus:outline-none focus:border-white/20 transition-colors"
          />
          <p className="text-[10px] text-white/20">
            Veo 2 tip: mention camera movement (slow pan, aerial drift, dolly), lighting, and setting. Avoid people, hands, faces, and any readable text.
          </p>
        </div>

        {/* Sample prompts */}
        <div className="space-y-2">
          <p className="text-xs text-white/30 uppercase tracking-widest">Sample prompts</p>
          <div className="grid grid-cols-2 gap-2">
            {SAMPLE_PROMPTS.map((s) => (
              <button
                key={s.label}
                onClick={() => setPrompt(s.prompt)}
                className="text-left px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-150 group"
              >
                <p className="text-xs font-medium text-white/60 group-hover:text-white/80 transition-colors">{s.label}</p>
                <p className="text-[10px] text-white/25 mt-0.5 line-clamp-2 leading-relaxed">{s.prompt}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Generate button */}
        {(status === "idle" || status === "error") && (
          <button
            onClick={handleGenerate}
            disabled={!prompt.trim()}
            className="w-full flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] disabled:opacity-30 disabled:cursor-not-allowed text-black font-semibold text-sm py-3 rounded-xl transition-colors duration-200"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
            </svg>
            Generate video
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
        {status === "generating" && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-white/60">{progress || "Generating…"}</p>
              <p className="text-xs text-white/30 tabular-nums">{elapsed}s</p>
            </div>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div
                className="h-full bg-[#C9A84C] rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${Math.min((elapsed / 180) * 95, 95)}%` }}
              />
            </div>
            <p className="text-[10px] text-white/20">Veo 2 typically takes 2–4 minutes</p>
          </div>
        )}

        {/* Video preview */}
        {status === "ready" && videoBase64 && (
          <div className="space-y-4">
            <video
              src={`data:${videoMime};base64,${videoBase64}`}
              controls
              loop
              autoPlay
              muted
              className="w-full rounded-xl aspect-video bg-black border border-white/[0.06]"
            />
            <div className="flex gap-3">
              <button
                onClick={handleReset}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-white/40 hover:text-white/70 hover:border-white/20 text-sm transition-all"
              >
                Try another prompt
              </button>
              <button
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = `data:${videoMime};base64,${videoBase64}`;
                  a.download = "veo-video.mp4";
                  a.click();
                }}
                className="flex-1 py-2.5 rounded-xl border border-[#C9A84C]/30 text-[#C9A84C] hover:border-[#C9A84C]/60 text-sm transition-all"
              >
                Download video
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
