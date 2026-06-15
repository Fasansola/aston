"use client";

import { useState, useRef, useEffect } from "react";

const SAMPLE_TOPICS = [
  { label: "UAE Free Zone",      title: "How to set up a business in a UAE free zone" },
  { label: "Corporate banking",  title: "Why most businesses fail at corporate banking" },
  { label: "Holding structures", title: "How international holding structures actually work" },
  { label: "Golden Visa",        title: "Dubai Golden Visa through business ownership" },
  { label: "Offshore vehicles",  title: "What Seychelles and BVI companies are really used for" },
  { label: "Corporate tax",      title: "UAE corporate tax: what business owners get wrong" },
];

type Status = "idle" | "generating" | "ready" | "error";
type Turn = { speaker: "host" | "expert"; text: string };

export default function PodcastTestPage() {
  const [title, setTitle]       = useState("");
  const [notes, setNotes]       = useState("");
  const [provider, setProvider] = useState<"elevenlabs" | "kokoro">("kokoro");
  const [length, setLength]     = useState<"short" | "medium">("short");
  const [status, setStatus]     = useState<Status>("idle");
  const [progress, setProgress] = useState("");
  const [elapsed, setElapsed]   = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [turns, setTurns]       = useState<Turn[]>([]);
  const [episodeTitle, setEpisodeTitle] = useState("");
  const [error, setError]       = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Revoke the blob URL when it changes/unmounts to avoid leaks.
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  const startElapsed = () => {
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
  };
  const stopElapsed = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  const handleGenerate = async () => {
    if (!title.trim()) return;
    stopElapsed();
    setStatus("generating");
    setProgress("Starting…");
    setError("");
    setAudioUrl(null);
    setTurns([]);
    setEpisodeTitle("");
    startElapsed();

    try {
      const res = await fetch("/api/generate-podcast-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), sourceText: notes.trim() || undefined, ttsProvider: provider, length }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        stopElapsed(); setStatus("error"); setError(err.error || "Request failed.");
        return;
      }
      const reader = res.body.getReader();
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
            } else if (event.type === "done") {
              const b64 = String(event.audioBase64 ?? "");
              const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
              const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
              setAudioUrl(url);
              setTurns((event.turns as Turn[]) ?? []);
              setEpisodeTitle(String(event.episodeTitle ?? ""));
              stopElapsed();
              setStatus("ready");
            } else if (event.type === "error") {
              stopElapsed(); setStatus("error"); setError(String(event.message ?? "Generation failed."));
              return;
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      stopElapsed(); setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  const handleReset = () => {
    stopElapsed();
    setStatus("idle"); setProgress(""); setError(""); setAudioUrl(null); setTurns([]); setEpisodeTitle(""); setElapsed(0);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Podcast Tester</h1>
            <p className="text-sm text-white/35 mt-0.5">Two-voice conversation · preview only · nothing is published</p>
          </div>
          <a href="/" className="text-xs text-white/30 hover:text-white/60 transition-colors">← Back to tool</a>
        </div>

        {/* Inputs */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs text-white/40 uppercase tracking-widest">Topic / Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
              placeholder="e.g. Dubai Golden Visa through business ownership"
              className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs text-white/40 uppercase tracking-widest">Notes / source (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Paste any facts, figures or angle you want covered. Leave blank to let it improvise from the topic."
              className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/20 transition-colors resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs text-white/40 uppercase tracking-widest">Voice engine</label>
              <select value={provider} onChange={(e) => setProvider(e.target.value as "elevenlabs" | "kokoro")}
                className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-3 py-2.5 text-sm text-white/80 focus:outline-none focus:border-white/20">
                <option value="elevenlabs">ElevenLabs (premium)</option>
                <option value="kokoro">Kokoro (free)</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs text-white/40 uppercase tracking-widest">Length</label>
              <select value={length} onChange={(e) => setLength(e.target.value as "short" | "medium")}
                className="w-full bg-white/[0.04] border border-white/[0.09] rounded-xl px-3 py-2.5 text-sm text-white/80 focus:outline-none focus:border-white/20">
                <option value="short">Short (~3–4 min)</option>
                <option value="medium">Medium (~8–12 min)</option>
              </select>
            </div>
          </div>
        </div>

        {status === "idle" && (
          <div className="space-y-2">
            <p className="text-xs text-white/25 uppercase tracking-widest">Quick topics</p>
            <div className="grid grid-cols-2 gap-2">
              {SAMPLE_TOPICS.map((s) => (
                <button key={s.label} onClick={() => setTitle(s.title)}
                  className="text-left px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-white/[0.12] transition-all duration-150 group">
                  <p className="text-xs font-medium text-white/60 group-hover:text-white/80 transition-colors">{s.label}</p>
                  <p className="text-[10px] text-white/25 mt-0.5 line-clamp-2 leading-relaxed">{s.title}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {status === "generating" && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-white/60">{progress}</p>
              <p className="text-xs text-white/30 tabular-nums">{elapsed}s</p>
            </div>
            <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
              <div className="h-full bg-[#C9A84C] rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${Math.min((elapsed / (length === "medium" ? 180 : 90)) * 90, 90)}%` }} />
            </div>
            <p className="text-[10px] text-white/20">Writing the dialogue, voicing both speakers, stitching the music.</p>
          </div>
        )}

        {status === "error" && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-4 space-y-3">
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={handleReset} className="text-xs text-white/40 hover:text-white/70 transition-colors">Try again</button>
          </div>
        )}

        {status === "ready" && audioUrl && (
          <div className="space-y-4">
            {episodeTitle && <p className="text-sm text-white/70 font-medium">{episodeTitle}</p>}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={audioUrl} controls autoPlay className="w-full h-11 rounded-lg" />
            <div className="flex items-center gap-4">
              <a href={audioUrl} download="podcast-test.mp3" className="text-xs text-[#C9A84C]/80 hover:text-[#C9A84C] transition-colors">Download MP3 ↓</a>
              <button onClick={handleReset} className="text-xs text-white/30 hover:text-white/60 transition-colors">Generate another</button>
            </div>
            {turns.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] px-4 py-4 space-y-2 max-h-80 overflow-y-auto">
                <p className="text-[10px] text-white/25 uppercase tracking-widest mb-1">Transcript</p>
                {turns.map((t, i) => (
                  <p key={i} className="text-xs leading-relaxed">
                    <span className={t.speaker === "host" ? "text-[#C9A84C]/80" : "text-sky-300/70"}>{t.speaker === "host" ? "Host" : "Expert"}:</span>{" "}
                    <span className="text-white/55">{t.text}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {(status === "idle" || status === "ready" || status === "error") && (
          <button onClick={handleGenerate} disabled={!title.trim()}
            className="w-full flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] disabled:opacity-40 disabled:cursor-not-allowed text-black font-semibold text-sm py-3 rounded-xl transition-colors duration-200">
            {status === "ready" ? "Generate another" : "Generate podcast"}
          </button>
        )}

      </div>
    </div>
  );
}
