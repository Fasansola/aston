"use client";

import { useState } from "react";

type Status = "idle" | "loading" | "success" | "error";
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

interface GenerateResult {
  title: string;
  slug: string;
  focusKeyword: string;
  seoTitle: string;
  readMins: string;
  wordCount: number;
  strategy?: {
    searchIntentType: string;
    primaryKeyword: string;
    articleAngle: string;
  };
  qa: {
    status: "pass" | "warn" | "fail";
    score: number;
    warnings: string[];
  };
  linksUsed: {
    internal: Array<{ anchor: string; url: string }>;
    external: Array<{ anchor: string; url: string }>;
  };
  editUrl: string;
  previewUrl: string;
}

const STEPS = [
  "Running 12-step strategy analysis...",
  "Planning article structure and blueprint...",
  "Writing blog content from blueprint...",
  "Generating content-aware image prompts...",
  "Generating images with Imagen 3...",
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
  const [topic, setTopic]           = useState("");
  const [mode, setMode]             = useState<GenerationMode>("topic_only");
  const [sourceText, setSourceText] = useState("");
  const [status, setStatus]         = useState<Status>("idle");
  const [stepIndex, setStepIndex]   = useState(0);
  const [result, setResult]         = useState<GenerateResult | null>(null);
  const [error, setError]           = useState("");

  // Strategy inputs
  const [showStrategy, setShowStrategy]             = useState(false);
  const [audience, setAudience]                     = useState("");
  const [primaryCountry, setPrimaryCountry]         = useState("");
  const [secondaryCountries, setSecondaryCountries] = useState("");
  const [priorityService, setPriorityService]       = useState("");
  const [language, setLanguage]                     = useState("");

  const startStepCycle = () => {
    setStepIndex(0);
    let i = 0;
    const interval = setInterval(() => {
      i++;
      if (i < STEPS.length) setStepIndex(i);
      else clearInterval(interval);
    }, 25000);
    return interval;
  };

  const selectedMode = MODES.find((m) => m.id === mode)!;
  const needsSource  = mode !== "topic_only";
  const canGenerate  = !!topic.trim() && (!needsSource || !!sourceText.trim());

  const handleGenerate = async () => {
    if (!canGenerate || status === "loading") return;
    setStatus("loading");
    setResult(null);
    setError("");
    const interval = startStepCycle();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic:               topic.trim(),
          secret:              process.env.NEXT_PUBLIC_API_SECRET,
          mode,
          sourceText:          sourceText.trim(),
          audience:            audience.trim() || undefined,
          primary_country:     primaryCountry.trim() || undefined,
          secondary_countries: secondaryCountries.trim() || undefined,
          priority_service:    priorityService.trim() || undefined,
          language:            language.trim() || undefined,
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
    setSourceText("");
    setMode("topic_only");
    setStepIndex(0);
    setAudience("");
    setPrimaryCountry("");
    setSecondaryCountries("");
    setPriorityService("");
    setLanguage("");
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
            Enter a topic. We run a full strategy analysis, write the post, generate images, and publish a draft to WordPress — ready for your review.
          </p>
        </header>

        <main>
          {(status === "idle" || status === "error") && (
            <div className="space-y-6">

              {/* Mode selector */}
              <div>
                <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">Generation mode</label>
                <div className="grid grid-cols-2 gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setMode(m.id)}
                      className={`text-left px-3 py-2.5 rounded-lg border transition-all duration-150 ${
                        mode === m.id
                          ? "border-[#C9A84C]/60 bg-[#C9A84C]/10"
                          : "border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05]"
                      }`}
                    >
                      <p className={`text-xs font-medium ${mode === m.id ? "text-[#C9A84C]" : "text-white/60"}`}>{m.label}</p>
                      <p className="text-white/30 text-xs mt-0.5">{m.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Topic */}
              <div>
                <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">Blog Topic</label>
                <textarea
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. How to set up a free zone company in Dubai"
                  rows={2}
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] resize-none transition-all duration-200"
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
                />
                <p className="text-white/20 text-xs mt-2">Press ⌘ + Enter to generate</p>
              </div>

              {/* Strategy inputs */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowStrategy((v) => !v)}
                  className="flex items-center gap-2 text-xs text-white/35 hover:text-[#C9A84C] tracking-[0.12em] uppercase transition-colors duration-150"
                >
                  <svg className={`w-3 h-3 transition-transform duration-200 ${showStrategy ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  Strategy inputs
                  <span className="text-white/20 normal-case tracking-normal">(optional)</span>
                </button>

                {showStrategy && (
                  <div className="mt-3 space-y-3 p-4 rounded-lg border border-white/[0.08] bg-white/[0.02]">
                    <p className="text-white/25 text-xs leading-relaxed">
                      These feed the 12-step strategy engine that runs before writing. Leave blank to let the AI decide.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-white/35 mb-1.5">Target audience</label>
                        <input
                          type="text"
                          value={audience}
                          onChange={(e) => setAudience(e.target.value)}
                          placeholder="e.g. European entrepreneurs"
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/40 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-white/35 mb-1.5">Primary country</label>
                        <input
                          type="text"
                          value={primaryCountry}
                          onChange={(e) => setPrimaryCountry(e.target.value)}
                          placeholder="e.g. UAE"
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/40 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-white/35 mb-1.5">Secondary countries</label>
                        <input
                          type="text"
                          value={secondaryCountries}
                          onChange={(e) => setSecondaryCountries(e.target.value)}
                          placeholder="e.g. UK, Germany"
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/40 transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-white/35 mb-1.5">Priority service</label>
                        <input
                          type="text"
                          value={priorityService}
                          onChange={(e) => setPriorityService(e.target.value)}
                          placeholder="e.g. VARA licensing"
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/40 transition-colors"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs text-white/35 mb-1.5">Language</label>
                        <input
                          type="text"
                          value={language}
                          onChange={(e) => setLanguage(e.target.value)}
                          placeholder="Leave blank for British English — or enter e.g. German, Spanish"
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/40 transition-colors"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Source input — shown for modes B/C/D */}
              {needsSource && (
                <div>
                  <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">
                    {mode === "source_assisted" && "Source article"}
                    {mode === "improve_existing" && "Existing Aston post"}
                    {mode === "notes_to_article" && "Notes"}
                  </label>
                  <textarea
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                    placeholder={selectedMode.placeholder}
                    rows={8}
                    className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] resize-none transition-all duration-200"
                  />
                  <p className="text-white/20 text-xs mt-1.5">
                    {sourceText.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words pasted
                  </p>
                </div>
              )}

              {status === "error" && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
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
              <p className="text-center text-white/20 text-xs">This takes about 3–4 minutes</p>
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
                    <p className="text-white/60 text-sm">{result.readMins} min · {result.wordCount?.toLocaleString()} words</p>
                  </div>
                  <div>
                    <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-1.5">Links placed</p>
                    <p className="text-white/60 text-sm">
                      {result.linksUsed.internal.length} internal
                      {result.linksUsed.external.length > 0 && `, ${result.linksUsed.external.length} external`}
                    </p>
                  </div>
                </div>

                {/* Strategy metadata */}
                {result.strategy && (
                  <div className="border-t border-white/[0.06] pt-4 space-y-2">
                    <p className="text-xs text-white/30 tracking-[0.12em] uppercase">Strategy</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs text-white/25 mb-1">Search intent</p>
                        <p className="text-white/50 text-xs capitalize">{result.strategy.searchIntentType}</p>
                      </div>
                      <div>
                        <p className="text-xs text-white/25 mb-1">Primary keyword</p>
                        <p className="text-white/50 text-xs">{result.strategy.primaryKeyword}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-white/25 mb-1">Article angle</p>
                      <p className="text-white/40 text-xs leading-relaxed">{result.strategy.articleAngle}</p>
                    </div>
                  </div>
                )}

                {result.qa && (
                  <div className={`rounded-lg px-4 py-3 border ${result.qa.status === "pass" ? "bg-emerald-500/10 border-emerald-500/20" : "bg-amber-500/10 border-amber-500/20"}`}>
                    <div className="flex items-center justify-between mb-1">
                      <p className={`text-xs font-medium tracking-wide uppercase ${result.qa.status === "pass" ? "text-emerald-400" : "text-amber-400"}`}>
                        QA {result.qa.status === "pass" ? "Passed" : "Passed with warnings"} · {result.qa.score}/100
                      </p>
                    </div>
                    {result.qa.warnings.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {result.qa.warnings.map((w, i) => (
                          <li key={i} className="text-xs text-amber-300/70">{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
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
