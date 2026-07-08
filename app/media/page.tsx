"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import StudioNav from "../components/StudioNav";

type MediaKey = "audio" | "video" | "podcast";
type OutputState = "idle" | "running" | "done" | "error";

interface PostInfo {
  id: number;
  title: string;
  focusKeyword: string;
  language: string;
  blogUrl: string;
}

const MEDIA: { key: MediaKey; label: string; desc: string; icon: string }[] = [
  { key: "audio",   label: "Read-aloud audio", desc: "Kokoro narration MP3, added to the post's audio player", icon: "🔊" },
  { key: "video",   label: "YouTube video",    desc: "Narrated scene-by-scene video, rendered and uploaded to YouTube", icon: "🎬" },
  { key: "podcast", label: "Podcast episode",  desc: "Two-voice conversation, published to the podcast feed", icon: "🎙️" },
];

function MediaWorkspace() {
  const params = useSearchParams();
  const initialPostId = params.get("postId") ?? "";
  const initialTitle = params.get("title") ?? "";

  const [postIdInput, setPostIdInput] = useState(initialPostId);
  const [post, setPost] = useState<PostInfo | null>(null);
  const [existing, setExisting] = useState<Record<MediaKey, boolean>>({ audio: false, video: false, podcast: false });
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<Record<MediaKey, boolean>>({ audio: false, video: false, podcast: false });
  const [podcastLength, setPodcastLength] = useState(30);

  const [running, setRunning] = useState(false);
  const [outState, setOutState] = useState<Record<MediaKey, OutputState>>({ audio: "idle", video: "idle", podcast: "idle" });
  const [outMsg, setOutMsg] = useState<Record<MediaKey, string>>({ audio: "", video: "", podcast: "" });
  const [outUrl, setOutUrl] = useState<Record<MediaKey, string>>({ audio: "", video: "", podcast: "" });

  const loadPost = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setLoading(true); setLoadError(""); setPost(null);
    try {
      const res = await fetch(`/api/post-media?id=${encodeURIComponent(id.trim())}`);
      const data = await res.json();
      if (!res.ok) { setLoadError(data.error ?? "Could not load post"); return; }
      setPost(data.post);
      setExisting(data.existing);
      // Pre-select the media the post does NOT already have.
      setSelected({ audio: !data.existing.audio, video: !data.existing.video, podcast: !data.existing.podcast });
    } catch {
      setLoadError("Network error loading the post");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load when arriving with ?postId=
  useEffect(() => { if (initialPostId) loadPost(initialPostId); }, [initialPostId, loadPost]);

  const anySelected = selected.audio || selected.video || selected.podcast;

  const generate = async () => {
    if (!post || !anySelected || running) return;
    setRunning(true);
    const initial: Record<MediaKey, OutputState> = { audio: "idle", video: "idle", podcast: "idle" };
    (Object.keys(selected) as MediaKey[]).forEach((k) => { if (selected[k]) initial[k] = "running"; });
    setOutState(initial);
    setOutMsg({ audio: "", video: "", podcast: "" });
    setOutUrl({ audio: "", video: "", podcast: "" });

    try {
      const startRes = await fetch("/api/post-media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: post.id, outputs: selected, podcastLength }),
      });
      if (!startRes.ok) {
        const e = await startRes.json().catch(() => ({}));
        throw new Error(e.error ?? "Could not start media generation");
      }
      const { runId } = await startRes.json();
      if (!runId) throw new Error("No run id returned");

      // Follow the durable run stream (reconnect until the terminal event).
      let dispatched = 0, terminal = false, emptyReconnects = 0;
      while (!terminal) {
        const stream = await fetch(`/api/post-media/${encodeURIComponent(runId)}`).catch(() => null);
        if (!stream || !stream.ok || !stream.body) {
          if (++emptyReconnects > 8) throw new Error("Lost connection to the media run");
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        const reader = stream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", idx = 0, newThisConn = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let ev: Record<string, unknown>;
            try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (idx++ < dispatched) continue;
            dispatched++; newThisConn++;
            const out = ev.output as MediaKey | undefined;
            if (ev.type === "progress" && out) setOutMsg((m) => ({ ...m, [out]: String(ev.message ?? "") }));
            else if (ev.type === "media_done" && out) {
              setOutState((s) => ({ ...s, [out]: "done" }));
              setOutUrl((u) => ({ ...u, [out]: String(ev.url ?? "") }));
            } else if (ev.type === "media_failed" && out) {
              setOutState((s) => ({ ...s, [out]: "error" }));
              setOutMsg((m) => ({ ...m, [out]: String(ev.message ?? "failed") }));
            } else if (ev.type === "done") { terminal = true; break; }
          }
          if (terminal) break;
        }
        if (terminal) break;
        emptyReconnects = newThisConn > 0 ? 0 : emptyReconnects + 1;
        if (emptyReconnects > 8) throw new Error("The media run stalled");
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      // Mark any still-running output as errored.
      setOutState((s) => {
        const n = { ...s };
        (Object.keys(n) as MediaKey[]).forEach((k) => { if (n[k] === "running") n[k] = "error"; });
        return n;
      });
      setOutMsg((m) => ({ ...m, audio: m.audio || (err instanceof Error ? err.message : "error") }));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="relative z-10 max-w-2xl mx-auto px-6 py-12 space-y-8">
      <header className="rise-in">
        <p className="label-caps mb-2.5">Media · already-published posts</p>
        <h1 className="font-display text-4xl text-white/95 tracking-tight">
          Add <span className="text-gold">media</span>
        </h1>
        <p className="text-sm text-white/40 mt-3 leading-relaxed max-w-lg">
          Generate audio, video or a podcast for a post that&apos;s already live — for example if you only picked a YouTube video when scheduling it, add the rest here.
        </p>
      </header>

      {/* Post picker (shown when no post loaded via query) */}
      {!post && (
        <div className="panel p-6 space-y-3 rise-in">
          <label className="label-caps">WordPress post ID</label>
          <div className="flex gap-2">
            <input
              value={postIdInput}
              onChange={(e) => setPostIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && loadPost(postIdInput)}
              placeholder="e.g. 4213"
              className="input-studio"
            />
            <button onClick={() => loadPost(postIdInput)} disabled={loading || !postIdInput.trim()} className="btn-gold shrink-0 !py-2.5">
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
          {initialTitle && <p className="text-xs text-white/35">Post: {initialTitle}</p>}
          {loadError && <p className="text-xs text-red-300">{loadError}</p>}
          <p className="text-[11px] text-white/30">Tip: open a completed post from the Scheduler&apos;s Gen Queue and click “Add media” — it links straight here.</p>
        </div>
      )}

      {post && (
        <>
          <div className="panel p-5 rise-in flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="label-caps mb-1">Post</p>
              <p className="font-display text-lg text-white/90 leading-snug truncate">{post.title || `Post #${post.id}`}</p>
              <p className="text-xs text-white/35 mt-0.5">ID {post.id}{post.focusKeyword ? ` · ${post.focusKeyword}` : ""}</p>
            </div>
            <button onClick={() => { setPost(null); setLoadError(""); }} className="text-xs text-white/35 hover:text-white/70 shrink-0">Change</button>
          </div>

          {/* Media cards */}
          <div className="space-y-3 rise-in">
            {MEDIA.map((m) => {
              const st = outState[m.key];
              const on = selected[m.key];
              return (
                <div key={m.key} className="panel p-5">
                  <div className="flex items-start gap-3">
                    <label className="flex items-center gap-3 cursor-pointer select-none flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={running}
                        onChange={() => setSelected((s) => ({ ...s, [m.key]: !s[m.key] }))}
                        className="w-4 h-4 accent-gold shrink-0"
                      />
                      <span className="text-xl leading-none shrink-0">{m.icon}</span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white/85">{m.label}</span>
                          {existing[m.key] && st === "idle" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-300 border border-emerald-500/25">already exists</span>
                          )}
                        </span>
                        <span className="block text-xs text-white/35 mt-0.5">{m.desc}</span>
                      </span>
                    </label>
                    <div className="shrink-0 pt-0.5">
                      {st === "running" && <span className="text-xs text-amber-300 inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />working</span>}
                      {st === "done" && <span className="text-xs text-emerald-300">✓ done</span>}
                      {st === "error" && <span className="text-xs text-red-300">✕ failed</span>}
                    </div>
                  </div>

                  {m.key === "podcast" && on && st === "idle" && (
                    <div className="mt-3 pl-10">
                      <select value={podcastLength} onChange={(e) => setPodcastLength(Number(e.target.value))} disabled={running}
                        className="input-studio !py-2 !w-40 text-xs cursor-pointer">
                        {[3, 15, 30, 45, 60].map((n) => <option key={n} value={n}>{n === 3 ? "3 min (test)" : `${n} min`}</option>)}
                      </select>
                    </div>
                  )}

                  {(st === "running" || st === "error") && outMsg[m.key] && (
                    <div className="mt-3 pl-10">
                      <p className={`text-xs ${st === "error" ? "text-red-300" : "text-white/55"}`}>{outMsg[m.key]}</p>
                      {st === "running" && <div className="progress-track mt-2"><div className="progress-fill" style={{ width: "60%" }} /></div>}
                    </div>
                  )}
                  {st === "done" && outUrl[m.key] && (
                    <div className="mt-3 pl-10">
                      <a href={outUrl[m.key]} target="_blank" rel="noopener noreferrer" className="text-xs text-gold hover:text-gold-bright underline">Open result ↗</a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!running ? (
            <button onClick={generate} disabled={!anySelected} className="btn-gold w-full">
              Generate selected media
            </button>
          ) : (
            <div className="panel p-4 text-center rise-in">
              <p className="text-sm text-white/70">Generating… you can leave this page — it keeps running.</p>
              <p className="text-xs text-white/35 mt-1">Video renders can take several minutes.</p>
            </div>
          )}

          {!running && (outState.audio === "done" || outState.video === "done" || outState.podcast === "done") && (
            <p className="text-center text-sm text-emerald-300 rise-in">Done. Media has been attached to the post.</p>
          )}
        </>
      )}
    </div>
  );
}

export default function MediaPage() {
  return (
    <div className="min-h-screen text-white">
      <div className="studio-bg" />
      <StudioNav />
      <Suspense fallback={<div className="relative z-10 max-w-2xl mx-auto px-6 py-12 text-white/40 text-sm">Loading…</div>}>
        <MediaWorkspace />
      </Suspense>
    </div>
  );
}
