"use client";

import { useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

interface GenerateResult {
  title: string;
  slug: string;
  focusKeyword: string;
  seoTitle: string;
  readMins: string;
  linksUsed: {
    internal: Array<{ anchor: string; url: string }>;
    external: Array<{ anchor: string; url: string }>;
  };
  editUrl: string;
  previewUrl: string;
}

const STEPS = [
  "Planning article structure and blueprint...",
  "Writing blog content from blueprint...",
  "Generating content-aware image prompts...",
  "Generating images with DALL·E 3...",
  "Uploading images and publishing draft...",
];

const SUGGESTIONS = [
  "How to set up a free zone company in Dubai",
  "Dubai mainland vs free zone: which is right for you?",
  "Opening a business bank account in the UAE",
  "Best free zones in Dubai for tech startups",
  "Offshore company formation in British Virgin Islands",
  "Dubai Golden Visa through business investment",
  "DIFC vs ADGM: which financial free zone suits your business",
  "Step-by-step guide to getting a UAE trade licence",
];

export default function HomePage() {
  const [topic, setTopic] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [stepIndex, setStepIndex] = useState(0);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState("");

  const startStepCycle = () => {
    setStepIndex(0);
    let i = 0;
    const interval = setInterval(() => {
      i++;
      if (i < STEPS.length) setStepIndex(i);
      else clearInterval(interval);
    }, 12000);
    return interval;
  };

  const handleGenerate = async () => {
    if (!topic.trim() || status === "loading") return;
    setStatus("loading");
    setResult(null);
    setError("");
    const interval = startStepCycle();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          secret: process.env.NEXT_PUBLIC_API_SECRET,
        }),
      });

      const data = await res.json();
      clearInterval(interval);

      if (!res.ok || !data.success) {
        throw new Error(data.error || "Generation failed. Please try again.");
      }

      setResult(data);
      setStatus("success");
    } catch (err: unknown) {
      clearInterval(interval);
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setResult(null);
    setError("");
    setTopic("");
    setStepIndex(0);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans">
      <div
        className="fixed inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />
      <div className="fixed top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#C9A84C] to-transparent" />

      <div className="relative z-10 max-w-2xl mx-auto px-6 py-16">
        <header className="mb-14">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-8 h-8 rounded-sm bg-[#C9A84C] flex items-center justify-center">
              <span className="text-black font-bold text-sm tracking-tight">A</span>
            </div>
            <span className="text-sm text-white/40 tracking-[0.2em] uppercase">Aston.ae</span>
          </div>
          <h1 className="text-4xl font-light tracking-tight text-white mb-3">
            Blog <span className="text-[#C9A84C]">Generator</span>
          </h1>
          <p className="text-white/40 text-sm leading-relaxed">
            Enter a topic. We write the full post, generate images, and publish a draft to WordPress — ready for your review.
          </p>
        </header>

        <main>
          {(status === "idle" || status === "error") && (
            <div className="space-y-6">
              <div>
                <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">Blog Topic</label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. How to set up a free zone company in Dubai"
                  rows={3}
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] resize-none transition-all duration-200"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
                />
                <p className="text-white/20 text-xs mt-2">Press ⌘ + Enter to generate</p>
              </div>

              {status === "error" && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={!topic.trim()}
                className="w-full bg-[#C9A84C] hover:bg-[#D4B86A] disabled:opacity-30 disabled:cursor-not-allowed text-black font-medium text-sm tracking-wide py-3.5 rounded-lg transition-all duration-200"
              >
                Generate Post
              </button>

              <div>
                <p className="text-xs text-white/25 tracking-[0.15em] uppercase mb-3">Suggestions</p>
                <div className="space-y-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setTopic(s)}
                      className="w-full text-left text-sm text-white/35 hover:text-white/70 py-2 px-3 rounded-md hover:bg-white/[0.04] transition-all duration-150 border border-transparent hover:border-white/[0.08]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {status === "loading" && (
            <div className="py-12 space-y-10">
              <div className="flex justify-center">
                <div className="relative w-16 h-16">
                  <div className="absolute inset-0 rounded-full border border-white/5" />
                  <div className="absolute inset-0 rounded-full border-t border-[#C9A84C] animate-spin" />
                  <div className="absolute inset-3 rounded-full bg-[#C9A84C]/10" />
                </div>
              </div>
              <div className="space-y-3">
                {STEPS.map((step, i) => (
                  <div key={step} className={`flex items-center gap-3 transition-all duration-500 ${i < stepIndex ? "opacity-30" : i === stepIndex ? "opacity-100" : "opacity-20"}`}>
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors duration-300 ${i < stepIndex ? "bg-[#C9A84C]/40" : i === stepIndex ? "bg-[#C9A84C] animate-pulse" : "bg-white/20"}`} />
                    <p className={`text-sm ${i === stepIndex ? "text-white" : "text-white/50"}`}>{step}</p>
                  </div>
                ))}
              </div>
              <p className="text-center text-white/20 text-xs">This takes about 2–3 minutes</p>
            </div>
          )}

          {status === "success" && result && (
            <div className="space-y-6">
              <div className="flex items-center gap-3 py-4 border-b border-white/[0.06]">
                <div className="w-6 h-6 rounded-full bg-[#C9A84C]/20 border border-[#C9A84C]/40 flex items-center justify-center">
                  <svg className="w-3 h-3 text-[#C9A84C]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <span className="text-sm text-white/60">Draft published to WordPress</span>
              </div>

              <div className="bg-white/[0.03] border border-white/[0.07] rounded-xl p-5 space-y-4">
                <div>
                  <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-1.5">Title</p>
                  <p className="text-white font-medium leading-snug">{result.title}</p>
                </div>
                <div>
                  <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-1.5">SEO title</p>
                  <p className="text-white/60 text-sm">{result.seoTitle}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-1.5">Focus keyword</p>
                    <p className="text-white/60 text-sm">{result.focusKeyword}</p>
                  </div>
                  <div>
                    <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-1.5">Slug</p>
                    <p className="text-white/60 text-sm font-mono text-xs">{result.slug}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-1.5">Read time</p>
                    <p className="text-white/60 text-sm">{result.readMins} min</p>
                  </div>
                  <div>
                    <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-1.5">Links placed</p>
                    <p className="text-white/60 text-sm">
                      {result.linksUsed.internal.length} internal
                      {result.linksUsed.external.length > 0 && `, ${result.linksUsed.external.length} external`}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <a href={result.editUrl} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 bg-[#C9A84C] hover:bg-[#D4B86A] text-black font-medium text-sm py-3 rounded-lg transition-colors duration-200">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Edit in WordPress
                </a>
                <a href={result.previewUrl} target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 bg-white/[0.05] hover:bg-white/[0.08] border border-white/10 text-white/70 hover:text-white text-sm py-3 rounded-lg transition-all duration-200">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                  Preview Draft
                </a>
              </div>

              <button onClick={handleReset} className="w-full text-sm text-white/30 hover:text-white/60 py-2 transition-colors duration-150">
                ← Generate another post
              </button>
            </div>
          )}
        </main>

        <footer className="mt-20 pt-6 border-t border-white/[0.05]">
          <p className="text-white/15 text-xs text-center">
            Aston.ae internal tool · Posts are saved as drafts for review
          </p>
        </footer>
      </div>
    </div>
  );
}
