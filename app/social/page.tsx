"use client";

/**
 * /social — standalone QA + demo page for the social cross-posting system.
 * Compose one caption, cross-post to Mastodon + Bluesky, then list and reply to
 * comments from here. Mirrors the project's other standalone test pages (e.g. /podcast).
 */

import React, { useState, useEffect } from "react";
import StudioNav from "../components/StudioNav";

interface AvailableSocialTarget {
  key: "mastodon" | "bluesky";
  label: string;
  description: string;
  connected: boolean;
  connectionState: string;
  charLimit: number;
  supportsComments: boolean;
}

interface SocialPublishResult {
  target: string;
  ok: boolean;
  status: "passed" | "warning" | "failed";
  message: string;
  externalUrl?: string;
  platformPostId?: string;
}

interface SocialComment {
  id: string;
  author: string;
  text: string;
  createdAt?: string;
  url?: string;
}

const card = "rounded-2xl border border-white/[0.07] bg-white/[0.03] backdrop-blur p-5";
const input =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-gold/60";
const btn =
  "rounded-lg bg-gradient-to-b from-[#dcbd72] to-[#b6923a] px-4 py-2 text-sm font-semibold text-black shadow-[0_4px_14px_-4px_rgba(201,168,76,0.6)] disabled:opacity-40 disabled:cursor-not-allowed";
const btnGhost =
  "rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-white/70 hover:text-white hover:bg-white/[0.08] disabled:opacity-40";

function statusColor(s: string) {
  return s === "passed" ? "text-emerald-400" : s === "warning" ? "text-amber-400" : "text-rose-400";
}

