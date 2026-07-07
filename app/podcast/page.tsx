"use client";

import { useState, useRef, useEffect } from "react";
import StudioNav from "../components/StudioNav";

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
  const [length, setLength]     = useState<3 | 15 | 30 | 45 | 60>(3);
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
        body: JSON.stringify({ title: title.trim(), sourceText: notes.trim() || undefined, length }),
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
    <div className="min-h-screen text-white">
      <div className="studio-bg" />
      <StudioNav />

      <div className="relative z-10 max-w-2xl mx-auto px-6 py-12 space-y-8">

        <header className="rise-in">
          <p className="label-caps mb-2.5">Audio · preview only</p>
          <h1 className="font-display text-4xl text-white/95 tracking-tight">
            Podcast <span className="text-gold">studio</span>
          </h1>
          <p className="text-sm text-white/40 mt-3 leading-relaxed max-w-md">
            A two-voice conversation on any Aston topic — scripted, voiced and scored. Nothing is published from here.
          </p>
        </header>

        {/* Inputs */}
        <div className="panel p-6 space-y-5 rise-in" style={{ animationDelay: "60ms" }}>
          <div className="space-y-2">
            <label className="label-caps">Topic / Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
              placeholder="e.g. Dubai Golden Visa through business ownership"
              className="input-studio"
            />
          </div>
          <div className="space-y-2">
            <label className="label-caps">Notes / source (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Paste any facts, figures or angle you want covered. Leave blank to let it improvise from the topic."
              className="input-studio resize-none"
            />
          </div>
          <div className="space-y-2">
            <label className="label-caps">Length</label>
            <select value={length} onChange={(e) => setLength(Number(e.target.value) as 3 | 15 | 30 | 45 | 60)}
              className="input-studio appearance-none cursor-pointer">
              <option value={3}>3 minutes (test)</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={45}>45 minutes</option>
              <option value={60}>60 minutes</option>
            </select>
          </div>
        </div>

        {status === "idle" && (
          <div className="space-y-3 rise-in" style={{ animationDelay: "120ms" }}>
            <p className="label-caps">Quick topics</p>
            <div className="grid grid-cols-2 gap-2.5">
              {SAMPLE_TOPICS.map((s) => (
                <button key={s.label} onClick={() => setTitle(s.title)} className="option-card group">
                  <p className="text-xs font-medium text-white/65 group-hover:text-gold-bright transition-colors">{s.label}</p>
                  <p className="text-[11px] text-white/28 mt-1 line-clamp-2 leading-relaxed">{s.title}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {status === "generating" && (
          <div className="panel px-6 py-6 space-y-4 rise-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {/* Equalizer pulse */}
                <div className="flex items-end gap-[3px] h-4">
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className="w-[3px] rounded-full bg-gold animate-pulse"
                      style={{ height: `${[60, 100, 45, 80][i]}%`, animationDelay: `${i * 150}ms` }} />
                  ))}
                </div>
                <p className="text-sm text-white/70">{progress}</p>
              </div>
              <p className="text-xs text-gold/70 tabular-nums font-medium">{elapsed}s</p>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.min((elapsed / (length * 6)) * 90, 90)}%` }} />
            </div>
            <p className="text-[11px] text-white/25">Writing the dialogue, voicing both speakers, stitching the music.</p>
          </div>
        )}

        {status === "error" && (
          <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.06] px-5 py-5 space-y-3 rise-in">
            <p className="text-sm text-red-300">{error}</p>
            <button onClick={handleReset} className="btn-quiet !px-3 !py-1.5 text-xs">Try again</button>
          </div>
        )}

        {status === "ready" && audioUrl && (
          <div className="space-y-4 rise-in">
            <div className="panel p-6 space-y-4">
              {episodeTitle && <p className="font-display text-lg text-white/90">{episodeTitle}</p>}
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio src={audioUrl} controls autoPlay className="w-full h-11 rounded-lg" />
              <div className="flex items-center gap-5">
                <a href={audioUrl} download="podcast-test.mp3" className="text-xs font-medium text-gold hover:text-gold-bright transition-colors">Download MP3 ↓</a>
                <button onClick={handleReset} className="text-xs text-white/35 hover:text-white/70 transition-colors">Generate another</button>
              </div>
            </div>
            {turns.length > 0 && (
              <div className="panel px-5 py-5 space-y-2.5 max-h-80 overflow-y-auto">
                <p className="label-caps mb-2">Transcript</p>
                {turns.map((t, i) => (
                  <p key={i} className="text-xs leading-relaxed">
                    <span className={`font-medium ${t.speaker === "host" ? "text-gold/85" : "text-sky-300/75"}`}>{t.speaker === "host" ? "Host" : "Expert"}</span>{" "}
                    <span className="text-white/55">{t.text}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {(status === "idle" || status === "ready" || status === "error") && (
          <button onClick={handleGenerate} disabled={!title.trim()} className="btn-gold w-full">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
            {status === "ready" ? "Generate another" : "Generate podcast"}
          </button>
        )}

      </div>
    </div>
  );
}
