"use client";

/**
 * /studio — Social Studio.
 * Standalone AI content studio for social, independent of the blog pipeline.
 * First capability: short vertical reel scripts in the Aston presenter's voice,
 * generated before any HeyGen render credits are spent. Generate several
 * variations, read them side by side, and keep the strongest hook.
 */

import React, { useState } from "react";
import StudioNav from "../components/StudioNav";

interface ReelScript {
  hook: string;
  script: string;
  onScreenTitle: string;
  cta: string;
  wordCount: number;
  estimatedSeconds: number;
  topic: string;
}

const card = "rounded-2xl border border-white/[0.07] bg-white/[0.03] backdrop-blur p-5";
const input =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-gold/60";
const btn =
  "rounded-lg bg-gradient-to-b from-[#dcbd72] to-[#b6923a] px-4 py-2 text-sm font-semibold text-black shadow-[0_4px_14px_-4px_rgba(201,168,76,0.6)] disabled:opacity-40 disabled:cursor-not-allowed";
const btnGhost =
  "rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/70 hover:text-white hover:bg-white/[0.08] disabled:opacity-40";
const label = "block text-[11px] uppercase tracking-[0.15em] text-white/40 mb-1.5";

/** A few starting points drawn from Aston's strongest advisory angles. */
const SUGGESTED = [
  "why banks reject newly formed companies",
  "free zone versus mainland — which one actually fits",
  "the structuring mistake that triggers unexpected tax",
  "what the Golden Visa really requires",
  "choosing between DIFC and ADGM",
];

export default function StudioPage() {
  const [topic, setTopic] = useState("");
  const [angle, setAngle] = useState("");
  const [duration, setDuration] = useState(40);
  const [count, setCount] = useState(3);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scripts, setScripts] = useState<ReelScript[]>([]);
  const [copied, setCopied] = useState<number | null>(null);

  async function generate() {
    if (!topic.trim()) return;
    setLoading(true);
    setError("");
    setScripts([]);
    try {
      const res = await fetch("/api/social/reel-script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          angle: angle.trim() || undefined,
          durationSeconds: duration,
          count,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
        return;
      }
      setScripts(data.scripts ?? []);
      if (data.errors?.length) {
        setError(`${data.errors.length} variation(s) failed: ${data.errors[0]}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function copyScript(i: number, s: ReelScript) {
    try {
      await navigator.clipboard.writeText(s.script);
      setCopied(i);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable — non-critical */
    }
  }

  return (
    <>
      <StudioNav />
      <main className="max-w-5xl mx-auto px-6 pb-24 space-y-5">
        <div className="pt-2 pb-1">
          <h1 className="font-display text-2xl font-semibold text-white/95">Social Studio</h1>
          <p className="text-sm text-white/45 mt-1">
            Write short vertical reel scripts in the Aston presenter&apos;s voice. Read a few variations, pick the
            strongest hook, then send it to render.
          </p>
        </div>

        {/* Brief */}
        <section className={card}>
          <h2 className="text-xs uppercase tracking-[0.2em] text-gold/70 mb-4">Reel brief</h2>

          <div className="space-y-4">
            <div>
              <label className={label}>Topic</label>
              <input
                className={input}
                placeholder="e.g. why banks reject newly formed companies"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !loading) generate();
                }}
              />
              <div className="flex flex-wrap gap-1.5 mt-2">
                {SUGGESTED.map((s) => (
                  <button key={s} className={btnGhost} onClick={() => setTopic(s)} disabled={loading}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className={label}>Angle or marketing goal (optional)</label>
              <input
                className={input}
                placeholder="e.g. show that banking must be designed into the structure from day one"
                value={angle}
                onChange={(e) => setAngle(e.target.value)}
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className={label}>Length</label>
                <select
                  className={input}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                >
                  {[20, 30, 40, 60].map((d) => (
                    <option key={d} value={d} className="bg-[#1a1a1a]">
                      {d} seconds
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Variations</label>
                <select className={input} value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((c) => (
                    <option key={c} value={c} className="bg-[#1a1a1a]">
                      {c} {c === 1 ? "script" : "scripts"}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 mt-5">
            <button className={btn} onClick={generate} disabled={loading || !topic.trim()}>
              {loading ? "Writing…" : "Generate scripts"}
            </button>
            {loading && (
              <span className="text-xs text-white/50">
                Writing {count} {count === 1 ? "variation" : "variations"} — around 20&ndash;40 seconds.
              </span>
            )}
            {error && <span className="text-xs text-rose-400">{error}</span>}
          </div>
        </section>

        {/* Results */}
        {scripts.map((s, i) => (
          <section key={i} className={card}>
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xs uppercase tracking-[0.2em] text-gold/70">Variation {i + 1}</h2>
                  <span
                    className={`text-[10px] ${
                      s.estimatedSeconds > duration + 8 ? "text-amber-400" : "text-emerald-400"
                    }`}
                  >
                    {s.wordCount} words · ~{s.estimatedSeconds}s
                  </span>
                </div>
                {s.onScreenTitle && (
                  <p className="text-sm text-white/80 mt-1.5">
                    <span className="text-white/35">On-screen title — </span>
                    {s.onScreenTitle}
                  </p>
                )}
              </div>
              <button className={btnGhost} onClick={() => copyScript(i, s)}>
                {copied === i ? "Copied" : "Copy"}
              </button>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-sm text-white/85 whitespace-pre-line leading-relaxed">{s.script}</p>
            </div>
          </section>
        ))}

        {!loading && scripts.length === 0 && !error && (
          <p className="text-sm text-white/35 px-1">
            Enter a topic above to generate scripts. Nothing is rendered or posted at this stage — this step only
            writes words.
          </p>
        )}
      </main>
    </>
  );
}
