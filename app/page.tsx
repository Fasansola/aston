"use client";

import { useState } from "react";
import type { LinkValidationResult, LinkIssue } from "@/lib/linkValidator";

type Status = "idle" | "loading" | "success" | "error";
type LinkValidationStatus = "idle" | "checking" | "done" | "error";
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

// ── Link Validation Panel ──────────────────────────────────────

function StatusBadge({ status }: { status: LinkIssue["status"] }) {
  const styles = {
    passed:  "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
    warning: "bg-amber-500/15 text-amber-400 border-amber-500/20",
    failed:  "bg-red-500/15 text-red-400 border-red-500/20",
    skipped: "bg-white/5 text-white/30 border-white/10",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide ${styles[status]}`}>
      {status}
    </span>
  );
}

function LinkIssueRow({
  issue,
  expanded,
  onToggle,
}: {
  issue: LinkIssue;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isActionable = issue.status === "failed" || issue.status === "warning";
  return (
    <div className={`border rounded-lg overflow-hidden ${issue.status === "failed" ? "border-red-500/20 bg-red-500/[0.03]" : issue.status === "warning" ? "border-amber-500/20 bg-amber-500/[0.03]" : "border-white/[0.06] bg-white/[0.02]"}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.03] transition-colors"
      >
        <StatusBadge status={issue.status} />
        <span className="text-xs text-white/40 uppercase tracking-wide w-16 shrink-0">{issue.type}</span>
        <span className="text-xs text-white/70 flex-1 truncate">{issue.anchorText || issue.url}</span>
        {isActionable && (
          <svg className={`w-3 h-3 text-white/20 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {expanded && isActionable && (
        <div className="px-3 pb-3 space-y-2 border-t border-white/[0.05] pt-2.5">
          <div>
            <p className="text-[10px] text-white/25 uppercase tracking-wide mb-0.5">URL</p>
            <p className="text-xs text-white/40 font-mono break-all">{issue.url}</p>
            {issue.finalUrl && issue.finalUrl !== issue.url && (
              <p className="text-[10px] text-white/20 mt-0.5">→ Redirected to: {issue.finalUrl}</p>
            )}
          </div>
          {issue.problem && (
            <div>
              <p className="text-[10px] text-white/25 uppercase tracking-wide mb-0.5">Problem</p>
              <p className="text-xs text-white/60">{issue.problem}</p>
            </div>
          )}
          {issue.suggestedFix && (
            <div>
              <p className="text-[10px] text-white/25 uppercase tracking-wide mb-0.5">Suggested fix</p>
              <p className="text-xs text-white/50">{issue.suggestedFix}</p>
            </div>
          )}
          <div className="flex gap-2 flex-wrap pt-1">
            {issue.actions.includes("auto_fix") && (
              <button className="text-[11px] px-2.5 py-1 rounded border border-[#C9A84C]/30 text-[#C9A84C]/80 hover:text-[#C9A84C] hover:border-[#C9A84C]/60 transition-colors">
                Auto-fix
              </button>
            )}
            {issue.actions.includes("find_better_source") && (
              <button className="text-[11px] px-2.5 py-1 rounded border border-[#C9A84C]/30 text-[#C9A84C]/80 hover:text-[#C9A84C] hover:border-[#C9A84C]/60 transition-colors">
                Find better source
              </button>
            )}
            {issue.actions.includes("edit") && (
              <button className="text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 hover:text-white/60 hover:border-white/20 transition-colors">
                Edit link
              </button>
            )}
            {issue.actions.includes("remove") && (
              <button className="text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 hover:text-white/60 hover:border-white/20 transition-colors">
                Remove
              </button>
            )}
            {issue.actions.includes("recheck") && (
              <button className="text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 hover:text-white/60 hover:border-white/20 transition-colors">
                Recheck
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LinkGroupSection({
  label,
  summary,
  issues,
  expanded,
  onToggle,
  expandedIssues,
  onToggleIssue,
}: {
  label: string;
  summary: { passed: number; warning: number; failed: number };
  issues: LinkIssue[];
  expanded: boolean;
  onToggle: () => void;
  expandedIssues: Set<string>;
  onToggleIssue: (id: string) => void;
}) {
  const actionable = issues.filter((i) => i.status !== "passed");
  const allPassed = actionable.length === 0;

  return (
    <div className="space-y-1.5">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between py-1 group"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-white/60 group-hover:text-white/80 transition-colors">{label}</span>
          <div className="flex items-center gap-1.5">
            {summary.failed > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">
                {summary.failed} failed
              </span>
            )}
            {summary.warning > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
                {summary.warning} warning
              </span>
            )}
            {allPassed && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                {summary.passed} passed
              </span>
            )}
          </div>
        </div>
        <svg className={`w-3 h-3 text-white/20 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="space-y-1.5 pl-1">
          {actionable.length === 0 ? (
            <p className="text-xs text-white/25 py-1">All links valid</p>
          ) : (
            actionable.map((issue) => (
              <LinkIssueRow
                key={issue.id}
                issue={issue}
                expanded={expandedIssues.has(issue.id)}
                onToggle={() => onToggleIssue(issue.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function LinkValidationPanel({
  status,
  result,
  expandedGroup,
  setExpandedGroup,
  expandedIssues,
  setExpandedIssues,
  onRecheck,
}: {
  status: LinkValidationStatus;
  result: LinkValidationResult | null;
  expandedGroup: "internal" | "external" | null;
  setExpandedGroup: (g: "internal" | "external" | null) => void;
  expandedIssues: Set<string>;
  setExpandedIssues: (s: Set<string>) => void;
  onRecheck: () => void;
}) {
  const toggleIssue = (id: string) => {
    const next = new Set(expandedIssues);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpandedIssues(next);
  };

  const toggleGroup = (g: "internal" | "external") => {
    setExpandedGroup(expandedGroup === g ? null : g);
  };

  if (status === "checking") {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-4">
        <div className="flex items-center gap-2.5">
          <svg className="w-4 h-4 text-[#C9A84C] animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm text-white/50">Validating links…</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/[0.03] px-4 py-3 flex items-center justify-between">
        <p className="text-xs text-red-400">Link validation failed</p>
        <button onClick={onRecheck} className="text-xs text-white/40 hover:text-white/70 transition-colors">Retry</button>
      </div>
    );
  }

  if (!result) return null;

  const internalIssues = result.issues.filter((i) => i.type === "internal");
  const externalIssues = result.issues.filter((i) => i.type === "external");

  const publishState = result.canPublish
    ? result.overallStatus === "warning"
      ? { label: "Ready with warnings", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" }
      : { label: "All links validated", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" }
    : { label: "Publish blocked — fix failing links before going live", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" };

  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden">
      {/* Header */}
      <div className={`px-4 py-3 border-b ${publishState.bg} border-b-white/[0.05] flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <p className={`text-xs font-medium ${publishState.color}`}>Link Validation</p>
          <span className="text-white/20 text-xs">·</span>
          <p className={`text-xs ${publishState.color}`}>{publishState.label}</p>
        </div>
        <button onClick={onRecheck} className="text-[10px] text-white/25 hover:text-white/50 transition-colors">
          Recheck all
        </button>
      </div>

      {/* Summary row */}
      <div className="px-4 py-3 grid grid-cols-2 gap-3 border-b border-white/[0.05]">
        <div className="space-y-1">
          <p className="text-[10px] text-white/25 uppercase tracking-wide">Internal links</p>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-white/50">{result.summary.internal.passed} passed</span>
            {result.summary.internal.warning > 0 && <span className="text-amber-400">{result.summary.internal.warning} warn</span>}
            {result.summary.internal.failed > 0 && <span className="text-red-400">{result.summary.internal.failed} failed</span>}
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] text-white/25 uppercase tracking-wide">External links</p>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-white/50">{result.summary.external.passed} passed</span>
            {result.summary.external.warning > 0 && <span className="text-amber-400">{result.summary.external.warning} warn</span>}
            {result.summary.external.failed > 0 && <span className="text-red-400">{result.summary.external.failed} failed</span>}
          </div>
        </div>
      </div>

      {/* Expandable groups */}
      <div className="px-4 py-3 space-y-3">
        <LinkGroupSection
          label="Internal links"
          summary={result.summary.internal}
          issues={internalIssues}
          expanded={expandedGroup === "internal"}
          onToggle={() => toggleGroup("internal")}
          expandedIssues={expandedIssues}
          onToggleIssue={toggleIssue}
        />
        <LinkGroupSection
          label="External links"
          summary={result.summary.external}
          issues={externalIssues}
          expanded={expandedGroup === "external"}
          onToggle={() => toggleGroup("external")}
          expandedIssues={expandedIssues}
          onToggleIssue={toggleIssue}
        />
      </div>
    </div>
  );
}

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

  // Link validation
  const [linkValidationStatus, setLinkValidationStatus] = useState<LinkValidationStatus>("idle");
  const [linkValidation, setLinkValidation]             = useState<LinkValidationResult | null>(null);
  const [expandedLinkGroup, setExpandedLinkGroup]       = useState<"internal" | "external" | null>(null);
  const [expandedIssues, setExpandedIssues]             = useState<Set<string>>(new Set());

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
  const canGenerate  = !!topic.trim() && !!audience.trim() && (!needsSource || !!sourceText.trim());

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

      // Auto-run link validation after generation
      if (data.linksUsed) {
        runLinkValidation([
          ...data.linksUsed.internal,
          ...data.linksUsed.external,
        ]);
      }
    } catch (err: unknown) {
      clearInterval(interval);
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  };

  const runLinkValidation = async (links: Array<{ anchor: string; url: string }>) => {
    if (!links.length) return;
    setLinkValidationStatus("checking");
    setLinkValidation(null);
    try {
      const res = await fetch("/api/validate-links", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-secret": process.env.NEXT_PUBLIC_API_SECRET ?? "",
        },
        body: JSON.stringify({ links }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Validation failed");
      setLinkValidation(data.validation);
      setLinkValidationStatus("done");
    } catch {
      setLinkValidationStatus("error");
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setResult(null);
    setError("");
    setTopic("");
    setSourceText("");
    setLinkValidationStatus("idle");
    setLinkValidation(null);
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

              {/* Audience — required */}
              <div>
                <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">
                  Target Audience <span className="text-[#C9A84C]">*</span>
                </label>
                <input
                  type="text"
                  value={audience}
                  onChange={(e) => setAudience(e.target.value)}
                  placeholder="e.g. founders, investors, crypto companies, high-net-worth individuals"
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] transition-all duration-200"
                />
                <p className="text-white/20 text-xs mt-2">Defines tone, complexity, examples, and commercial angle</p>
              </div>

              {/* Strategy inputs — optional */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowStrategy((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-[#C9A84C]/30 transition-all duration-150 group"
                >
                  <div className="flex items-center gap-2.5">
                    <svg className="w-3.5 h-3.5 text-[#C9A84C]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 001.357 2.059l.537.178a2.25 2.25 0 00.707.098h.084M11.25 3.186A4.501 4.501 0 0115 7.5m0 0v-.375c0-.621.504-1.125 1.125-1.125H18a1.125 1.125 0 011.125 1.125V7.5a4.5 4.5 0 01-9 0z" />
                    </svg>
                    <span className="text-sm text-white/70 group-hover:text-white transition-colors">Additional strategy inputs</span>
                    <span className="text-xs text-white/30">(optional — country, service, language)</span>
                  </div>
                  <svg className={`w-4 h-4 text-white/30 transition-transform duration-200 ${showStrategy ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showStrategy && (
                  <div className="mt-3 space-y-3 p-4 rounded-lg border border-white/[0.08] bg-white/[0.02]">
                    <p className="text-white/25 text-xs leading-relaxed">
                      These optional fields shape jurisdiction focus, service emphasis, and output language. Leave blank to let the strategy engine infer from the topic.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
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

              {/* Link Validation Panel */}
              {(linkValidationStatus === "checking" || linkValidationStatus === "done" || linkValidationStatus === "error") && (
                <LinkValidationPanel
                  status={linkValidationStatus}
                  result={linkValidation}
                  expandedGroup={expandedLinkGroup}
                  setExpandedGroup={setExpandedLinkGroup}
                  expandedIssues={expandedIssues}
                  setExpandedIssues={setExpandedIssues}
                  onRecheck={() => {
                    if (result?.linksUsed) {
                      runLinkValidation([...result.linksUsed.internal, ...result.linksUsed.external]);
                    }
                  }}
                />
              )}

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