export default function SocialPage() {
  const [targets, setTargets] = useState<AvailableSocialTarget[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const [text, setText] = useState("");
  const [link, setLink] = useState("");
  const [mediaUrls, setMediaUrls] = useState("");
  const [altTexts, setAltTexts] = useState("");

  const [publishing, setPublishing] = useState(false);
  const [results, setResults] = useState<SocialPublishResult[]>([]);

  // Auto-caption from a blog post
  const [srcTitle, setSrcTitle] = useState("");
  const [srcSummary, setSrcSummary] = useState("");
  const [srcKeyword, setSrcKeyword] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genMsg, setGenMsg] = useState("");
  const [captions, setCaptions] = useState<Record<string, string>>({});

  // Comments module
  const [cTarget, setCTarget] = useState<"mastodon" | "bluesky">("mastodon");
  const [cPostId, setCPostId] = useState("");
  const [comments, setComments] = useState<SocialComment[]>([]);
  const [cLoading, setCLoading] = useState(false);
  const [cMsg, setCMsg] = useState("");
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [rootReply, setRootReply] = useState("");

  useEffect(() => {
    fetch("/api/social/targets")
      .then((r) => r.json())
      .then((d) => {
        const t: AvailableSocialTarget[] = d.targets ?? [];
        setTargets(t);
        setSelected(Object.fromEntries(t.map((x) => [x.key, x.connected])));
      })
      .catch(() => {});
  }, []);

  async function generate() {
    const chosen = targets.filter((t) => selected[t.key]).map((t) => t.key);
    if (chosen.length === 0) {
      setGenMsg("Select at least one target first.");
      return;
    }
    setGenLoading(true);
    setGenMsg("");
    try {
      const res = await fetch("/api/social/captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: srcTitle,
          summary: srcSummary,
          focusKeyword: srcKeyword.trim() || undefined,
          link: link.trim() || undefined,
          targets: chosen,
        }),
      });
      const data = await res.json();
      if (data.captions) {
        setCaptions(data.captions);
        setGenMsg(`Generated ${Object.keys(data.captions).length} caption(s) — edit below, then cross-post.`);
      } else {
        setGenMsg(data.error || "Caption generation failed.");
      }
    } catch (e) {
      setGenMsg(String(e));
    } finally {
      setGenLoading(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setResults([]);
    try {
      // Per-platform caption override falls back to the shared caption.
      const chosen = targets
        .filter((t) => selected[t.key])
        .map((t) => ({ target: t.key, ...(captions[t.key]?.trim() ? { text: captions[t.key] } : {}) }));
      const res = await fetch("/api/social/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post: {
            // Base caption; per-target overrides above take precedence.
            text: text.trim() || Object.values(captions).find(Boolean) || "",
            link: link.trim() || undefined,
            mediaUrls: mediaUrls.split(",").map((s) => s.trim()).filter(Boolean),
            altTexts: altTexts.split(",").map((s) => s.trim()),
          },
          targets: chosen,
        }),
      });
      const data = await res.json();
      setResults(data.results ?? [{ target: "error", ok: false, status: "failed", message: data.error }]);
      // Prefill the comments module with the first successful post id.
      const firstOk = (data.results ?? []).find((r: SocialPublishResult) => r.ok && r.platformPostId);
      if (firstOk) {
        setCTarget(firstOk.target);
        setCPostId(firstOk.platformPostId);
      }
    } catch (e) {
      setResults([{ target: "error", ok: false, status: "failed", message: String(e) }]);
    } finally {
      setPublishing(false);
    }
  }

  async function listComments() {
    setCLoading(true);
    setCMsg("");
    setComments([]);
    try {
      const res = await fetch("/api/social/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", target: cTarget, postId: cPostId.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setComments(data.comments ?? []);
        if (!data.comments?.length) setCMsg("No comments yet.");
      } else {
        setCMsg(data.message || data.error || "Could not load comments.");
      }
    } catch (e) {
      setCMsg(String(e));
    } finally {
      setCLoading(false);
    }
  }

  async function sendReply(postId: string, body: string, clear: () => void) {
    if (!body.trim()) return;
    setCMsg("");
    try {
      const res = await fetch("/api/social/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reply", target: cTarget, postId, text: body }),
      });
      const data = await res.json();
      if (data.ok) {
        setCMsg(`Reply posted → ${data.externalUrl ?? "done"}`);
        clear();
        listComments();
      } else {
        setCMsg(data.message || data.error || "Reply failed.");
      }
    } catch (e) {
      setCMsg(String(e));
    }
  }

  const anySelected = targets.some((t) => selected[t.key]);
  // Publishable if there's a shared caption, or every selected target has its own.
  const hasCaption =
    !!text.trim() ||
    (anySelected && targets.filter((t) => selected[t.key]).every((t) => captions[t.key]?.trim()));
  const minCharLimit = Math.min(...targets.filter((t) => selected[t.key]).map((t) => t.charLimit), Infinity);

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white">
      <StudioNav />
      <main className="max-w-5xl mx-auto px-6 pb-24 pt-4 space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-white/95">Social cross-posting</h1>
          <p className="text-sm text-white/45 mt-1">
            Phase 1 proof of concept — Mastodon &amp; Bluesky. Compose once, post everywhere, and reply to
            comments from here.
          </p>
        </div>

        {/* Targets */}
        <section className={card}>
          <h2 className="text-xs uppercase tracking-[0.2em] text-gold/70 mb-3">Targets</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {targets.map((t) => (
              <label
                key={t.key}
                className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer transition-colors ${
                  selected[t.key] ? "border-gold/40 bg-gold/[0.04]" : "border-white/10 bg-black/20"
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-[#c9a84c]"
                  checked={!!selected[t.key]}
                  onChange={(e) => setSelected((s) => ({ ...s, [t.key]: e.target.checked }))}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-white/90">{t.label}</span>
                    <span className={`text-[10px] ${t.connected ? "text-emerald-400" : "text-rose-400"}`}>
                      {t.connected ? "connected" : t.connectionState}
                    </span>
                  </div>
                  <p className="text-xs text-white/40 mt-0.5">{t.description}</p>
                  <p className="text-[10px] text-white/30 mt-1">{t.charLimit} char limit</p>
                </div>
              </label>
            ))}
            {targets.length === 0 && (
              <p className="text-sm text-white/40">No targets loaded — are you signed in to the studio?</p>
            )}
          </div>
        </section>

        {/* Auto-caption from a blog post */}
        <section className={card}>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs uppercase tracking-[0.2em] text-gold/70">Auto-write from a post</h2>
            <span className="text-[10px] text-white/30">gpt-5.5 · British English · per-platform</span>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <input className={input} placeholder="Article title" value={srcTitle} onChange={(e) => setSrcTitle(e.target.value)} />
            <input className={input} placeholder="Focus keyword (optional)" value={srcKeyword} onChange={(e) => setSrcKeyword(e.target.value)} />
          </div>
          <textarea
            className={`${input} min-h-[80px] resize-y mt-3`}
            placeholder="Summary / key takeaways of the article…"
            value={srcSummary}
            onChange={(e) => setSrcSummary(e.target.value)}
          />
          <div className="flex items-center gap-3 mt-3">
            <button className={btn} disabled={genLoading || !srcTitle.trim() || !srcSummary.trim() || !anySelected} onClick={generate}>
              {genLoading ? "Writing…" : "Generate captions"}
            </button>
            {genMsg && <span className="text-xs text-white/50">{genMsg}</span>}
          </div>
        </section>

        {/* Composer */}
        <section className={card}>
          <h2 className="text-xs uppercase tracking-[0.2em] text-gold/70 mb-3">Compose</h2>

          {/* Per-platform captions (shown once generated / for selected targets) */}
          {targets.filter((t) => selected[t.key] && captions[t.key] !== undefined).length > 0 && (
            <div className="space-y-3 mb-4">
              {targets
                .filter((t) => selected[t.key] && captions[t.key] !== undefined)
                .map((t) => (
                  <div key={t.key}>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-medium text-white/60 capitalize">{t.label} caption</label>
                      <span className={`text-[10px] ${(captions[t.key]?.length ?? 0) > t.charLimit ? "text-rose-400" : "text-white/30"}`}>
                        {captions[t.key]?.length ?? 0} / {t.charLimit}
                      </span>
                    </div>
                    <textarea
                      className={`${input} min-h-[70px] resize-y`}
                      value={captions[t.key] ?? ""}
                      onChange={(e) => setCaptions((c) => ({ ...c, [t.key]: e.target.value }))}
                    />
                  </div>
                ))}
            </div>
          )}

          <label className="text-[11px] font-medium text-white/50 block mb-1">
            Shared caption <span className="text-white/30">(used for any target without its own caption above)</span>
          </label>
          <textarea
            className={`${input} min-h-[90px] resize-y`}
            placeholder="Write a shared caption…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] text-white/35">
              {anySelected && minCharLimit !== Infinity
                ? `${text.length} / ${minCharLimit} (smallest selected limit${
                    text.length > minCharLimit ? " — will be truncated" : ""
                  })`
                : `${text.length} characters`}
            </span>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <input className={input} placeholder="Link (optional) — https://aston.ae/blog/…" value={link} onChange={(e) => setLink(e.target.value)} />
            <input className={input} placeholder="Image URLs, comma-separated (optional)" value={mediaUrls} onChange={(e) => setMediaUrls(e.target.value)} />
          </div>
          <input className={`${input} mt-3`} placeholder="Alt texts, comma-separated (matches image order)" value={altTexts} onChange={(e) => setAltTexts(e.target.value)} />
          <div className="mt-4">
            <button className={btn} disabled={publishing || !anySelected || !hasCaption} onClick={publish}>
              {publishing ? "Posting…" : "Cross-post"}
            </button>
          </div>

          {results.length > 0 && (
            <div className="mt-4 space-y-2">
              {results.map((r, i) => (
                <div key={i} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium capitalize">{r.target}</span>
                    <span className={`text-xs ${statusColor(r.status)}`}>{r.status}</span>
                  </div>
                  <p className="text-white/60 text-xs mt-0.5">{r.message}</p>
                  {r.externalUrl && (
                    <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" className="text-gold/80 text-xs underline break-all">
                      {r.externalUrl}
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Comments */}
        <section className={card}>
          <h2 className="text-xs uppercase tracking-[0.2em] text-gold/70 mb-3">Comments</h2>
          <div className="grid sm:grid-cols-[160px_1fr_auto] gap-3 items-end">
            <div>
              <label className="text-[11px] text-white/40 block mb-1">Platform</label>
              <select className={input} value={cTarget} onChange={(e) => setCTarget(e.target.value as "mastodon" | "bluesky")}>
                <option value="mastodon">Mastodon</option>
                <option value="bluesky">Bluesky</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-white/40 block mb-1">Post ID</label>
              <input className={input} placeholder="platformPostId from a cross-post above" value={cPostId} onChange={(e) => setCPostId(e.target.value)} />
            </div>
            <button className={btnGhost} disabled={cLoading || !cPostId.trim()} onClick={listComments}>
              {cLoading ? "Loading…" : "List comments"}
            </button>
          </div>

          {cMsg && <p className="text-xs text-white/50 mt-3">{cMsg}</p>}

          <div className="mt-4 space-y-3">
            {comments.map((c) => (
              <div key={c.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white/85">{c.author}</span>
                  {c.createdAt && <span className="text-[10px] text-white/30">{new Date(c.createdAt).toLocaleString()}</span>}
                </div>
                <p className="text-sm text-white/70 mt-1 whitespace-pre-wrap">{c.text}</p>
                <div className="flex gap-2 mt-2">
                  <input
                    className={`${input} text-xs`}
                    placeholder="Reply…"
                    value={replyText[c.id] ?? ""}
                    onChange={(e) => setReplyText((s) => ({ ...s, [c.id]: e.target.value }))}
                  />
                  <button
                    className={btnGhost}
                    onClick={() => sendReply(c.id, replyText[c.id] ?? "", () => setReplyText((s) => ({ ...s, [c.id]: "" })))}
                  >
                    Reply
                  </button>
                </div>
              </div>
            ))}
          </div>

          {cPostId.trim() && (
            <div className="mt-4 border-t border-white/10 pt-4">
              <label className="text-[11px] text-white/40 block mb-1">Reply directly to the post</label>
              <div className="flex gap-2">
                <input className={input} placeholder="Write a top-level reply to your own post…" value={rootReply} onChange={(e) => setRootReply(e.target.value)} />
                <button className={btnGhost} onClick={() => sendReply(cPostId.trim(), rootReply, () => setRootReply(""))}>
                  Reply
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
