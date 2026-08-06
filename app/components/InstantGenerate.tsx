"use client";

/**
 * InstantGenerate — generate a blog post RIGHT NOW, bypassing the write queue.
 *
 * Sits on the dashboard's Overview tab. Runs the same durable workflow the
 * queue uses (/api/generate-workflow), but interactively: start the run,
 * follow its SSE stream (reconnecting across drops — the run keeps executing
 * server-side), then kick off image generation as a second request once the
 * text post is in WordPress.
 *
 * Supports all four generation modes: topic only, source-assisted (with URL
 * fetch), improve existing (with WP post search), and notes-to-article.
 * Audio / video / podcast for the finished post live on the /media page.
 */

import React, { useState, useEffect, useRef } from "react";

type GenerationMode = "topic_only" | "source_assisted" | "improve_existing" | "notes_to_article";

const MODES: { id: GenerationMode; label: string; description: string; placeholder: string }[] = [
  {
    id: "topic_only",
    label: "Topic only",
    description: "Write from scratch",
    placeholder: "",
  },
  {
    id: "source_assisted",
    label: "Source-assisted",
    description: "Paste a reference article",
    placeholder: "Paste the source article text here. The AI will extract facts and write a fully original Aston article — not a rewrite.",
  },
  {
    id: "improve_existing",
    label: "Improve existing",
    description: "Refresh an Aston post",
    placeholder: "Paste the existing Aston blog post here. The AI will improve structure, SEO, links, and FAQ while preserving the best content.",
  },
  {
    id: "notes_to_article",
    label: "From notes",
    description: "Expand rough notes",
    placeholder: "Paste your notes or bullet points here. The AI will expand them into a full structured article.",
  },
];

interface InstantResult {
  title: string;
  slug: string;
  postId: number;
  editUrl: string;
  previewUrl: string | null;
  wordCount: number;
  readMins: string;
  needsReview?: boolean;
  qa?: { status: string; score: number; warnings: string[] };
}

interface SiteLanguage { code: string; name: string }

type RunStatus = "idle" | "running" | "success" | "error";
type ImageStatus = "idle" | "generating" | "done" | "error";

/** Rotating status lines shown while the pipeline works (~3-5 min). */
const STEPS = [
  "Researching the topic…",
  "Building content strategy…",
  "Writing the article…",
  "Adding internal & authority links…",
  "Running SEO quality checks…",
  "Publishing to WordPress…",
];

