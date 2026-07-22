"use client";

/**
 * /studio — Social Studio.
 * Standalone AI content studio for social, independent of the blog pipeline.
 * First capability: short vertical reel scripts in the Aston presenter's voice,
 * generated before any HeyGen render credits are spent. Generate several
 * variations, read them side by side, and keep the strongest hook.
 */

import React, { useState, useEffect } from "react";
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

interface ReelRenderJob {
  id: string;
  status: "processing" | "completed" | "failed";
  title: string;
  videoUrl?: string;
  thumbnailUrl?: string;
  durationSecs?: number;
  captioned?: boolean;
  error?: string;
  createdAt: string;
}

/** How long a job has been rendering, in whole seconds. */
function elapsed(job: ReelRenderJob): number {
  return Math.max(0, Math.round((Date.now() - new Date(job.createdAt).getTime()) / 1000));
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
  const [captions, setCaptions] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scripts, setScripts] = useState<ReelScript[]>([]);
  const [copied, setCopied] = useState<number | null>(null);

  // Render state, keyed by script variation index.
  const [jobs, setJobs] = useState<Record<number, ReelRenderJob>>({});
  const [starting, setStarting] = useState<Record<number, boolean>>({});
  const [library, setLibrary] = useState<ReelRenderJob[]>([]);

  // Post captions (the feed text + hashtags, separate from the on-screen/spoken
  // captions), keyed by script variation index → { platform: caption }.
  const [postCaptions, setPostCaptions] = useState<Record<number, Record<string, string>>>({});
  const [captionLoading, setCaptionLoading] = useState<Record<number, boolean>>({});

  // Posting the finished reel. Keyed "index:platform" for the busy flag; results
  // keyed by script index.
  const [posting, setPosting] = useState<Record<string, boolean>>({});
  const [postResults, setPostResults] = useState<
    Record<number, Array<{ target: string; ok: boolean; status: string; message: string; externalUrl?: string }>>
  >({});

  function loadLibrary() {
    fetch("/api/social/reel-render")
      .then((r) => r.json())
      .then((d) => setLibrary(d.jobs ?? []))
      .catch(() => {});
  }

  useEffect(() => {
    loadLibrary();
  }, []);

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

  // ── Rendering ────────────────────────────────────────────────
  // Each render costs HeyGen credits, so it only ever runs on an explicit click.
  // The POST returns once HeyGen accepts the job; the render then takes 3–8
  // minutes, so we poll until it reaches a terminal state.

  function pollJob(index: number, id: string) {
    const tick = async () => {
      try {
        const res = await fetch(`/api/social/reel-render?id=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (!data.job) return;
        setJobs((j) => ({ ...j, [index]: data.job }));
        if (data.job.status === "processing") {
          setTimeout(tick, 15000);
        } else {
          loadLibrary();
        }
      } catch {
        setTimeout(tick, 20000); // transient network error — keep watching
      }
    };
    setTimeout(tick, 15000);
  }

  async function renderReel(index: number, s: ReelScript) {
    setStarting((v) => ({ ...v, [index]: true }));
    setError("");
    try {
      const res = await fetch("/api/social/reel-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: s.script, title: s.onScreenTitle || s.topic, captions }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Render failed to start (${res.status})`);
        return;
      }
      setJobs((j) => ({ ...j, [index]: data.job }));
      pollJob(index, data.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting((v) => ({ ...v, [index]: false }));
    }
  }

  // Reel-capable platforms — the feed caption is written for each of these.
  const CAPTION_PLATFORMS = ["tiktok", "instagram", "youtube", "facebook", "linkedin"];
  const PLATFORM_LABEL: Record<string, string> = {
    tiktok: "TikTok",
    instagram: "Instagram",
    youtube: "YouTube",
    facebook: "Facebook",
    linkedin: "LinkedIn",
  };

  async function generatePostCaptions(index: number, s: ReelScript) {
    setCaptionLoading((v) => ({ ...v, [index]: true }));
    setError("");
    try {
      const res = await fetch("/api/social/captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: s.onScreenTitle || s.topic,
          summary: s.script,
          focusKeyword: s.topic,
          targets: CAPTION_PLATFORMS,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Caption generation failed (${res.status})`);
        return;
      }
      setPostCaptions((c) => ({ ...c, [index]: data.captions ?? {} }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCaptionLoading((v) => ({ ...v, [index]: false }));
    }
  }

  // Platforms that can take a reel video today (video-native). Instagram,
  // Facebook and LinkedIn need video-upload paths added to their connectors first.
  const POST_TARGETS = ["tiktok", "youtube"];

  async function postReel(index: number, platform: string) {
    const job = jobs[index];
    if (!job?.videoUrl) return;
    const caption = postCaptions[index]?.[platform] || job.title || scripts[index].onScreenTitle || scripts[index].topic;

    setPosting((v) => ({ ...v, [`${index}:${platform}`]: true }));
    setError("");
    try {
      const res = await fetch("/api/social/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post: { text: caption, mediaUrls: [job.videoUrl] },
          targets: [{ target: platform, text: caption }],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Post failed (${res.status})`);
        return;
      }
      const result = (data.results ?? [])[0];
      if (result) {
        setPostResults((r) => ({
          ...r,
          [index]: [...(r[index] ?? []).filter((x) => x.target !== platform), result],
        }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting((v) => ({ ...v, [`${index}:${platform}`]: false }));
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable — non-critical */
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

            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                className="accent-[#c9a84c]"
                checked={captions}
                onChange={(e) => setCaptions(e.target.checked)}
              />
              <span className="text-sm text-white/75">
                Burn word-synced captions onto the reel
                <span className="text-white/35"> — recommended, reels are watched on mute</span>
              </span>
            </label>
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
              <div className="flex items-center gap-2 shrink-0">
                <button className={btnGhost} onClick={() => copyScript(i, s)}>
                  {copied === i ? "Copied" : "Copy"}
                </button>
                <button
                  className={btn}
                  onClick={() => renderReel(i, s)}
                  disabled={starting[i] || jobs[i]?.status === "processing"}
                >
                  {starting[i]
                    ? "Starting…"
                    : jobs[i]?.status === "processing"
                      ? "Rendering…"
                      : jobs[i]?.status === "completed"
                        ? "Render again"
                        : "Render reel"}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/25 p-4">
              <p className="text-sm text-white/85 whitespace-pre-line leading-relaxed">{s.script}</p>
            </div>

            {/* Post caption + hashtags — the feed text, separate from the spoken/on-screen words */}
            <div className="mt-4">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[11px] uppercase tracking-[0.15em] text-white/40">Post caption &amp; hashtags</span>
                <button className={btnGhost} onClick={() => generatePostCaptions(i, s)} disabled={captionLoading[i]}>
                  {captionLoading[i]
                    ? "Writing…"
                    : postCaptions[i]
                      ? "Regenerate"
                      : "Generate post caption"}
                </button>
              </div>

              {postCaptions[i] && (
                <div className="space-y-2">
                  {CAPTION_PLATFORMS.filter((p) => postCaptions[i][p]).map((p) => (
                    <div key={p} className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-medium text-gold/70">{PLATFORM_LABEL[p]}</span>
                        <button className={btnGhost} onClick={() => copyText(postCaptions[i][p])}>
                          Copy
                        </button>
                      </div>
                      <textarea
                        value={postCaptions[i][p]}
                        onChange={(e) =>
                          setPostCaptions((c) => ({ ...c, [i]: { ...c[i], [p]: e.target.value } }))
                        }
                        className="w-full bg-transparent text-sm text-white/85 focus:outline-none resize-y min-h-[64px] leading-relaxed"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Render output */}
            {jobs[i] && (
              <div className="mt-4">
                {jobs[i].status === "processing" && (
                  <div className="rounded-xl border border-gold/25 bg-gold/[0.04] px-4 py-3">
                    <p className="text-sm text-white/80">
                      Rendering the avatar video — this normally takes 3&ndash;8 minutes.
                    </p>
                    <p className="text-[11px] text-white/40 mt-1">
                      {elapsed(jobs[i])}s elapsed · you can leave this page, it keeps rendering.
                    </p>
                  </div>
                )}

                {jobs[i].status === "failed" && (
                  <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-4 py-3">
                    <p className="text-sm text-rose-300">Render failed — {jobs[i].error}</p>
                  </div>
                )}

                {jobs[i].status === "completed" && jobs[i].videoUrl && (
                  <div className="flex items-start gap-4 flex-wrap">
                    <video
                      src={jobs[i].videoUrl}
                      controls
                      playsInline
                      className="rounded-xl border border-white/10 bg-black w-[240px] aspect-[9/16] object-cover"
                    />
                    <div className="text-xs text-white/50 space-y-1.5 pt-1">
                      <p className="text-emerald-400">Reel ready</p>
                      {jobs[i].durationSecs ? <p>{Math.round(jobs[i].durationSecs!)}s · 1080×1920</p> : null}
                      <p className={jobs[i].captioned ? "text-white/50" : "text-amber-400"}>
                        {jobs[i].captioned ? "Captions burned in" : "No captions"}
                      </p>
                      <a
                        href={jobs[i].videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block text-gold/80 hover:text-gold underline underline-offset-2"
                      >
                        Open / download
                      </a>
                    </div>
                  </div>
                )}

                {/* Share the finished reel — video-native platforms only for now */}
                {jobs[i].status === "completed" && jobs[i].videoUrl && (
                  <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] uppercase tracking-[0.15em] text-white/40 mr-1">Share reel</span>
                      {POST_TARGETS.map((p) => (
                        <button
                          key={p}
                          className={btnGhost}
                          onClick={() => postReel(i, p)}
                          disabled={posting[`${i}:${p}`]}
                        >
                          {posting[`${i}:${p}`] ? "Posting…" : `Post to ${PLATFORM_LABEL[p]}`}
                        </button>
                      ))}
                      {!postCaptions[i] && (
                        <span className="text-[10px] text-white/30">
                          Tip: generate the post caption first so it goes out with hashtags.
                        </span>
                      )}
                    </div>

                    {(postResults[i] ?? []).map((r) => (
                      <p
                        key={r.target}
                        className={`text-[11px] mt-2 ${r.ok ? "text-emerald-400" : "text-rose-400"}`}
                      >
                        {PLATFORM_LABEL[r.target] ?? r.target}: {r.message}
                        {r.externalUrl && (
                          <>
                            {" "}
                            <a
                              href={r.externalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-gold/80 hover:text-gold underline underline-offset-2"
                            >
                              view
                            </a>
                          </>
                        )}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        ))}

        {/* Reel library */}
        {library.length > 0 && (
          <section className={card}>
            <h2 className="text-xs uppercase tracking-[0.2em] text-gold/70 mb-3">Recent reels</h2>
            <div className="space-y-2">
              {library.map((j) => (
                <div
                  key={j.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-white/85 truncate">{j.title}</p>
                    <p className="text-[10px] text-white/35 mt-0.5">
                      {new Date(j.createdAt).toLocaleString("en-GB")}
                      {j.durationSecs ? ` · ${Math.round(j.durationSecs)}s` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className={`text-[10px] ${
                        j.status === "completed"
                          ? "text-emerald-400"
                          : j.status === "failed"
                            ? "text-rose-400"
                            : "text-amber-400"
                      }`}
                    >
                      {j.status}
                    </span>
                    {j.videoUrl && (
                      <a
                        href={j.videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={btnGhost}
                      >
                        Open
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

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