export default function InstantGenerate() {
  const [mode, setMode]             = useState<GenerationMode>("topic_only");
  const [topic, setTopic]           = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceUrl, setSourceUrl]   = useState("");
  const [fetchState, setFetchState] = useState<"idle" | "fetching" | "done" | "error">("idle");
  const [fetchError, setFetchError] = useState("");
  const [language, setLanguage]     = useState("");
  const [imageModel, setImageModel] = useState<"imagen-4" | "gpt-image-2">("gpt-image-2");
  const [languages, setLanguages]   = useState<SiteLanguage[]>([]);

  const [status, setStatus]           = useState<RunStatus>("idle");
  const [stepMessage, setStepMessage] = useState("");
  const [error, setError]             = useState("");
  const [result, setResult]           = useState<InstantResult | null>(null);
  const [imageStatus, setImageStatus]   = useState<ImageStatus>("idle");
  const [imageMessage, setImageMessage] = useState("");

  // WP post search (improve_existing mode)
  const [wpQuery, setWpQuery]       = useState("");
  const [wpResults, setWpResults]   = useState<{ id: number; title: string }[]>([]);
  const [wpSearching, setWpSearching] = useState(false);
  const [wpPicked, setWpPicked]     = useState<string | null>(null);

  const stepTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/links/languages")
      .then((r) => r.json())
      .then((d) => { if (d.languages) setLanguages(d.languages); })
      .catch(() => {});
    return () => { if (stepTimer.current) clearInterval(stepTimer.current); };
  }, []);

  const needsSource = mode !== "topic_only";
  const canGenerate =
    topic.trim().length >= 5 && (!needsSource || sourceText.trim().length > 0) && status !== "running";

  const fetchSource = async () => {
    if (!sourceUrl.trim()) return;
    setFetchState("fetching");
    setFetchError("");
    try {
      const res = await fetch("/api/fetch-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFetchState("error");
        setFetchError(data.error ?? "Failed to fetch URL");
      } else {
        setSourceText(data.text);
        setFetchState("done");
      }
    } catch {
      setFetchState("error");
      setFetchError("Network error — could not reach the server");
    }
  };

  const searchWp = async () => {
    if (!wpQuery.trim()) return;
    setWpSearching(true);
    setWpResults([]);
    try {
      const res = await fetch(`/api/fetch-wp-post?search=${encodeURIComponent(wpQuery.trim())}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.posts)) setWpResults(data.posts);
    } catch { /* leave results empty */ }
    setWpSearching(false);
  };

  const pickWpPost = async (post: { id: number; title: string }) => {
    setWpResults([]);
    setWpPicked(post.title);
    if (!topic.trim()) setTopic(post.title);
    try {
      const res = await fetch(`/api/fetch-wp-post?id=${post.id}`);
      const data = await res.json();
      if (res.ok && data.content) setSourceText(data.content);
    } catch { /* user can still paste manually */ }
  };

  /** Kick off image generation after the text post lands in WordPress. */
  const generateImages = async (
    postId: number, fileSlug: string, imgModel: string, imagePrompts: Record<string, string>
  ) => {
    setImageStatus("generating");
    setImageMessage("Generating images…");
    try {
      const res = await fetch("/api/generate-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, fileSlug, imageModel: imgModel, imagePrompts }),
      });
      if (!res.body) throw new Error("No response body from generate-images.");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "progress")    setImageMessage(String(event.message ?? ""));
          else if (event.type === "done")   { setImageStatus("done"); setImageMessage("Images attached ✓"); }
          else if (event.type === "error")  throw new Error(String(event.message));
        }
      }
    } catch (err) {
      setImageStatus("error");
      setImageMessage(err instanceof Error ? err.message : "Image generation failed.");
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setStatus("running");
    setResult(null);
    setError("");
    setImageStatus("idle");
    setImageMessage("");
    let step = 0;
    setStepMessage(STEPS[0]);
    stepTimer.current = setInterval(() => {
      step = Math.min(step + 1, STEPS.length - 1);
      setStepMessage((prev) => (prev.startsWith("QA") || prev.startsWith("Technical") ? prev : STEPS[step]));
    }, 45_000);

    const stopTimer = () => { if (stepTimer.current) { clearInterval(stepTimer.current); stepTimer.current = null; } };

    // Terminal-event dispatcher shared across reconnects.
    const dispatch = (event: Record<string, unknown>): "continue" | "done" => {
      if (event.type === "qa_retry")
        setStepMessage(`QA check didn't pass — rewriting content (attempt ${event.attempt}/${event.max})…`);
      else if (event.type === "tech_retry")
        setStepMessage(`Technical issue — retrying (attempt ${event.attempt}/${event.max})…`);
      else if (event.type === "progress" && typeof event.message === "string" && event.message)
        setStepMessage(event.message);
      else if (event.type === "done") {
        stopTimer();
        const e = event as Record<string, unknown>;
        setResult({
          title:      String(e.title ?? ""),
          slug:       String(e.slug ?? ""),
          postId:     Number(e.postId ?? 0),
          editUrl:    String(e.editUrl ?? ""),
          previewUrl: typeof e.previewUrl === "string" ? e.previewUrl : null,
          wordCount:  Number(e.wordCount ?? 0),
          readMins:   String(e.readMins ?? ""),
          needsReview: Boolean(e.needsReview),
          qa:         e.qa as InstantResult["qa"],
        });
        setStatus("success");
        if (e.imagePrompts && e.postId) {
          generateImages(
            e.postId as number,
            String(e.fileSlug ?? ""),
            String(e.imageModel ?? imageModel),
            e.imagePrompts as Record<string, string>
          );
        }
        return "done";
      } else if (event.type === "error") {
        throw new Error(
          typeof event.message === "string" && event.message ? event.message : "Generation failed. Please try again."
        );
      }
      return "continue";
    };

    try {
      const startRes = await fetch("/api/generate-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic:      topic.trim(),
          mode,
          sourceText: sourceText.trim(),
          language:   language.trim() || undefined,
          imageModel,
        }),
      });
      if (!startRes.ok) {
        let msg = "Generation failed. Please try again.";
        try {
          const parsed = await startRes.json();
          msg = parsed.error || parsed.message || msg;
        } catch { /* keep default */ }
        throw new Error(msg);
      }
      const runId = startRes.headers.get("X-Workflow-Run-Id");
      try { await startRes.body?.cancel(); } catch { /* release kickoff stream */ }
      if (!runId) throw new Error("Could not start generation — no run id returned.");

      // Follow the durable stream. The run executes server-side regardless of
      // this connection, so reconnect on drops and replay-skip handled events.
      // Give up only on prolonged wall-clock silence — the pipeline has
      // legitimate multi-minute quiet stretches.
      const STALL_BUDGET_MS = 25 * 60_000;
      let dispatched = 0;
      let terminal = false;
      let lastProgressAt = Date.now();
      const stalled = () => Date.now() - lastProgressAt > STALL_BUDGET_MS;

      while (!terminal) {
        const streamRes = await fetch(`/api/generate-workflow/${encodeURIComponent(runId)}`).catch(() => null);
        if (!streamRes || !streamRes.ok || !streamRes.body) {
          if (stalled()) throw new Error("Lost connection to the generation run. Check WordPress drafts before retrying.");
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let idx = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            let event: Record<string, unknown>;
            try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }
            if (idx++ < dispatched) continue;
            dispatched++; lastProgressAt = Date.now();
            if (dispatch(event) === "done") { terminal = true; break; }
          }
          if (terminal) break;
        }
        if (terminal) break;
        if (stalled()) throw new Error("The generation run stalled without finishing. Check WordPress drafts, or try again.");
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (err) {
      stopTimer();
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  };

  const reset = () => {
    setStatus("idle");
    setResult(null);
    setError("");
    setTopic("");
    setSourceText("");
    setSourceUrl("");
    setFetchState("idle");
    setWpPicked(null);
    setWpQuery("");
    setImageStatus("idle");
  };

  const activeMode = MODES.find((m) => m.id === mode)!;

  return (
    <div className="panel !rounded-2xl">
      <div className="flex items-start justify-between px-6 py-5 border-b border-white/[0.06]">
        <div>
          <h2 className="font-display text-base text-white/90 flex items-center gap-2">
            <svg className="w-4 h-4 text-gold" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            Instant generate
          </h2>
          <p className="text-xs text-white/40 mt-0.5">Write and publish a post right now — skips the queue entirely</p>
        </div>
        {(status === "success" || status === "error") && (
          <button onClick={reset}
            className="text-xs font-medium text-white/45 hover:text-white/85 transition-colors">
            New post
          </button>
        )}
      </div>

      <div className="p-6 space-y-5">
        {/* Mode cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {MODES.map((m) => (
            <button key={m.id} type="button" disabled={status === "running"}
              onClick={() => { setMode(m.id); setSourceText(""); setFetchState("idle"); setWpPicked(null); }}
              className={`text-left rounded-xl px-3.5 py-3 border transition-all disabled:opacity-50 ${
                mode === m.id
                  ? "bg-gold/10 border-gold/40"
                  : "bg-white/[0.03] border-white/[0.06] hover:border-white/15"
              }`}>
              <p className={`text-[13px] font-semibold ${mode === m.id ? "text-gold" : "text-white/75"}`}>{m.label}</p>
              <p className="text-[10px] text-white/35 mt-0.5">{m.description}</p>
            </button>
          ))}
        </div>

        {/* Topic */}
        <div>
          <label className="label-caps mb-1.5">Blog topic / title</label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} disabled={status === "running"}
            placeholder="e.g. DIFC Foundation setup guide for family offices"
            className="block w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition" />
        </div>

        {/* Source input, per mode */}
        {needsSource && (
          <div className="space-y-2.5">
            {mode === "source_assisted" && (
              <div className="flex gap-2">
                <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} disabled={status === "running"}
                  placeholder="https:// — or paste the article below"
                  className="block flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition" />
                <button type="button" onClick={fetchSource} disabled={!sourceUrl.trim() || fetchState === "fetching" || status === "running"}
                  className="inline-flex items-center justify-center font-medium rounded-lg px-4 py-2.5 text-sm bg-white/[0.05] text-white/75 border border-white/10 hover:bg-white/[0.09] hover:text-white transition-all disabled:opacity-50">
                  {fetchState === "fetching" ? "Fetching…" : "Fetch"}
                </button>
              </div>
            )}
            {mode === "improve_existing" && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input value={wpQuery} onChange={(e) => setWpQuery(e.target.value)} disabled={status === "running"}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchWp(); } }}
                    placeholder="Search aston.ae posts by title…"
                    className="block flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition" />
                  <button type="button" onClick={searchWp} disabled={!wpQuery.trim() || wpSearching || status === "running"}
                    className="inline-flex items-center justify-center font-medium rounded-lg px-4 py-2.5 text-sm bg-white/[0.05] text-white/75 border border-white/10 hover:bg-white/[0.09] hover:text-white transition-all disabled:opacity-50">
                    {wpSearching ? "Searching…" : "Search"}
                  </button>
                </div>
                {wpResults.length > 0 && (
                  <div className="rounded-xl border border-white/[0.08] divide-y divide-white/[0.06] overflow-hidden">
                    {wpResults.slice(0, 6).map((p) => (
                      <button key={p.id} type="button" onClick={() => pickWpPost(p)}
                        className="w-full text-left px-3.5 py-2.5 text-sm text-white/70 hover:bg-white/[0.05] hover:text-white transition-colors">
                        {p.title}
                      </button>
                    ))}
                  </div>
                )}
                {wpPicked && (
                  <p className="text-[11px] text-emerald-400/80">Loaded: {wpPicked}</p>
                )}
              </div>
            )}
            <textarea value={sourceText} onChange={(e) => setSourceText(e.target.value)} disabled={status === "running"}
              placeholder={activeMode.placeholder} rows={5}
              className="block w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition resize-y" />
            {fetchState === "error" && <p className="text-[11px] text-red-300">{fetchError}</p>}
          </div>
        )}

        {/* Language + image model */}
        <div className="flex flex-wrap gap-3">
          <div>
            <label className="label-caps mb-1.5">Language</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={status === "running"}
              className="block rounded-lg border border-white/10 bg-ink-2 px-3 py-2.5 text-sm text-white/85 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition">
              <option value="">Default (English)</option>
              {languages.map((l) => <option key={l.code} value={l.name}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label-caps mb-1.5">Image model</label>
            <select value={imageModel} onChange={(e) => setImageModel(e.target.value as "imagen-4" | "gpt-image-2")} disabled={status === "running"}
              className="block rounded-lg border border-white/10 bg-ink-2 px-3 py-2.5 text-sm text-white/85 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition">
              <option value="gpt-image-2">GPT Image 2</option>
              <option value="imagen-4">Imagen 4</option>
            </select>
          </div>
          <div className="flex-1 min-w-[180px] flex items-end justify-end">
            <button type="button" onClick={handleGenerate} disabled={!canGenerate}
              className="inline-flex items-center justify-center gap-2 font-medium rounded-lg px-5 py-3 text-sm bg-gradient-to-b from-[#dcbd72] to-[#b6923a] text-black hover:brightness-110 shadow-[0_6px_18px_-8px_rgba(201,168,76,0.6)] transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              {status === "running" ? (
                <>
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Generating…
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                  Generate now
                </>
              )}
            </button>
          </div>
        </div>

        {/* Live status */}
        {status === "running" && (
          <div className="flex items-center gap-3 rounded-xl bg-gold/[0.06] border border-gold/20 px-4 py-3">
            <span className="w-2 h-2 rounded-full bg-gold animate-pulse flex-shrink-0" />
            <p className="text-xs text-white/70">{stepMessage}</p>
            <p className="ml-auto text-[10px] text-white/30 flex-shrink-0">Takes 3–5 min — safe to switch tabs</p>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/25 px-4 py-3">
            <p className="text-xs text-red-300">{error}</p>
          </div>
        )}

        {/* Result */}
        {status === "success" && result && (
          <div className="rounded-xl bg-emerald-500/[0.06] border border-emerald-500/25 px-5 py-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white/90">{result.title}</p>
                <p className="text-[11px] text-white/40 mt-1">
                  {result.wordCount.toLocaleString()} words · {result.readMins} min read
                  {result.qa && <> · QA {result.qa.score}/100</>}
                  {result.needsReview && <span className="text-amber-300"> · needs review</span>}
                </p>
              </div>
              <span className="flex-shrink-0 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset bg-emerald-500/10 text-emerald-300 ring-emerald-500/30">
                Published ✓
              </span>
            </div>
            {imageStatus !== "idle" && (
              <p className={`text-[11px] ${imageStatus === "error" ? "text-red-300" : imageStatus === "done" ? "text-emerald-400/80" : "text-white/50"}`}>
                {imageStatus === "generating" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse mr-1.5 align-middle" />}
                {imageMessage}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {result.editUrl && (
                <a href={result.editUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center justify-center font-medium rounded-lg px-3 py-1.5 text-xs bg-white/[0.05] text-white/75 border border-white/10 hover:bg-white/[0.09] hover:text-white transition-all">
                  Edit in WordPress
                </a>
              )}
              {result.previewUrl && (
                <a href={result.previewUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center justify-center font-medium rounded-lg px-3 py-1.5 text-xs bg-white/[0.05] text-white/75 border border-white/10 hover:bg-white/[0.09] hover:text-white transition-all">
                  View post
                </a>
              )}
              <a href={`/media?postId=${result.postId}`}
                className="inline-flex items-center justify-center font-medium rounded-lg px-3 py-1.5 text-xs bg-white/[0.05] text-white/75 border border-white/10 hover:bg-white/[0.09] hover:text-white transition-all">
                Add audio / video / podcast →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
