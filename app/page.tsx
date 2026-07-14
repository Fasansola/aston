"use client";

import React, { useState, useEffect, useRef } from "react";
import StudioNav from "./components/StudioNav";
import type { LinkValidationResult, LinkIssue } from "@/lib/linkValidator";
import type { ReadinessResult, ReadinessSubscore, ReadinessIssue } from "@/lib/readinessValidator";

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
  postId?: number;
  imageIds?: {
    keypointOneImg: number;
    keypointTwoImg: number;
    postSplitImg:   number;
    featuredImg:    number;
  };
  articleHtml?: string;
  excerpt?: string;
  tags?: string[];
  metaDescription?: string;
  language?: string | null;
  editUrl: string;
  previewUrl: string;
  // Durable workflow pipeline only: set when QA could not fully pass and the
  // article was saved as a draft for human review instead of being discarded.
  needsReview?: boolean;
  failingChecks?: string[];
}

interface TargetConfig {
  enabled: boolean;
  config: Record<string, string>;
}

interface PublishResultItem {
  target: string;
  ok: boolean;
  status: "passed" | "warning" | "failed";
  message: string;
  externalUrl?: string;
  editUrl?: string;
  platformPostId?: string;
}

const STEPS = [
  "Running 12-step strategy analysis...",
  "Planning article structure and blueprint...",
  "Writing blog content from blueprint...",
  "Generating content-aware image prompts...",
  "Publishing draft to WordPress…",
  "Generating & attaching images…",
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

// ── WordPress Post Picker ──────────────────────────────────────

interface WpPostSummary {
  id: number;
  title: string;
  slug: string;
  status: string;
  date: string;
  link: string;
}

function WpPostPicker({ onSelect }: { onSelect: (title: string, content: string) => void }) {
  const [query, setQuery]       = React.useState("");
  const [results, setResults]   = React.useState<WpPostSummary[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [loading, setLoading]   = React.useState<number | null>(null);
  const [error, setError]       = React.useState("");
  const debounceRef             = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = async (q: string) => {
    if (q.trim().length < 3) { setResults([]); return; }
    setSearching(true);
    setError("");
    try {
      const res = await fetch(`/api/fetch-wp-post?search=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setResults(Array.isArray(data.posts) ? data.posts : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleInput = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 400);
  };

  const loadPost = async (post: WpPostSummary) => {
    setLoading(post.id);
    setError("");
    try {
      const res = await fetch(`/api/fetch-wp-post?id=${post.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load post");
      onSelect(data.title, data.content);
      setQuery("");
      setResults([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load post");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="Search by post title…"
          className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 transition-all duration-200 pr-8"
        />
        {searching && (
          <svg className="absolute right-3 top-3 w-4 h-4 text-white/30 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {results.length > 0 && (
        <div className="border border-white/10 rounded-lg overflow-hidden divide-y divide-white/[0.05]">
          {results.map((post) => (
            <button
              key={post.id}
              onClick={() => loadPost(post)}
              disabled={loading === post.id}
              className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-white/[0.04] transition-colors text-left gap-3"
            >
              <div className="min-w-0">
                <p className="text-sm text-white/80 truncate">{post.title}</p>
                <p className="text-[10px] text-white/25 mt-0.5">/{post.slug} · {post.status}</p>
              </div>
              {loading === post.id ? (
                <svg className="w-3.5 h-3.5 text-[#C9A84C] animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              ) : (
                <span className="text-[10px] text-[#C9A84C]/60 shrink-0">Load</span>
              )}
            </button>
          ))}
        </div>
      )}
      {query.length >= 3 && !searching && results.length === 0 && !error && (
        <p className="text-xs text-white/25">No posts found</p>
      )}
    </div>
  );
}

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
  onAction,
}: {
  issue: LinkIssue;
  expanded: boolean;
  onToggle: () => void;
  onAction: (action: "remove" | "recheck" | "edit" | "auto_fix" | "find_better_source", newUrl?: string) => void;
}) {
  const isActionable = issue.status === "failed" || issue.status === "warning";
  const [editMode, setEditMode] = React.useState(false);
  const [editUrl, setEditUrl] = React.useState(issue.url);

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
            {editMode ? (
              <div className="flex gap-1.5 mt-1">
                <input
                  className="flex-1 text-xs font-mono bg-white/5 border border-white/10 rounded px-2 py-1 text-white/70 focus:outline-none focus:border-[#C9A84C]/40"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { onAction("edit", editUrl); setEditMode(false); }
                    if (e.key === "Escape") { setEditMode(false); setEditUrl(issue.url); }
                  }}
                  autoFocus
                />
                <button
                  onClick={() => { onAction("edit", editUrl); setEditMode(false); }}
                  className="text-[11px] px-2.5 py-1 rounded border border-[#C9A84C]/40 text-[#C9A84C] hover:border-[#C9A84C]/70 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditMode(false); setEditUrl(issue.url); }}
                  className="text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/30 hover:text-white/50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <p className="text-xs text-white/40 font-mono break-all">{issue.url}</p>
            )}
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
            {issue.actions.includes("auto_fix") && issue.finalUrl && (
              <button
                onClick={() => onAction("auto_fix", issue.finalUrl!)}
                className="text-[11px] px-2.5 py-1 rounded border border-[#C9A84C]/30 text-[#C9A84C]/80 hover:text-[#C9A84C] hover:border-[#C9A84C]/60 transition-colors"
              >
                Auto-fix
              </button>
            )}
            {issue.actions.includes("find_better_source") && (
              <button
                onClick={() => onAction("find_better_source")}
                className="text-[11px] px-2.5 py-1 rounded border border-[#C9A84C]/30 text-[#C9A84C]/80 hover:text-[#C9A84C] hover:border-[#C9A84C]/60 transition-colors"
              >
                Find better source
              </button>
            )}
            {issue.actions.includes("edit") && (
              <button
                onClick={() => { setEditMode(true); setEditUrl(issue.url); }}
                className="text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 hover:text-white/60 hover:border-white/20 transition-colors"
              >
                Edit link
              </button>
            )}
            {issue.actions.includes("remove") && (
              <button
                onClick={() => onAction("remove")}
                className="text-[11px] px-2.5 py-1 rounded border border-red-500/20 text-red-400/60 hover:text-red-400 hover:border-red-500/40 transition-colors"
              >
                Remove
              </button>
            )}
            {issue.actions.includes("recheck") && (
              <button
                onClick={() => onAction("recheck")}
                className="text-[11px] px-2.5 py-1 rounded border border-white/10 text-white/40 hover:text-white/60 hover:border-white/20 transition-colors"
              >
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
  onLinkAction,
}: {
  label: string;
  summary: { passed: number; warning: number; failed: number };
  issues: LinkIssue[];
  expanded: boolean;
  onToggle: () => void;
  expandedIssues: Set<string>;
  onToggleIssue: (id: string) => void;
  onLinkAction: (issue: LinkIssue, action: "remove" | "recheck" | "edit" | "auto_fix" | "find_better_source", newUrl?: string) => void;
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
                onAction={(action, newUrl) => onLinkAction(issue, action, newUrl)}
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
  onLinkAction,
}: {
  status: LinkValidationStatus;
  result: LinkValidationResult | null;
  expandedGroup: "internal" | "external" | null;
  setExpandedGroup: (g: "internal" | "external" | null) => void;
  expandedIssues: Set<string>;
  setExpandedIssues: (s: Set<string>) => void;
  onRecheck: () => void;
  onLinkAction: (issue: LinkIssue, action: "remove" | "recheck" | "edit" | "auto_fix" | "find_better_source", newUrl?: string) => void;
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
          onLinkAction={onLinkAction}
        />
        <LinkGroupSection
          label="External links"
          summary={result.summary.external}
          issues={externalIssues}
          expanded={expandedGroup === "external"}
          onToggle={() => toggleGroup("external")}
          expandedIssues={expandedIssues}
          onToggleIssue={toggleIssue}
          onLinkAction={onLinkAction}
        />
      </div>
    </div>
  );
}

// ── Readiness Panel ───────────────────────────────────────────

const SUBSCORE_ORDER = ["search_basics", "content_quality", "ai_readiness", "bing_discoverability", "editorial_compliance"];

function ReadinessScoreRing({ score, status }: { score: number; status: ReadinessSubscore["status"] }) {
  const color = status === "passed" ? "#10b981" : status === "warning" ? "#f59e0b" : "#ef4444";
  const r = 18;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" className="shrink-0">
      <circle cx="22" cy="22" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
      <circle
        cx="22" cy="22" r={r} fill="none"
        stroke={color} strokeWidth="3"
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round"
        transform="rotate(-90 22 22)"
      />
      <text x="22" y="26" textAnchor="middle" fontSize="10" fontWeight="600" fill={color}>{score}</text>
    </svg>
  );
}

function ReadinessIssueItem({ issue }: { issue: ReadinessIssue }) {
  const color = issue.severity === "failed" ? "text-red-400" : issue.severity === "warning" ? "text-amber-400" : "text-emerald-400";
  const dot   = issue.severity === "failed" ? "bg-red-400" : issue.severity === "warning" ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className="flex gap-2.5 py-1.5">
      <div className={`w-1 h-1 rounded-full ${dot} mt-1.5 shrink-0`} />
      <div className="flex-1 min-w-0">
        <p className={`text-xs ${color}`}>{issue.message}</p>
        {issue.suggestedFix && (
          <p className="text-[10px] text-white/30 mt-0.5">{issue.suggestedFix}</p>
        )}
      </div>
      {issue.blocking && (
        <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 shrink-0 self-start mt-0.5 uppercase tracking-wide">
          blocking
        </span>
      )}
    </div>
  );
}

function ReadinessSubscoreRow({
  subscore,
  expanded,
  onToggle,
}: {
  subscore: ReadinessSubscore;
  expanded: boolean;
  onToggle: () => void;
}) {
  const statusColor = subscore.status === "passed" ? "text-emerald-400" : subscore.status === "warning" ? "text-amber-400" : "text-red-400";
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 py-2.5 group text-left hover:bg-white/[0.02] -mx-1 px-1 rounded transition-colors"
      >
        <ReadinessScoreRing score={subscore.score} status={subscore.status} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-white/70 group-hover:text-white/90 transition-colors">{subscore.label}</p>
          <p className={`text-[10px] mt-0.5 ${statusColor}`}>{subscore.message}</p>
        </div>
        <svg
          className={`w-3 h-3 text-white/20 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && subscore.issues.length > 0 && (
        <div className="pl-14 pr-1 pb-2 divide-y divide-white/[0.04]">
          {subscore.issues.map((issue) => (
            <ReadinessIssueItem key={issue.id} issue={issue} />
          ))}
        </div>
      )}
      {expanded && subscore.issues.length === 0 && (
        <div className="pl-14 pb-2">
          <p className="text-[10px] text-white/25">No issues found</p>
        </div>
      )}
    </div>
  );
}

function ReadinessPanel({
  status,
  result,
  onAutoFix,
  isAutoFixing,
  appliedFixes,
}: {
  status: "idle" | "checking" | "done" | "error";
  result: ReadinessResult | null;
  onAutoFix: () => void;
  isAutoFixing: boolean;
  appliedFixes: string[];
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (status === "idle") return null;

  if (status === "checking") {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-4">
        <div className="flex items-center gap-2.5">
          <svg className="w-4 h-4 text-[#C9A84C] animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-sm text-white/50">Running readiness checks…</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/[0.03] px-4 py-3">
        <p className="text-xs text-red-400">Readiness check failed — skipped</p>
      </div>
    );
  }

  if (!result) return null;

  const publishStateCfg =
    result.publishState === "ready"
      ? { label: "Ready to publish", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" }
      : result.publishState === "ready_with_warnings"
      ? { label: "Ready with warnings", color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20" }
      : { label: "Blocked — fix issues before publishing", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" };

  const hasAutoFixes = result.warnings > 0 || result.blockingErrors > 0;
  const orderedSubscores = SUBSCORE_ORDER.map((k) => result.subscores.find((s) => s.key === k)).filter(Boolean) as ReadinessSubscore[];

  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden">
      {/* Header */}
      <div className={`px-4 py-3 border-b ${publishStateCfg.bg} border-b-white/[0.05] flex items-center justify-between`}>
        <div className="flex items-center gap-3">
          <div>
            <p className={`text-xs font-medium ${publishStateCfg.color}`}>Search & AI Readiness</p>
            <p className={`text-[10px] mt-0.5 ${publishStateCfg.color} opacity-80`}>{publishStateCfg.label}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className={`text-xl font-light ${publishStateCfg.color}`}>{result.overallScore}</p>
            <p className="text-[9px] text-white/25 uppercase tracking-wide">/ 100</p>
          </div>
        </div>
      </div>

      {/* Summary chips */}
      <div className="px-4 py-2.5 flex items-center gap-3 border-b border-white/[0.05]">
        {result.blockingErrors > 0 && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20">
            {result.blockingErrors} blocking
          </span>
        )}
        {result.warnings > 0 && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
            {result.warnings} warning{result.warnings > 1 ? "s" : ""}
          </span>
        )}
        {result.blockingErrors === 0 && result.warnings === 0 && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
            All checks passed
          </span>
        )}
        {hasAutoFixes && (
          <button
            onClick={onAutoFix}
            disabled={isAutoFixing}
            className="ml-auto text-[11px] px-3 py-1 rounded border border-[#C9A84C]/30 text-[#C9A84C]/80 hover:text-[#C9A84C] hover:border-[#C9A84C]/60 disabled:opacity-40 transition-colors flex items-center gap-1.5"
          >
            {isAutoFixing ? (
              <>
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Applying…
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Auto-fix
              </>
            )}
          </button>
        )}
      </div>

      {/* Applied fixes notice */}
      {appliedFixes.length > 0 && (
        <div className="px-4 py-2.5 border-b border-white/[0.05] bg-emerald-500/[0.04]">
          <p className="text-[10px] text-emerald-400 font-medium mb-1">Auto-fixes applied:</p>
          {appliedFixes.map((fix, i) => (
            <p key={i} className="text-[10px] text-emerald-400/60">· {fix}</p>
          ))}
        </div>
      )}

      {/* Subscores */}
      <div className="px-4 py-1 divide-y divide-white/[0.04]">
        {orderedSubscores.map((subscore) => (
          <ReadinessSubscoreRow
            key={subscore.key}
            subscore={subscore}
            expanded={expandedKey === subscore.key}
            onToggle={() => setExpandedKey(expandedKey === subscore.key ? null : subscore.key)}
          />
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [isAuthed, setIsAuthed]     = useState<null | boolean>(null);
  const [loginPw, setLoginPw]       = useState("");
  const [loginError, setLoginError] = useState("");
  const loginRef                    = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/auth").then(r => setIsAuthed(r.ok)).catch(() => setIsAuthed(false));
  }, []);

  useEffect(() => {
    if (isAuthed === false) setTimeout(() => loginRef.current?.focus(), 50);
  }, [isAuthed]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: loginPw }),
    });
    if (res.ok) { setIsAuthed(true); setLoginPw(""); }
    else { setLoginError("Incorrect password"); }
  }

  const [topic, setTopic]           = useState("");
  const [mode, setMode]             = useState<GenerationMode>("topic_only");
  const [sourceText, setSourceText] = useState("");
  const [sourceUrl, setSourceUrl]   = useState("");
  const [fetchStatus, setFetchStatus] = useState<"idle" | "fetching" | "done" | "error">("idle");
  const [fetchError, setFetchError] = useState("");
  const [inputMode, setInputMode]   = useState<"title" | "prompt">("title");
  const [status, setStatus]         = useState<Status>("idle");
  const [stepIndex, setStepIndex]   = useState(0);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [result, setResult]         = useState<GenerateResult | null>(null);
  const [blogContent, setBlogContent] = useState<Record<string, string> | null>(null);
  const [error, setError]           = useState("");
  // Durable pipeline — now the DEFAULT. Generation runs through the resumable
  // Workflow route (/api/generate-workflow) that can't fail midway. The legacy
  // route stays available as a one-click fallback via the toggle. Defaults on;
  // only an explicit opt-out ("0") keeps the legacy pipeline.
  const [useDurablePipeline, setUseDurablePipeline] = useState(true);
  useEffect(() => {
    const stored = localStorage.getItem("aston_durable_pipeline");
    if (stored !== null) setUseDurablePipeline(stored === "1");
  }, []);
  const toggleDurablePipeline = (on: boolean) => {
    setUseDurablePipeline(on);
    localStorage.setItem("aston_durable_pipeline", on ? "1" : "0");
  };

  useEffect(() => {
    const stored = localStorage.getItem("aston_auto_media");
    if (stored) { try { setAutoMedia(JSON.parse(stored)); } catch { /* ignore */ } }
  }, []);
  const updateAutoMedia = (key: keyof typeof autoMedia, on: boolean) => {
    setAutoMedia((prev) => {
      const next = { ...prev, [key]: on };
      localStorage.setItem("aston_auto_media", JSON.stringify(next));
      return next;
    });
  };

  const [customPrompt, setCustomPrompt] = useState("");

  // Strategy inputs
  const [showStrategy, setShowStrategy]             = useState(false);
  const [audience, setAudience]                     = useState("");
  const [primaryCountry, setPrimaryCountry]         = useState("");
  const [secondaryCountries, setSecondaryCountries] = useState("");
  const [priorityService, setPriorityService]       = useState("");
  const [language, setLanguage]                     = useState("");
  const [siteLanguages, setSiteLanguages]           = useState<{ code: string; name: string }[]>([]);
  const [imageModel, setImageModel]                 = useState<"imagen-4" | "gpt-image-2">("gpt-image-2");

  useEffect(() => {
    fetch("/api/links/languages")
      .then(r => r.json())
      .then(d => { if (d.languages) setSiteLanguages(d.languages); })
      .catch(() => {});
  }, []);

  // Link validation
  const [linkValidationStatus, setLinkValidationStatus] = useState<LinkValidationStatus>("idle");
  const [linkValidation, setLinkValidation]             = useState<LinkValidationResult | null>(null);
  const [expandedLinkGroup, setExpandedLinkGroup]       = useState<"internal" | "external" | null>(null);
  const [expandedIssues, setExpandedIssues]             = useState<Set<string>>(new Set());

  // Readiness validator
  const [readinessStatus, setReadinessStatus] = useState<"idle" | "checking" | "done" | "error">("idle");
  const [readinessResult, setReadinessResult] = useState<ReadinessResult | null>(null);
  const [isAutoFixing, setIsAutoFixing]       = useState(false);
  const [appliedFixes, setAppliedFixes]       = useState<string[]>([]);
  const [wpSyncStatus, setWpSyncStatus]       = useState<"idle" | "syncing" | "synced" | "error">("idle");

  // Delete post
  const [deleteState, setDeleteState] = useState<"idle" | "confirming" | "deleting" | "deleted" | "error">("idle");
  const [deleteError, setDeleteError] = useState("");

  // Publish queue scheduling
  const [showQueuePublish, setShowQueuePublish]       = useState(false);
  const [queueScheduledFor, setQueueScheduledFor]     = useState("");
  const [queuePublishStatus, setQueuePublishStatus]   = useState<"idle" | "adding" | "added" | "error">("idle");

  // Publishing targets
  const [showPublishingTargets, setShowPublishingTargets] = useState(false);
  const [publishingTargets, setPublishingTargets] = useState<Record<string, TargetConfig>>({
    wordpress: { enabled: true,  config: { status: "draft" } },
    medium:    { enabled: false, config: { publishStatus: "draft" } },
    devto:     { enabled: false, config: { published: "false" } },
    hashnode:  { enabled: false, config: {} },
    blogger:   { enabled: false, config: { isDraft: "true" } },
    ghost:     { enabled: false, config: { status: "draft" } },
    email:     { enabled: false, config: {} },
  });
  const [requireAllPass, setRequireAllPass]         = useState(true);
  const [publishStatus, setPublishStatus]           = useState<"idle" | "publishing" | "done" | "error">("idle");
  const [publishResults, setPublishResults]         = useState<PublishResultItem[]>([]);

  // Social cross-posting alongside the scheduled blog publish
  const [socialShare, setSocialShare]     = useState<{ mastodon: boolean; bluesky: boolean; linkedin: boolean }>({ mastodon: false, bluesky: false, linkedin: false });
  const [socialCaptions, setSocialCaptions] = useState<Record<string, string>>({});
  const [socialGenStatus, setSocialGenStatus] = useState<"idle" | "generating" | "done" | "error">("idle");

  const [videoStatus, setVideoStatus]     = useState<"idle" | "generating" | "rendering" | "ready" | "uploading" | "uploaded" | "error">("idle");
  const [videoProgress, setVideoProgress] = useState("");
  const [videoElapsed, setVideoElapsed]   = useState(0);
  const [videoBase64, setVideoBase64]     = useState<string | null>(null);
  const [videoMime, setVideoMime]         = useState("video/mp4");
  const [videoUrl, setVideoUrl]           = useState<string | null>(null);
  const [videoRenderId, setVideoRenderId]       = useState<string | null>(null);
  const [videoBucketName, setVideoBucketName]   = useState<string | null>(null);
  const [videoChapters, setVideoChapters]       = useState<Array<{ title: string; startSecs: number }>>([]);
  const [videoCaptionsSrt, setVideoCaptionsSrt] = useState<string>("");
  const [youtubeUrl, setYoutubeUrl]       = useState<string | null>(null);

  const [imageGenStatus, setImageGenStatus]     = useState<"idle" | "generating" | "done" | "error">("idle");
  const [imageGenMessage, setImageGenMessage]   = useState("");
  const [flowchartUrl, setFlowchartUrl]         = useState<string | null>(null);

  const [audioStatus, setAudioStatus]       = useState<"idle" | "generating" | "done" | "error">("idle");
  const [audioProgress, setAudioProgress]   = useState("");
  const [audioElapsed, setAudioElapsed]     = useState(0);
  const [audioUrl, setAudioUrl]             = useState<string | null>(null);
  const [audioMediaId, setAudioMediaId]     = useState<number | null>(null);
  // Conversational two-voice podcast episode (separate from the blog read-aloud)
  const [podcastStatus, setPodcastStatus]   = useState<"idle" | "generating" | "done" | "error">("idle");
  const [podcastProgress, setPodcastProgress] = useState("");
  const [podcastUrl, setPodcastUrl]         = useState<string | null>(null);
  const [podcastEpisodeId, setPodcastEpisodeId]       = useState<number | null>(null);
  const [podcastAudioMediaId, setPodcastAudioMediaId] = useState<number | null>(null);
  const [podcastLength, setPodcastLength]   = useState<3 | 15 | 30 | 45 | 60>(30);

  // Media outputs — selected before generation, triggered automatically after post is published
  const [autoMedia, setAutoMedia] = useState({ video: false, podcast: false, audio: false });
  const [showMediaOptions, setShowMediaOptions] = useState(false);
  // Snapshot of media opts captured at generation-done time; cleared once consumed by the effect
  const autoMediaPendingOpts = useRef<{ video: boolean; podcast: boolean; audio: boolean } | null>(null);
  // Set to true when auto-video is queued, so the YouTube upload fires once rendering completes
  const shouldAutoUploadVideoRef = useRef(false);

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
  const canGenerate  = (!!topic.trim() || !!customPrompt.trim()) && (!needsSource || !!sourceText.trim());

  const fetchSourceUrl = async () => {
    if (!sourceUrl.trim()) return;
    setFetchStatus("fetching");
    setFetchError("");
    setSourceText("");
    try {
      const res = await fetch("/api/fetch-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: sourceUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFetchStatus("error");
        setFetchError(data.error ?? "Failed to fetch URL");
      } else {
        setSourceText(data.text);
        setFetchStatus("done");
      }
    } catch {
      setFetchStatus("error");
      setFetchError("Network error — could not reach the server");
    }
  };

  const handleGenerate = async () => {
    if (!canGenerate || status === "loading") return;
    setStatus("loading");
    setResult(null);
    setError("");
    setRetryMessage(null);
    const interval = startStepCycle();

    // Shared SSE event handler for both pipelines. Returns "done" on the terminal
    // done event; throws on an error event. Keeps the two code paths in sync.
    const dispatch = (event: Record<string, unknown>): "continue" | "done" => {
      if (event.type === "qa_retry") {
        setRetryMessage(`QA check didn't pass — rewriting content (attempt ${event.attempt}/${event.max})...`);
        return "continue";
      }
      if (event.type === "tech_retry") {
        const reason = event.reason ? ` (${String(event.reason).slice(0, 120)})` : "";
        setRetryMessage(`Technical issue — retrying (attempt ${event.attempt}/${event.max})...${reason}`);
        return "continue";
      }
      if (event.type === "progress") {
        if (typeof event.message === "string" && event.message) setRetryMessage(event.message as string);
        return "continue";
      }
      if (event.type === "done") {
        clearInterval(interval);
        setRetryMessage(null);
        const data = event as unknown as GenerateResult;
        setResult(data);
        const raw = event as unknown as Record<string, string>;
        setBlogContent({
          main_content:   raw.main_content   ?? "",
          more_content_1: raw.more_content_1 ?? "",
          more_content_2: raw.more_content_2 ?? "",
          more_content_3: raw.more_content_3 ?? "",
          more_content_4: raw.more_content_4 ?? "",
          more_content_5: raw.more_content_5 ?? "",
          more_content_6: raw.more_content_6 ?? "",
          final_points:   raw.final_points   ?? "",
        });
        setStatus("success");
        if ((event.linksUsed as GenerateResult["linksUsed"])) {
          runLinkValidation([
            ...(event.linksUsed as GenerateResult["linksUsed"]).internal,
            ...(event.linksUsed as GenerateResult["linksUsed"]).external,
          ], data);
        }
        const evtRaw = event as unknown as Record<string, unknown>;
        if (evtRaw.imagePrompts && evtRaw.postId) {
          generateImages(
            evtRaw.postId as number,
            evtRaw.fileSlug as string,
            evtRaw.imageModel as string,
            evtRaw.imagePrompts as Record<string, string>
          );
        }
        if (!data.needsReview && (autoMedia.video || autoMedia.podcast || autoMedia.audio)) {
          autoMediaPendingOpts.current = { ...autoMedia };
        }
        return "done";
      }
      if (event.type === "error") {
        // Guard: a non-string message would make new Error(obj) say "[object Object]".
        const errText = typeof event.message === "string" && event.message
          ? event.message
          : "Generation failed. Please try again.";
        throw new Error(errText);
      }
      return "continue";
    };

    const requestBody = JSON.stringify({
      topic:               topic.trim(),
      mode,
      sourceText:          sourceText.trim(),
      audience:            audience.trim() || undefined,
      primary_country:     primaryCountry.trim() || undefined,
      secondary_countries: secondaryCountries.trim() || undefined,
      priority_service:    priorityService.trim() || undefined,
      language:            language.trim() || undefined,
      customPrompt:        customPrompt.trim() || undefined,
      imageModel,
    });

    // Parse a validation error (non-2xx JSON returned before any stream starts).
    const parseError = async (res: Response): Promise<string> => {
      let msg = "Generation failed. Please try again.";
      try {
        const parsed = await res.json();
        if (typeof parsed.error === "string" && parsed.error) msg = parsed.error;
        else if (typeof parsed.message === "string" && parsed.message) msg = parsed.message;
      } catch {
        msg = await res.text().catch(() => msg) || msg;
      }
      return msg;
    };

    try {
      if (useDurablePipeline) {
        // ── Durable pipeline ──────────────────────────────────────
        // Start the run, then FOLLOW its durable stream. The run keeps executing
        // server-side across step suspensions even if a streaming connection
        // drops, so we reconnect to the run's stream until the terminal event
        // arrives. We replay from the start each connection and skip events we
        // already handled — correct regardless of startIndex semantics, and cheap
        // since progress events are tiny and the big done event is terminal.
        const startRes = await fetch("/api/generate-workflow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
        if (!startRes.ok) throw new Error(await parseError(startRes));
        const runId = startRes.headers.get("X-Workflow-Run-Id");
        try { await startRes.body?.cancel(); } catch { /* release the kickoff stream */ }
        if (!runId) throw new Error("Could not start generation — no run id returned.");

        let dispatched = 0;          // events already handled across all connections
        let terminal = false;
        // Give up on wall-clock silence, not connection count: the pipeline has
        // legitimate multi-minute quiet stretches (content writing + link scrub +
        // image prompts between two events; up to 3 QA fix passes), and the old
        // 6-empty-connections rule declared runs failed in seconds while the
        // article was still being generated — and often still landed in WordPress.
        const STALL_BUDGET_MS = 25 * 60_000;   // max silence before giving up
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
          let idx = 0;               // position within this replayed stream
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;   // keepalive pings and comments land here
              let event: Record<string, unknown>;
              try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }
              if (idx++ < dispatched) continue;   // already handled in a prior connection
              dispatched++; lastProgressAt = Date.now();
              if (dispatch(event) === "done") { terminal = true; break; }
            }
            if (terminal) break;
          }
          if (terminal) break;
          // Connection closed without a terminal event (function hit its limit, or
          // a network drop). Reconnect unless the run has been silent too long.
          if (stalled()) throw new Error("The generation run stalled without finishing. Check WordPress drafts, or try again.");
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else {
        // ── Legacy single-stream pipeline ─────────────────────────
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
        if (!res.ok) throw new Error(await parseError(res));

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let completed = false;
        // eslint-disable-next-line no-constant-condition
        while (true) {
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
            if (dispatch(event) === "done") { completed = true; break; }
          }
          if (completed) break;
        }
        if (!completed) throw new Error("The server took too long to respond. Please try again.");
      }
    } catch (err: unknown) {
      clearInterval(interval);
      setRetryMessage(null);
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  };

  const selectedSocialTargets = () =>
    (Object.entries(socialShare) as Array<["mastodon" | "bluesky" | "linkedin", boolean]>)
      .filter(([, on]) => on)
      .map(([target]) => target);

  const handleGenerateSocialCaptions = async () => {
    if (!result) return;
    const targets = selectedSocialTargets();
    if (targets.length === 0) return;
    setSocialGenStatus("generating");
    try {
      const res = await fetch("/api/social/captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: result.title,
          summary: result.metaDescription || result.excerpt || result.seoTitle || result.title,
          focusKeyword: result.focusKeyword ?? undefined,
          link: result.previewUrl ?? undefined,
          targets,
        }),
      });
      const data = await res.json();
      if (data.captions) {
        setSocialCaptions((c) => ({ ...c, ...data.captions }));
        setSocialGenStatus("done");
      } else {
        setSocialGenStatus("error");
      }
    } catch {
      setSocialGenStatus("error");
    }
  };

  const handleQueuePublish = async () => {
    if (!result?.articleHtml || queuePublishStatus === "adding") return;
    const selectedTargets = Object.entries(publishingTargets)
      .filter(([, v]) => v.enabled)
      .map(([target, v]) => ({ target, config: v.config }));
    if (selectedTargets.length === 0) return;

    // Social targets cross-post after the blog goes live (handled by the publish worker).
    const socialTargets = selectedSocialTargets().map((target) => ({ target, config: {} }));

    setQueuePublishStatus("adding");
    try {
      const res = await fetch("/api/publish-queue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title:           result.title,
          slug:            result.slug,
          focusKeyword:    result.focusKeyword ?? "",
          articleHtml:     result.articleHtml,
          excerpt:         result.excerpt ?? "",
          tags:            result.tags ?? [],
          seoTitle:        result.seoTitle,
          metaDescription: result.metaDescription ?? "",
          canonicalUrl:    result.previewUrl ?? undefined,
          wordCount:       result.wordCount,
          targets:         selectedTargets,
          scheduledFor:    queueScheduledFor ? new Date(queueScheduledFor).toISOString() : null,
          ...(socialTargets.length ? { socialTargets, socialCaptions } : {}),
        }),
      });
      if (!res.ok) throw new Error("Failed to queue");
      setQueuePublishStatus("added");
    } catch {
      setQueuePublishStatus("error");
    }
  };

  const handlePublish = async () => {
    if (!result?.articleHtml || publishStatus === "publishing") return;
    const selectedTargets = Object.entries(publishingTargets)
      .filter(([, v]) => v.enabled)
      .map(([target, v]) => ({ target, config: v.config }));
    if (selectedTargets.length === 0) return;

    setPublishStatus("publishing");
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title:           result.title,
          excerpt:         result.excerpt ?? "",
          html:            result.articleHtml,
          tags:            result.tags ?? [],
          seoTitle:        result.seoTitle,
          seoDescription:  undefined,
          canonicalUrl:    result.previewUrl ?? undefined,
          targets:         selectedTargets,
          requireAllPass,
        }),
      });
      const data = await res.json();
      setPublishResults(data.results ?? []);
      setPublishStatus("done");
    } catch {
      setPublishStatus("error");
      setError("Publish failed — please try again.");
    }
  };

  const runReadinessCheck = async (
    currentResult: GenerateResult,
    hasLinkFailures: boolean,
  ) => {
    if (!currentResult.articleHtml) return;
    setReadinessStatus("checking");
    setReadinessResult(null);
    try {
      const res = await fetch("/api/validate-readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title:                   currentResult.title,
          seoTitle:                currentResult.seoTitle,
          metaDescription:         currentResult.metaDescription ?? "",
          slug:                    currentResult.slug,
          focusKeyword:            currentResult.focusKeyword,
          articleHtml:             currentResult.articleHtml,
          wordCount:               currentResult.wordCount,
          language:                currentResult.language ?? null,
          internalLinksCount:      currentResult.linksUsed.internal.length,
          externalLinksCount:      currentResult.linksUsed.external.length,
          hasLinkValidationFailures: hasLinkFailures,
          qaWarnings:              currentResult.qa.warnings,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Readiness check failed");
      setReadinessResult(data.result);
      setReadinessStatus("done");
    } catch {
      setReadinessStatus("error");
    }
  };

  const handleAutoFix = async () => {
    if (!result?.articleHtml || isAutoFixing) return;
    setIsAutoFixing(true);
    try {
      const res = await fetch("/api/autofix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          html: result.articleHtml,
          language: result.language,
          issues: readinessResult?.issues ?? [],
          focusKeyword: result.focusKeyword,
          title: result.title,
          seoTitle: result.seoTitle,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Auto-fix failed");
      // Update result with fixed HTML and re-run readiness
      const updatedResult = { ...result, articleHtml: data.html };
      setResult(updatedResult);
      setAppliedFixes((prev) => [...prev, ...(data.appliedFixes ?? [])]);
      // Re-run readiness with fixed HTML
      const hasLinkFailures = linkValidation ? !linkValidation.canPublish : false;
      await runReadinessCheck(updatedResult, hasLinkFailures);
    } catch {
      setError("Auto-fix failed — please try again.");
    } finally {
      setIsAutoFixing(false);
    }
  };

  const handleDeletePost = async () => {
    if (!result?.postId) {
      setDeleteError("Post ID not found — please delete this post manually in WordPress.");
      setDeleteState("error");
      return;
    }
    setDeleteState("deleting");
    setDeleteError("");
    try {
      const res = await fetch("/api/delete-post", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: result.postId, imageIds: result.imageIds, audioMediaId, youtubeUrl: youtubeUrl ?? undefined, podcastEpisodeId: podcastEpisodeId ?? undefined, podcastAudioMediaId: podcastAudioMediaId ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.errors?.join(", ") || data.error || "Delete failed");
      }
      setDeleteState("deleted");
      // Clear the result so the UI resets to the generate form
      setTimeout(() => {
        setResult(null);
        setDeleteState("idle");
        setDeleteError("");
      }, 2000);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleteState("error");
    }
  };


  const runLinkValidation = async (links: Array<{ anchor: string; url: string }>, currentResult?: GenerateResult) => {
    if (!links.length) return;
    setLinkValidationStatus("checking");
    setLinkValidation(null);
    try {
      const res = await fetch("/api/validate-links", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ links }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Validation failed");
      setLinkValidation(data.validation);
      setLinkValidationStatus("done");
      // Auto-trigger readiness check after link validation
      const r = currentResult ?? result;
      if (r) {
        const hasLinkFailures = !data.validation?.canPublish;
        runReadinessCheck(r, hasLinkFailures);
      }
    } catch {
      setLinkValidationStatus("error");
    }
  };

  // ── Link action handler ───────────────────────────────────────
  const handleLinkAction = async (
    issue: LinkIssue,
    action: "remove" | "recheck" | "edit" | "auto_fix" | "find_better_source",
    newUrl?: string
  ) => {
    if (action === "find_better_source") {
      // Open a Google search for a better source on the same topic
      const query = encodeURIComponent(`${issue.anchorText} official source site:gov OR site:org OR site:edu`);
      window.open(`https://www.google.com/search?q=${query}`, "_blank");
      return;
    }

    // Helpers to update link in articleHtml (local preview)
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replaceHref = (html: string, oldUrl: string, updatedUrl: string) =>
      html.replace(new RegExp(`href=["']${escapeRegex(oldUrl)}["']`, "g"), `href="${updatedUrl}"`);
    const removeLink = (html: string, url: string) =>
      html.replace(new RegExp(`<a[^>]+href=["']${escapeRegex(url)}["'][^>]*>(.*?)</a>`, "gs"), "$1");

    // Helper to recompute validation summary after changing issues array
    const recomputeValidation = (prev: LinkValidationResult, updatedIssues: LinkIssue[]): LinkValidationResult => {
      const internals = updatedIssues.filter((i) => i.type === "internal");
      const externals = updatedIssues.filter((i) => i.type === "external");
      const count = (arr: LinkIssue[], s: string) => arr.filter((i) => i.status === s).length;
      const hasBlocking = updatedIssues.some((i) => i.blocking && i.status === "failed");
      const hasWarnings = updatedIssues.some((i) => i.status === "warning");
      return {
        ...prev,
        issues: updatedIssues,
        canPublish: !hasBlocking,
        overallStatus: hasBlocking ? "failed" : hasWarnings ? "warning" : "passed",
        summary: {
          internal: { passed: count(internals, "passed"), warning: count(internals, "warning"), failed: count(internals, "failed") },
          external: { passed: count(externals, "passed"), warning: count(externals, "warning"), failed: count(externals, "failed") },
        },
      };
    };

    // Push link change to WordPress with status tracking
    const syncToWordPress = async (wpAction: "replace" | "remove", wpNewUrl?: string) => {
      if (!result?.postId) return;
      setWpSyncStatus("syncing");
      try {
        const res = await fetch("/api/update-post-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId: result.postId, oldUrl: issue.url, action: wpAction, newUrl: wpNewUrl }),
        });
        if (!res.ok) throw new Error("sync failed");
        setWpSyncStatus("synced");
        setTimeout(() => setWpSyncStatus("idle"), 4000);
      } catch {
        setWpSyncStatus("error");
        setTimeout(() => setWpSyncStatus("idle"), 6000);
      }
    };

    if (action === "remove") {
      if (!result) return;
      const updatedHtml = removeLink(result.articleHtml ?? "", issue.url);
      setResult({ ...result, articleHtml: updatedHtml });
      setLinkValidation((prev) => prev ? recomputeValidation(prev, prev.issues.filter((i) => i.id !== issue.id)) : prev);
      syncToWordPress("remove");
      return;
    }

    if (action === "auto_fix" && newUrl) {
      if (!result) return;
      const updatedHtml = replaceHref(result.articleHtml ?? "", issue.url, newUrl);
      setResult({ ...result, articleHtml: updatedHtml });
      setLinkValidation((prev) => prev ? recomputeValidation(prev, prev.issues.map((i) =>
        i.id === issue.id ? { ...i, url: newUrl, status: "passed" as const, problem: null, suggestedFix: null, blocking: false, actions: ["recheck" as const] } : i
      )) : prev);
      syncToWordPress("replace", newUrl);
      return;
    }

    if (action === "edit" && newUrl) {
      if (!result) return;
      const updatedHtml = replaceHref(result.articleHtml ?? "", issue.url, newUrl);
      setResult({ ...result, articleHtml: updatedHtml });
      syncToWordPress("replace", newUrl);
      // Recheck the new URL and update the issue
      try {
        const res = await fetch("/api/validate-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ links: [{ anchor: issue.anchorText, url: newUrl }] }),
        });
        const data = await res.json();
        const recheckResult: LinkIssue | undefined = data.validation?.issues?.[0];
        if (!recheckResult) return;
        setLinkValidation((prev) => prev ? recomputeValidation(prev, prev.issues.map((i) => i.id === issue.id ? { ...recheckResult, id: issue.id } : i)) : prev);
      } catch { /* silently fail — issue stays as-is */ }
      return;
    }

    if (action === "recheck") {
      try {
        const res = await fetch("/api/validate-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ links: [{ anchor: issue.anchorText, url: issue.url }] }),
        });
        const data = await res.json();
        const recheckResult: LinkIssue | undefined = data.validation?.issues?.[0];
        if (!recheckResult) return;
        setLinkValidation((prev) => prev ? recomputeValidation(prev, prev.issues.map((i) => i.id === issue.id ? { ...recheckResult, id: issue.id } : i)) : prev);
      } catch { /* silently fail */ }
      return;
    }
  };

  const handleReset = () => {
    setStatus("idle");
    setResult(null);
    setError("");
    setRetryMessage(null);
    setTopic("");
    setSourceText("");
    setSourceUrl("");
    setFetchStatus("idle");
    setFetchError("");
    setInputMode("title");
    setLinkValidationStatus("idle");
    setLinkValidation(null);
    setReadinessStatus("idle");
    setReadinessResult(null);
    setAppliedFixes([]);
    setShowQueuePublish(false);
    setQueueScheduledFor("");
    setQueuePublishStatus("idle");
    setPublishStatus("idle");
    setPublishResults([]);
    setMode("topic_only");
    setStepIndex(0);
    setAudience("");
    setPrimaryCountry("");
    setSecondaryCountries("");
    setPriorityService("");
    setLanguage("");
    setCustomPrompt("");
    setImageGenStatus("idle");
    setImageGenMessage("");
    setFlowchartUrl(null);
    setVideoStatus("idle");
    setVideoProgress("");
    setVideoElapsed(0);
    setVideoBase64(null);
    setVideoUrl(null);
    setVideoRenderId(null);
    setVideoBucketName(null);
    setVideoChapters([]);
    setVideoCaptionsSrt("");
    setYoutubeUrl(null);
    setAudioStatus("idle");
    setAudioProgress("");
    setAudioElapsed(0);
    setAudioUrl(null);
    setAudioMediaId(null);
    setPodcastStatus("idle");
    setPodcastProgress("");
    setPodcastUrl(null);
    setPodcastEpisodeId(null);
    setPodcastAudioMediaId(null);
    setPodcastLength(30);
    setBlogContent(null);
    autoMediaPendingOpts.current = null;
    shouldAutoUploadVideoRef.current = false;
  };

  const handleGenerateVideo = async () => {
    if (!result) return;
    setVideoStatus("generating");
    setVideoProgress("Preparing video pipeline…");
    setVideoElapsed(0);
    setVideoBase64(null);
    setVideoUrl(null);
    setVideoRenderId(null);
    setVideoChapters([]);
    setVideoCaptionsSrt("");
    setYoutubeUrl(null);

    const timerStart = Date.now();
    const timer = setInterval(() => setVideoElapsed(Math.round((Date.now() - timerStart) / 1000)), 1000);

    try {
      const res = await fetch("/api/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:          result.title,
          audioUrl:       audioUrl || undefined,   // pass existing audio if generated
          main_content:   blogContent?.main_content,
          more_content_1: blogContent?.more_content_1,
          more_content_2: blogContent?.more_content_2,
          more_content_3: blogContent?.more_content_3,
          more_content_4: blogContent?.more_content_4,
          more_content_5: blogContent?.more_content_5,
          more_content_6: blogContent?.more_content_6,
          final_points:   blogContent?.final_points,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setVideoStatus("error");
        setVideoProgress(err.error || "Video generation failed.");
        clearInterval(timer);
        return;
      }

      const reader  = res.body.getReader();
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
              setVideoProgress(String(event.message ?? ""));
            } else if (event.type === "submitted") {
              const rId    = String(event.renderId);
              const bucket = String(event.bucketName ?? "");
              setVideoRenderId(rId);
              setVideoBucketName(bucket);
              setVideoStatus("rendering");
              setVideoProgress(String(event.message ?? "Video rendering on Remotion Lambda…"));
              if (Array.isArray(event.chapters)) {
                setVideoChapters(event.chapters as Array<{ title: string; startSecs: number }>);
              }
              if (typeof event.captionsSrt === "string") {
                setVideoCaptionsSrt(event.captionsSrt as string);
              }
              clearInterval(timer);
              pollRemotionRender(rId, bucket);
              return;
            } else if (event.type === "error") {
              setVideoStatus("error");
              setVideoProgress(String(event.message ?? "Video generation failed."));
              clearInterval(timer);
              return;
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      setVideoStatus("error");
      setVideoProgress(err instanceof Error ? err.message : "Something went wrong.");
      clearInterval(timer);
    }
  };

  // Polls Shotstack every 12 s until the render is done or failed
  const pollRemotionRender = (renderId: string, bucketName: string) => {
    const POLL_INTERVAL = 10_000;          // Remotion renders faster than Shotstack
    const MAX_WAIT_MS   = 15 * 60 * 1000; // 15 minutes

    const startedAt = Date.now();

    const interval = setInterval(async () => {
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        clearInterval(interval);
        setVideoStatus("error");
        setVideoProgress("Render timed out after 15 minutes.");
        return;
      }
      try {
        const res  = await fetch(`/api/check-video-render?id=${renderId}&bucket=${encodeURIComponent(bucketName)}`);
        const data = await res.json() as { status: string; progress?: number; url?: string; error?: string };

        if (data.status === "done" && data.url) {
          clearInterval(interval);
          setVideoUrl(data.url);
          setVideoStatus("ready");
          setVideoProgress("Video ready!");
        } else if (data.status === "error") {
          clearInterval(interval);
          setVideoStatus("error");
          setVideoProgress(`Render failed: ${data.error ?? "unknown error"}`);
        } else {
          const pct = data.progress != null ? ` (${Math.round(data.progress * 100)}%)` : "";
          setVideoProgress(`Rendering video frames${pct}…`);
        }
      } catch (err) {
        console.warn("[poll] Status check failed:", err);
      }
    }, POLL_INTERVAL);
  };

  const handleUploadToYouTube = async () => {
    if (!result || (!videoUrl && !videoBase64)) return;
    setVideoStatus("uploading");

    try {
      const res = await fetch("/api/upload-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postId:            result.postId,
          title:             result.title,
          videoUrl:          videoUrl    || undefined,
          videoBase64:       videoBase64 || undefined,
          chapters:          videoChapters.length > 0 ? videoChapters : undefined,
          captionsSrt:       videoCaptionsSrt || undefined,
          // Blog SEO context → drives the keyword-first YouTube title, rich
          // description, and tags (see lib/youtubeSeo.ts).
          focusKeyword:      result.focusKeyword || undefined,
          secondaryKeywords: result.tags && result.tags.length > 0 ? result.tags : undefined,
          summary:           result.metaDescription || result.excerpt || undefined,
          blogUrl:           result.previewUrl || undefined,
          language:          result.language || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed.");
      setYoutubeUrl(data.youtubeUrl);
      setVideoStatus("uploaded");
    } catch (err) {
      setVideoStatus("error");
      setVideoProgress(err instanceof Error ? err.message : "Upload failed.");
    }
  };

  // Called automatically after the main generate pipeline publishes the text post.
  // Runs image generation as a second, separate request so the total pipeline
  // fits within Vercel's 300 s function timeout.
  const generateImages = async (
    postId: number,
    fileSlug: string,
    imageModel: string,
    imagePrompts: Record<string, string>
  ) => {
    setImageGenStatus("generating");
    setImageGenMessage("Generating images…");
    try {
      const res = await fetch("/api/generate-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId, fileSlug, imageModel, imagePrompts }),
      });
      if (!res.body) throw new Error("No response body from generate-images.");
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
          let event: Record<string, unknown>;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "progress") {
            setImageGenMessage(String(event.message ?? ""));
          } else if (event.type === "done") {
            setImageGenStatus("done");
            setImageGenMessage("Images attached to post ✓");
            setResult((prev) => prev ? { ...prev, imageIds: event.imageIds as GenerateResult["imageIds"] } : prev);
            if (event.flowchartUrl) setFlowchartUrl(event.flowchartUrl as string);
          } else if (event.type === "error") {
            throw new Error(String(event.message));
          }
        }
      }
    } catch (err) {
      setImageGenStatus("error");
      setImageGenMessage(err instanceof Error ? err.message : "Image generation failed.");
      console.error("[generate-images]", err);
    }
  };

  const handleGenerateAudio = async () => {
    if (!result) return;
    setAudioStatus("generating");
    setAudioProgress("Building audio script from article…");
    setAudioElapsed(0);
    setAudioUrl(null);

    const timerStart = Date.now();
    const timer = setInterval(() => {
      setAudioElapsed(Math.round((Date.now() - timerStart) / 1000));
    }, 1000);

    try {
      const res = await fetch("/api/generate-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postId:         result.postId,
          title:          result.title,
          main_content:   blogContent?.main_content,
          more_content_1: blogContent?.more_content_1,
          more_content_2: blogContent?.more_content_2,
          more_content_3: blogContent?.more_content_3,
          more_content_4: blogContent?.more_content_4,
          more_content_5: blogContent?.more_content_5,
          more_content_6: blogContent?.more_content_6,
          final_points:   blogContent?.final_points,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setAudioStatus("error");
        setAudioProgress(err.error || "Audio generation failed.");
        return;
      }

      const reader  = res.body.getReader();
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
            const event = JSON.parse(line) as { type: string; message?: string; audioUrl?: string; audioMediaId?: number };
            if (event.type === "progress" && event.message) setAudioProgress(event.message);
            if (event.type === "done" && event.audioUrl) {
              setAudioUrl(event.audioUrl);
              setAudioMediaId(event.audioMediaId ?? null);
              setAudioStatus("done");
            }
            if (event.type === "error") {
              setAudioStatus("error");
              setAudioProgress(event.message ?? "Audio generation failed.");
            }
          } catch { /* ignore malformed chunks */ }
        }
      }
    } catch (err) {
      setAudioStatus("error");
      setAudioProgress(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      clearInterval(timer);
    }
  };

  // Generate the conversational two-voice podcast episode (host + expert + music
  // sting) and save it to ACF podcast_audio_url. This is what the Spotify feed
  // serves — distinct from the blog read-aloud above.
  const handleGeneratePodcast = async () => {
    if (!result?.postId) return;
    setPodcastStatus("generating");
    setPodcastProgress("Starting…");
    setPodcastUrl(null);
    try {
      const res = await fetch("/api/generate-podcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: result.postId, title: result.title, focusKeyword: result.focusKeyword, length: podcastLength }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        setPodcastStatus("error");
        setPodcastProgress(err.error || "Podcast generation failed.");
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
            const event = JSON.parse(line) as { type: string; message?: string; podcastUrl?: string; podcastEpisodeId?: number; podcastAudioMediaId?: number };
            if (event.type === "progress" && event.message) setPodcastProgress(event.message);
            if (event.type === "done" && event.podcastUrl) {
              setPodcastUrl(event.podcastUrl);
              setPodcastEpisodeId(event.podcastEpisodeId ?? null);
              setPodcastAudioMediaId(event.podcastAudioMediaId ?? null);
              setPodcastStatus("done");
            }
            if (event.type === "error") {
              setPodcastStatus("error");
              setPodcastProgress(event.message ?? "Podcast generation failed.");
            }
          } catch { /* ignore malformed chunks */ }
        }
      }
    } catch (err) {
      setPodcastStatus("error");
      setPodcastProgress(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  // After post generation completes, auto-run whichever media outputs were selected.
  // Audio runs first so the video pipeline can reuse the narration URL.
  // Video and podcast then run in parallel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const opts = autoMediaPendingOpts.current;
    if (!opts || !result) return;
    autoMediaPendingOpts.current = null;
    (async () => {
      if (opts.audio) await handleGenerateAudio();
      const parallel: Promise<void>[] = [];
      if (opts.video) {
        shouldAutoUploadVideoRef.current = true;
        parallel.push(handleGenerateVideo());
      }
      if (opts.podcast) parallel.push(handleGeneratePodcast());
      if (parallel.length > 0) await Promise.all(parallel);
    })();
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-upload to YouTube once the video finishes rendering (only when triggered via auto-media).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (videoStatus === "ready" && videoUrl && shouldAutoUploadVideoRef.current) {
      shouldAutoUploadVideoRef.current = false;
      handleUploadToYouTube();
    }
  }, [videoStatus, videoUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isAuthed === null) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="studio-bg" />
      <div className="w-2 h-2 rounded-full bg-gold animate-pulse" />
    </div>
  );

  if (isAuthed === false) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="studio-bg" />
      <form onSubmit={handleLogin} className="relative z-10 w-[22rem] rise-in">
        <div className="text-center mb-8">
          <div className="w-12 h-12 mx-auto rounded-xl bg-gradient-to-b from-[#dcbd72] via-gold to-[#a8873a] flex items-center justify-center shadow-[0_10px_30px_-8px_rgba(201,168,76,0.55)] mb-5">
            <span className="font-display text-black font-semibold text-2xl leading-none">A</span>
          </div>
          <h1 className="font-display text-2xl text-white/95 tracking-tight">Aston Content Studio</h1>
          <p className="text-white/35 text-sm mt-1.5">Enter your password to continue</p>
        </div>
        <div className="panel p-6 space-y-4">
          <input
            ref={loginRef}
            type="password"
            value={loginPw}
            onChange={e => setLoginPw(e.target.value)}
            placeholder="Password"
            className="input-studio"
          />
          {loginError && <p className="text-red-300 text-xs text-center">{loginError}</p>}
          <button type="submit" className="btn-gold w-full">
            Sign in
          </button>
        </div>
      </form>
    </div>
  );

  return (
    <div className="min-h-screen text-white font-sans">
      <div className="studio-bg" />
      <StudioNav />

      <div className="relative z-10 max-w-2xl mx-auto px-6 pt-12 pb-16">
        <header className="mb-12 rise-in">
          <p className="label-caps mb-2.5">Articles · WordPress</p>
          <h1 className="font-display text-[2.75rem] leading-tight tracking-tight text-white/95 mb-3">
            Blog <span className="text-gold">generator</span>
          </h1>
          <p className="text-white/40 text-sm leading-relaxed max-w-lg">
            Enter a topic. We run a full strategy analysis, write the post, generate images, and publish a draft to WordPress — ready for your review.
          </p>
        </header>

        <main>
          {(status === "idle" || status === "error") && (
            <div className="space-y-6">

              {/* Mode selector */}
              <div>
                <label className="label-caps mb-3">Generation mode</label>
                <div className="grid grid-cols-2 gap-2.5">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      data-active={mode === m.id}
                      onClick={() => {
                        setMode(m.id);
                        if (m.id === "improve_existing") {
                          setCustomPrompt("");
                          setTopic("");
                          setSourceText("");
                          setSourceUrl("");
                          setFetchStatus("idle");
                          setFetchError("");
                        }
                      }}
                      className="option-card"
                    >
                      <p className={`text-xs font-medium ${mode === m.id ? "text-gold-bright" : "text-white/60"}`}>{m.label}</p>
                      <p className="text-white/30 text-xs mt-0.5">{m.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Title / Prompt toggle — hidden for improve_existing */}
              {mode !== "improve_existing" && (
                <div>
                  {/* Toggle */}
                  <div className="flex items-center gap-1 mb-4 bg-white/[0.04] border border-white/10 rounded-full p-1 w-fit">
                    <button
                      type="button"
                      onClick={() => { setInputMode("title"); setCustomPrompt(""); }}
                      className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-150 ${
                        inputMode === "title"
                          ? "bg-gradient-to-b from-[#dcbd72] to-[#b6923a] text-black shadow-[0_4px_14px_-4px_rgba(201,168,76,0.6)]"
                          : "text-white/40 hover:text-white/70"
                      }`}
                    >
                      Title
                    </button>
                    <button
                      type="button"
                      onClick={() => { setInputMode("prompt"); setTopic(""); }}
                      className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all duration-150 ${
                        inputMode === "prompt"
                          ? "bg-gradient-to-b from-[#dcbd72] to-[#b6923a] text-black shadow-[0_4px_14px_-4px_rgba(201,168,76,0.6)]"
                          : "text-white/40 hover:text-white/70"
                      }`}
                    >
                      Prompt
                    </button>
                  </div>

                  {inputMode === "title" ? (
                    <div>
                      <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">
                        Blog topic
                      </label>
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
                  ) : (
                    <div>
                      <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">
                        Custom prompt
                      </label>
                      <textarea
                        value={customPrompt}
                        onChange={(e) => setCustomPrompt(e.target.value)}
                        placeholder="e.g. Write a highly authoritative article about DFSA tokenisation sandbox in DIFC, targeting institutional investors and fintech founders…"
                        rows={5}
                        style={{ resize: "vertical" }}
                        className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] transition-all duration-200"
                      />
                      <p className="text-white/20 text-xs mt-2">AI derives the article title from your prompt</p>
                    </div>
                  )}
                </div>
              )}

              {/* Audience — required */}
              <div>
                <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">
                  Target Audience <span className="text-white/20 normal-case tracking-normal">(optional)</span>
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
                      <div>
                        <label className="block text-xs text-white/35 mb-1.5">Language</label>
                        <select
                          value={language}
                          onChange={(e) => setLanguage(e.target.value)}
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40 transition-colors appearance-none"
                        >
                          <option value="" className="bg-[#1a1a1a]">Default (British English)</option>
                          {siteLanguages.map(l => (
                            <option key={l.code} value={l.code} className="bg-[#1a1a1a]">{l.name} ({l.code})</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs text-white/35 mb-1.5">Image model</label>
                        <select
                          value={imageModel}
                          onChange={(e) => setImageModel(e.target.value as "imagen-4" | "gpt-image-2")}
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40 transition-colors appearance-none"
                        >
                          <option value="gpt-image-2" className="bg-[#1a1a1a]">GPT Image 2 (OpenAI)</option>
                          <option value="imagen-4" className="bg-[#1a1a1a]">Imagen 4 (Google)</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Publishing targets */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowPublishingTargets((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-[#C9A84C]/30 transition-all duration-150 group"
                >
                  <div className="flex items-center gap-2.5">
                    <svg className="w-3.5 h-3.5 text-[#C9A84C]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
                    </svg>
                    <span className="text-sm text-white/70 group-hover:text-white transition-colors">Publishing targets</span>
                    <span className="text-xs text-white/30">
                      ({Object.values(publishingTargets).filter((t) => t.enabled).length} selected)
                    </span>
                  </div>
                  <svg className={`w-4 h-4 text-white/30 transition-transform duration-200 ${showPublishingTargets ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {showPublishingTargets && (
                  <div className="mt-3 space-y-2 p-4 rounded-lg border border-white/[0.08] bg-white/[0.02]">
                    <p className="text-white/25 text-xs mb-3 leading-relaxed">
                      Select where to publish after generation. Article is generated once, then dispatched to all selected targets.
                    </p>
                    {(
                      [
                        { key: "wordpress", label: "WordPress",     hint: "Your primary Aston.ae site",                      defaultConfig: { status: "draft" } },
                        { key: "medium",    label: "Medium",         hint: "For broad professional reach",                    defaultConfig: { publishStatus: "draft" } },
                        { key: "devto",     label: "DEV",            hint: "For developer and technical audiences",           defaultConfig: { published: "false" } },
                        { key: "hashnode",  label: "Hashnode",        hint: "For technical blogging and custom publications", defaultConfig: {} },
                        { key: "blogger",   label: "Blogger",         hint: "For simple Google-based blog publishing",        defaultConfig: { isDraft: "true" } },
                        { key: "ghost",     label: "Ghost",           hint: "For owned publication publishing",               defaultConfig: { status: "draft" } },
                        { key: "email",     label: "Send by email",   hint: "For internal review or distribution",           defaultConfig: {} },
                      ] as const
                    ).map(({ key, label, hint }) => {
                      const tgt = publishingTargets[key];
                      return (
                        <div key={key} className={`rounded-lg border transition-colors ${tgt.enabled ? "border-[#C9A84C]/20 bg-[#C9A84C]/[0.03]" : "border-white/[0.06]"}`}>
                          <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={tgt.enabled}
                              onChange={(e) => setPublishingTargets((prev) => ({
                                ...prev,
                                [key]: { ...prev[key], enabled: e.target.checked },
                              }))}
                              className="w-3.5 h-3.5 accent-[#C9A84C]"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-white/80">{label}</p>
                              <p className="text-[10px] text-white/25">{hint}</p>
                            </div>
                          </label>
                          {tgt.enabled && (
                            <div className="px-3 pb-3 space-y-2 border-t border-white/[0.05] pt-2.5">
                              {key === "wordpress" && (
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">Status</label>
                                    <select
                                      value={tgt.config.status ?? "draft"}
                                      onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, status: e.target.value } } }))}
                                      className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40"
                                    >
                                      <option value="draft">Draft</option>
                                      <option value="pending">Pending review</option>
                                      <option value="publish">Publish now</option>
                                    </select>
                                  </div>
                                </div>
                              )}
                              {key === "medium" && (
                                <div className="space-y-2">
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">Access token <span className="text-red-400">*</span></label>
                                    <input type="password" placeholder="Your Medium self-issued access token" value={tgt.config.accessToken ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, accessToken: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Status</label>
                                      <select value={tgt.config.publishStatus ?? "draft"} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, publishStatus: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40">
                                        <option value="draft">Draft</option>
                                        <option value="unlisted">Unlisted</option>
                                        <option value="public">Public</option>
                                      </select>
                                    </div>
                                  </div>
                                </div>
                              )}
                              {key === "devto" && (
                                <div className="space-y-2">
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">API key <span className="text-red-400">*</span></label>
                                    <input type="password" placeholder="Your DEV.to API key" value={tgt.config.apiKey ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, apiKey: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Publish</label>
                                      <select value={tgt.config.published ?? "false"} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, published: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40">
                                        <option value="false">Save as draft</option>
                                        <option value="true">Publish now</option>
                                      </select>
                                    </div>
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Series (optional)</label>
                                      <input type="text" placeholder="Series name" value={tgt.config.series ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, series: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                    </div>
                                  </div>
                                </div>
                              )}
                              {key === "hashnode" && (
                                <div className="space-y-2">
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">API token <span className="text-red-400">*</span></label>
                                    <input type="password" placeholder="Your Hashnode API token" value={tgt.config.token ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, token: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">Publication ID <span className="text-red-400">*</span></label>
                                    <input type="text" placeholder="Your Hashnode publication ID" value={tgt.config.publicationId ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, publicationId: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                  </div>
                                </div>
                              )}
                              {key === "blogger" && (
                                <div className="space-y-2">
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">Google API key <span className="text-red-400">*</span></label>
                                    <input type="password" placeholder="Your Google API key" value={tgt.config.apiKey ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, apiKey: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Blog ID <span className="text-red-400">*</span></label>
                                      <input type="text" placeholder="Your Blogger blog ID" value={tgt.config.blogId ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, blogId: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                    </div>
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Mode</label>
                                      <select value={tgt.config.isDraft ?? "true"} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, isDraft: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40">
                                        <option value="true">Draft</option>
                                        <option value="false">Publish now</option>
                                      </select>
                                    </div>
                                  </div>
                                </div>
                              )}
                              {key === "ghost" && (
                                <div className="space-y-2">
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">Ghost site URL <span className="text-red-400">*</span></label>
                                    <input type="text" placeholder="https://myblog.ghost.io" value={tgt.config.siteUrl ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, siteUrl: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Admin API key <span className="text-red-400">*</span></label>
                                      <input type="password" placeholder="id:secret" value={tgt.config.adminApiKey ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, adminApiKey: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                    </div>
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Status</label>
                                      <select value={tgt.config.status ?? "draft"} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, status: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40">
                                        <option value="draft">Draft</option>
                                        <option value="published">Publish now</option>
                                      </select>
                                    </div>
                                  </div>
                                </div>
                              )}
                              {key === "email" && (
                                <div className="space-y-2">
                                  <div>
                                    <label className="block text-[10px] text-white/25 mb-1">Resend API key <span className="text-red-400">*</span></label>
                                    <input type="password" placeholder="Your Resend API key" value={tgt.config.apiKey ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, apiKey: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                  </div>
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Recipient email <span className="text-red-400">*</span></label>
                                      <input type="email" placeholder="recipient@example.com" value={tgt.config.to ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, to: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                    </div>
                                    <div>
                                      <label className="block text-[10px] text-white/25 mb-1">Sender (optional)</label>
                                      <input type="email" placeholder="noreply@aston.ae" value={tgt.config.from ?? ""} onChange={(e) => setPublishingTargets((p) => ({ ...p, [key]: { ...p[key], config: { ...p[key].config, from: e.target.value } } }))} className="w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1.5 text-white text-xs placeholder:text-white/15 focus:outline-none focus:border-[#C9A84C]/40" />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div className="flex items-center gap-3 pt-2 border-t border-white/[0.05] mt-2">
                      <input
                        type="checkbox"
                        id="requireAllPass"
                        checked={requireAllPass}
                        onChange={(e) => setRequireAllPass(e.target.checked)}
                        className="w-3.5 h-3.5 accent-[#C9A84C]"
                      />
                      <label htmlFor="requireAllPass" className="text-xs text-white/40 cursor-pointer">
                        Publish only if all selected targets pass validation
                      </label>
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

                  {mode === "improve_existing" ? (
                    <div className="space-y-3">
                      {sourceText ? (
                        /* Post loaded — show summary + clear button */
                        <div className="flex items-center justify-between bg-white/[0.04] border border-[#C9A84C]/20 rounded-lg px-4 py-3">
                          <div>
                            <p className="text-sm text-white/70">{topic || "Post loaded"}</p>
                            <p className="text-[11px] text-white/30 mt-0.5">
                              {sourceText.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words · ready to improve
                            </p>
                          </div>
                          <button
                            onClick={() => { setSourceText(""); setTopic(""); }}
                            className="text-[11px] text-white/30 hover:text-white/60 transition-colors ml-4"
                          >
                            Change
                          </button>
                        </div>
                      ) : (
                        <WpPostPicker
                          onSelect={(title, content) => {
                            setTopic(title);
                            setSourceText(content);
                          }}
                        />
                      )}
                    </div>
                  ) : (
                    <>
                      {mode === "source_assisted" && (
                        <div className="mb-3">
                          <div className="flex gap-2">
                            <input
                              type="url"
                              value={sourceUrl}
                              onChange={(e) => {
                                setSourceUrl(e.target.value);
                                setFetchStatus("idle");
                                setFetchError("");
                              }}
                              onKeyDown={(e) => { if (e.key === "Enter") fetchSourceUrl(); }}
                              placeholder="Paste a URL to fetch content automatically…"
                              className="flex-1 bg-white/[0.04] border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] transition-all duration-200"
                            />
                            <button
                              onClick={fetchSourceUrl}
                              disabled={!sourceUrl.trim() || fetchStatus === "fetching"}
                              className="px-4 py-2.5 bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-30 disabled:cursor-not-allowed border border-white/10 rounded-lg text-white/70 text-sm transition-all duration-200 whitespace-nowrap"
                            >
                              {fetchStatus === "fetching" ? "Fetching…" : "Fetch"}
                            </button>
                          </div>
                          {fetchStatus === "error" && (
                            <p className="text-red-400 text-xs mt-1.5">{fetchError}</p>
                          )}
                          {fetchStatus === "done" && (
                            <p className="text-[#C9A84C]/70 text-xs mt-1.5">
                              Content fetched — {sourceText.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words extracted. You can edit below if needed.
                            </p>
                          )}
                          {fetchStatus === "idle" && sourceUrl.trim() === "" && (
                            <p className="text-white/20 text-xs mt-1.5">Or paste text directly below</p>
                          )}
                        </div>
                      )}
                      <textarea
                        value={sourceText}
                        onChange={(e) => { setSourceText(e.target.value); if (fetchStatus === "done") setFetchStatus("idle"); }}
                        placeholder={selectedMode.placeholder}
                        rows={8}
                        className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] resize-none transition-all duration-200"
                      />
                      <p className="text-white/20 text-xs mt-1.5">
                        {sourceText.trim().split(/\s+/).filter(Boolean).length.toLocaleString()} words pasted
                      </p>
                    </>
                  )}
                </div>
              )}

              {status === "error" && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              {/* Media outputs — selected once, generated automatically */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowMediaOptions((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-[#C9A84C]/30 transition-all duration-150 group"
                >
                  <div className="flex items-center gap-2.5">
                    <svg className="w-3.5 h-3.5 text-[#C9A84C]" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                    <span className="text-sm text-white/70 group-hover:text-white transition-colors">Media outputs</span>
                    <span className="text-xs text-white/30">
                      ({[autoMedia.video, autoMedia.audio, autoMedia.podcast].filter(Boolean).length} selected)
                    </span>
                  </div>
                  <svg className={`w-4 h-4 text-white/30 transition-transform duration-200 ${showMediaOptions ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showMediaOptions && (
                  <div className="mt-3 space-y-2 p-4 rounded-lg border border-white/[0.08] bg-white/[0.02]">
                    <p className="text-white/25 text-xs mb-3 leading-relaxed">
                      Generated automatically after the article is published. Video is uploaded to YouTube when rendering finishes.
                    </p>
                    {([
                      { key: "video"   as const, label: "YouTube video",    hint: "Script → scenes → narration → captions → uploads to YouTube" },
                      { key: "audio"   as const, label: "Read-aloud audio", hint: "Article narration attached to the WordPress post" },
                    ]).map(({ key, label, hint }) => (
                      <label key={key} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer select-none transition-colors ${autoMedia[key] ? "border-[#C9A84C]/20 bg-[#C9A84C]/[0.03]" : "border-white/[0.06]"}`}>
                        <input
                          type="checkbox"
                          checked={autoMedia[key]}
                          onChange={(e) => updateAutoMedia(key, e.target.checked)}
                          className="w-3.5 h-3.5 accent-[#C9A84C]"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white/80">{label}</p>
                          <p className="text-[10px] text-white/25">{hint}</p>
                        </div>
                      </label>
                    ))}
                    {/* Podcast row with inline length picker */}
                    <div className={`px-3 py-2.5 rounded-lg border transition-colors ${autoMedia.podcast ? "border-[#C9A84C]/20 bg-[#C9A84C]/[0.03]" : "border-white/[0.06]"}`}>
                      <label className="flex items-center gap-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={autoMedia.podcast}
                          onChange={(e) => updateAutoMedia("podcast", e.target.checked)}
                          className="w-3.5 h-3.5 accent-[#C9A84C]"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white/80">Podcast episode</p>
                          <p className="text-[10px] text-white/25">Two-voice conversation published to the Spotify RSS feed</p>
                        </div>
                      </label>
                      {autoMedia.podcast && (
                        <div className="flex gap-1.5 mt-2.5 ml-6">
                          {([3, 15, 30, 45, 60] as const).map((mins) => (
                            <button
                              key={mins}
                              type="button"
                              onClick={() => setPodcastLength(mins)}
                              className={`flex-1 py-1 rounded text-[11px] font-medium transition-all duration-150 ${podcastLength === mins ? "bg-[#C9A84C]/20 border border-[#C9A84C]/40 text-[#C9A84C]" : "bg-white/[0.04] border border-white/[0.08] text-white/40 hover:text-white/60"}`}
                            >
                              {mins} min
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <label className="flex items-center justify-between gap-3 mb-3 px-3 py-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] cursor-pointer">
                <span className="flex flex-col">
                  <span className="text-xs text-white/70 font-medium">Durable pipeline (default)</span>
                  <span className="text-[10px] text-white/35">Resumable — won&apos;t fail midway; saves a draft even if QA needs review. Turn off only to use the legacy pipeline.</span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useDurablePipeline}
                  onClick={() => toggleDurablePipeline(!useDurablePipeline)}
                  className={`relative shrink-0 w-10 h-5 rounded-full transition-colors duration-200 ${useDurablePipeline ? "bg-[#C9A84C]" : "bg-white/15"}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${useDurablePipeline ? "translate-x-5" : ""}`} />
                </button>
              </label>

              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="btn-gold w-full !py-3.5 tracking-wide"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
                </svg>
                Generate Post{useDurablePipeline ? "" : " (legacy)"}
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
            <div className="py-10 rise-in">
              <div className="panel px-7 py-8 space-y-8">
                <div className="flex justify-center">
                  <div className="relative w-16 h-16">
                    <div className="absolute inset-0 rounded-full border border-white/[0.06]" />
                    <div className="absolute inset-0 rounded-full border-t-2 border-gold animate-spin" />
                    <div className="absolute inset-3 rounded-full bg-gold/10 shadow-[0_0_24px_rgba(201,168,76,0.25)_inset]" />
                    <span className="absolute inset-0 flex items-center justify-center font-display text-gold text-lg">A</span>
                  </div>
                </div>
                <div className="space-y-3">
                  {STEPS.map((step, i) => (
                    <div key={step} className={`flex items-center gap-3 transition-all duration-500 ${i < stepIndex ? "opacity-40" : i === stepIndex ? "opacity-100" : "opacity-20"}`}>
                      {i < stepIndex ? (
                        <svg className="w-3.5 h-3.5 text-gold/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <div className={`w-1.5 h-1.5 mx-1 rounded-full flex-shrink-0 transition-colors duration-300 ${i === stepIndex ? "bg-gold animate-pulse shadow-[0_0_8px_rgba(201,168,76,0.7)]" : "bg-white/20"}`} />
                      )}
                      <p className={`text-sm ${i === stepIndex ? "text-white" : "text-white/50"}`}>{step}</p>
                    </div>
                  ))}
                </div>
                {retryMessage && (
                  <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-gold/10 border border-gold/20">
                    <div className="w-1.5 h-1.5 rounded-full bg-gold animate-pulse flex-shrink-0" />
                    <p className="text-xs text-gold/85">{retryMessage}</p>
                  </div>
                )}
                <p className="text-center text-white/25 text-xs">This takes about 3–4 minutes — the run keeps going even if this tab disconnects</p>
              </div>
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

              {result.needsReview && (
                <div className="rounded-lg px-4 py-3 border bg-amber-500/10 border-amber-500/30">
                  <p className="text-xs font-medium tracking-wide uppercase text-amber-400 mb-1">Saved as draft · needs review</p>
                  <p className="text-xs text-white/55 leading-relaxed">
                    The article was generated and saved, but these checks could not be auto-fixed. Review them in WordPress before publishing:
                  </p>
                  {result.failingChecks && result.failingChecks.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {result.failingChecks.map((c, i) => (
                        <li key={i} className="text-xs text-amber-300/80">• {c.replace(/_/g, " ")}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

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

                {/* Image generation status */}
                {imageGenStatus !== "idle" && (
                  <div className={`rounded-lg px-4 py-3 border ${
                    imageGenStatus === "error"
                      ? "bg-red-500/10 border-red-500/20"
                      : imageGenStatus === "done"
                      ? "bg-emerald-500/10 border-emerald-500/20"
                      : "bg-white/[0.04] border-white/10"
                  }`}>
                    <div className="flex items-center gap-3">
                      {imageGenStatus === "generating" && (
                        <svg className="w-3.5 h-3.5 text-[#C9A84C] animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4" strokeDashoffset="10" />
                        </svg>
                      )}
                      {imageGenStatus === "done" && <span className="text-emerald-400 text-sm shrink-0">✓</span>}
                      {imageGenStatus === "error" && <span className="text-red-400 text-sm shrink-0">✕</span>}
                      <p className={`text-xs ${
                        imageGenStatus === "error" ? "text-red-300/80"
                        : imageGenStatus === "done" ? "text-emerald-300/80"
                        : "text-white/50"
                      }`}>{imageGenMessage || "Generating images…"}</p>
                    </div>
                    {/* Flowchart preview */}
                    {flowchartUrl && imageGenStatus === "done" && (
                      <div className="mt-3 border-t border-white/[0.06] pt-3">
                        <p className="text-xs text-white/30 tracking-[0.12em] uppercase mb-2">Flowchart</p>
                        <a href={flowchartUrl} target="_blank" rel="noopener noreferrer" className="block">
                          <img
                            src={flowchartUrl}
                            alt="Generated flowchart diagram"
                            className="w-full rounded border border-white/10 bg-white"
                            style={{ maxHeight: "320px", objectFit: "contain" }}
                          />
                          <p className="text-[11px] text-white/25 mt-1.5">Click to open full size</p>
                        </a>
                      </div>
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
                      runLinkValidation([...result.linksUsed.internal, ...result.linksUsed.external], result);
                    }
                  }}
                  onLinkAction={handleLinkAction}
                />
              )}

              {/* Readiness Scorecard */}
              {(readinessStatus !== "idle") && (
                <ReadinessPanel
                  status={readinessStatus}
                  result={readinessResult}
                  onAutoFix={handleAutoFix}
                  isAutoFixing={isAutoFixing}
                  appliedFixes={appliedFixes}
                />
              )}

              {/* Publish to selected targets */}
              {Object.values(publishingTargets).some((t) => t.enabled) && publishStatus !== "done" && (
                <button
                  onClick={handlePublish}
                  disabled={publishStatus === "publishing"}
                  className="w-full flex items-center justify-center gap-2 bg-white/[0.06] hover:bg-white/[0.10] disabled:opacity-40 disabled:cursor-not-allowed border border-[#C9A84C]/30 hover:border-[#C9A84C]/60 text-[#C9A84C] font-medium text-sm py-3 rounded-lg transition-all duration-200"
                >
                  {publishStatus === "publishing" ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Sending to platforms…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
                      </svg>
                      Send to {Object.values(publishingTargets).filter((t) => t.enabled).length} platform{Object.values(publishingTargets).filter((t) => t.enabled).length > 1 ? "s" : ""} now
                    </>
                  )}
                </button>
              )}

              {/* Publish results */}
              {publishStatus === "done" && publishResults.length > 0 && (
                <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/[0.05]">
                    <p className="text-xs font-medium text-white/60 uppercase tracking-wide">Where your post was sent</p>
                    <p className="text-[10px] text-white/25 mt-0.5">Results from sending the article to each selected platform</p>
                  </div>
                  <div className="divide-y divide-white/[0.04]">
                    {publishResults.map((r) => (
                      <div key={r.target} className="px-4 py-3 flex items-center gap-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium shrink-0 ${r.status === "passed" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20" : r.status === "warning" ? "bg-amber-500/15 text-amber-400 border-amber-500/20" : "bg-red-500/15 text-red-400 border-red-500/20"}`}>
                          {r.status === "passed" ? "✓ Published" : r.status === "warning" ? "⚠ Published with warnings" : "✕ Failed"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-white/70 font-medium capitalize">{r.target}</p>
                          <p className="text-[10px] text-white/35 truncate">
                            {r.status === "passed"
                              ? r.message || "Post published successfully"
                              : r.status === "warning"
                              ? r.message || "Published but some settings may need attention"
                              : r.message || "Something went wrong — check your platform credentials and try again"}
                          </p>
                        </div>
                        {r.externalUrl && (
                          <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-[#C9A84C]/70 hover:text-[#C9A84C] transition-colors shrink-0">
                            View post →
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Queue for publishing */}
              {Object.values(publishingTargets).some((t) => t.enabled) && (
                <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden">
                  <button
                    onClick={() => setShowQueuePublish((v) => !v)}
                    className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <svg className="w-3.5 h-3.5 text-white/40" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="text-left">
                        <p className="text-xs font-medium text-white/60">Schedule for later</p>
                        <p className="text-[10px] text-white/25">Send to platforms at a specific time instead of right now</p>
                      </div>
                    </div>
                    <svg className={`w-3 h-3 text-white/20 transition-transform ${showQueuePublish ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {showQueuePublish && (
                    <div className="px-4 pb-4 pt-1 border-t border-white/[0.05] space-y-3">
                      {queuePublishStatus === "added" ? (
                        <div className="flex items-center gap-2.5 py-2">
                          <div className="w-5 h-5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
                            <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                          <div>
                            <p className="text-xs text-emerald-400 font-medium">Scheduled successfully</p>
                            <p className="text-[10px] text-white/30 mt-0.5">
                              Your post will be sent to the selected platforms{queueScheduledFor ? ` on ${new Date(queueScheduledFor).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : " within the next hour"}.
                            </p>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-[10px] text-white/25 leading-relaxed">
                            Choose a date and time below, then click the button to schedule. Your post will automatically be sent to the {Object.values(publishingTargets).filter(t => t.enabled).length} selected platform{Object.values(publishingTargets).filter(t => t.enabled).length > 1 ? "s" : ""} at that time. Leave the time blank to send on the next automated run (within the hour).
                          </p>
                          <div>
                            <label className="block text-[10px] text-white/30 mb-1.5">Send at (optional)</label>
                            <input
                              type="datetime-local"
                              value={queueScheduledFor}
                              onChange={(e) => setQueueScheduledFor(e.target.value)}
                              className="bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40 transition-colors w-full sm:w-auto"
                            />
                          </div>

                          {/* Also share on social — cross-posts after the blog goes live */}
                          <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3 space-y-2.5">
                            <p className="text-[10px] uppercase tracking-[0.18em] text-[#C9A84C]/70">Also share on social</p>
                            <div className="flex flex-wrap gap-2">
                              {(["mastodon", "bluesky", "linkedin"] as const).map((p) => (
                                <label key={p} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border cursor-pointer text-[11px] capitalize transition-colors ${socialShare[p] ? "border-[#C9A84C]/50 text-[#C9A84C] bg-[#C9A84C]/[0.06]" : "border-white/10 text-white/45"}`}>
                                  <input type="checkbox" className="accent-[#C9A84C] w-3 h-3" checked={socialShare[p]} onChange={(e) => setSocialShare((s) => ({ ...s, [p]: e.target.checked }))} />
                                  {p}
                                </label>
                              ))}
                              {(socialShare.mastodon || socialShare.bluesky) && (
                                <button
                                  type="button"
                                  onClick={handleGenerateSocialCaptions}
                                  disabled={socialGenStatus === "generating"}
                                  className="text-[11px] px-2.5 py-1 rounded-full border border-white/10 text-white/60 hover:text-white hover:border-white/25 disabled:opacity-40 transition-colors"
                                >
                                  {socialGenStatus === "generating" ? "Writing…" : "Generate captions"}
                                </button>
                              )}
                            </div>
                            {(["mastodon", "bluesky", "linkedin"] as const)
                              .filter((p) => socialShare[p] && socialCaptions[p] !== undefined)
                              .map((p) => (
                                <textarea
                                  key={p}
                                  value={socialCaptions[p] ?? ""}
                                  onChange={(e) => setSocialCaptions((c) => ({ ...c, [p]: e.target.value }))}
                                  className="w-full bg-black/30 border border-white/10 rounded-md px-2.5 py-2 text-[11px] text-white/80 focus:outline-none focus:border-[#C9A84C]/40 min-h-[52px] resize-y"
                                  placeholder={`${p} caption`}
                                />
                              ))}
                            {socialGenStatus === "error" && <p className="text-[10px] text-red-400">Caption generation failed — you can still schedule; the excerpt will be used.</p>}
                            {(socialShare.mastodon || socialShare.bluesky) && (
                              <p className="text-[10px] text-white/25">Posts fire automatically once the blog is published. Captions left blank fall back to the excerpt.</p>
                            )}
                          </div>

                          {queuePublishStatus === "error" && (
                            <div className="flex items-center gap-2 rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2">
                              <svg className="w-3.5 h-3.5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                              </svg>
                              <p className="text-xs text-red-400">Could not schedule — please check your connection and try again.</p>
                            </div>
                          )}
                          <button
                            onClick={handleQueuePublish}
                            disabled={queuePublishStatus === "adding"}
                            className="flex items-center gap-2 text-[11px] px-3 py-1.5 rounded border border-[#C9A84C]/30 text-[#C9A84C]/80 hover:text-[#C9A84C] hover:border-[#C9A84C]/60 disabled:opacity-40 transition-colors"
                          >
                            {queuePublishStatus === "adding" ? (
                              <>
                                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                                Scheduling…
                              </>
                            ) : (
                              <>
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                Schedule this post
                              </>
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <a href={result.editUrl} target="_blank" rel="noopener noreferrer"
                  className="btn-gold !py-3">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  Edit in WordPress
                </a>
                <div className="relative">
                  <a href={result.previewUrl} target="_blank" rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 bg-white/[0.05] hover:bg-white/[0.08] border border-white/10 text-white/70 hover:text-white text-sm py-3 rounded-lg transition-all duration-200 w-full">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                    {result.needsReview ? "Preview Draft" : "View Post"}
                  </a>
                  {wpSyncStatus === "syncing" && (
                    <p className="text-[10px] text-amber-400/70 text-center mt-1">Saving changes to WordPress…</p>
                  )}
                  {wpSyncStatus === "synced" && (
                    <p className="text-[10px] text-emerald-400/70 text-center mt-1">✓ WordPress updated — safe to preview</p>
                  )}
                  {wpSyncStatus === "error" && (
                    <p className="text-[10px] text-red-400/70 text-center mt-1">⚠ WordPress sync failed — edit manually in wp-admin</p>
                  )}
                </div>
              </div>

              {/* Delete post */}
              {deleteState !== "deleted" && (
                <div className="space-y-2">
                  {deleteState === "idle" && (
                    <button
                      onClick={() => setDeleteState("confirming")}
                      className="w-full flex items-center justify-center gap-2 bg-transparent hover:bg-red-500/10 border border-white/20 hover:border-red-500/40 text-white/50 hover:text-red-400 text-sm py-2.5 rounded-lg transition-all duration-200"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Delete this post
                    </button>
                  )}

                  {deleteState === "confirming" && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/[0.04] px-4 py-3 space-y-3">
                      <p className="text-xs text-red-400 font-medium">Delete this post and all 4 images permanently?</p>
                      <p className="text-[11px] text-white/35">This cannot be undone. The draft and its media files will be removed from WordPress.</p>
                      <div className="flex gap-2">
                        <button
                          onClick={handleDeletePost}
                          className="flex-1 bg-red-500/80 hover:bg-red-500 text-white text-xs font-semibold py-2 rounded-lg transition-colors"
                        >
                          Yes, delete everything
                        </button>
                        <button
                          onClick={() => setDeleteState("idle")}
                          className="flex-1 bg-white/[0.05] hover:bg-white/[0.08] text-white/50 text-xs font-medium py-2 rounded-lg transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {deleteState === "deleting" && (
                    <div className="flex items-center justify-center gap-2 py-2.5">
                      <svg className="w-3.5 h-3.5 text-red-400 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <p className="text-xs text-red-400/70">Deleting post and images…</p>
                    </div>
                  )}

                  {deleteState === "error" && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/[0.04] px-4 py-3 space-y-2">
                      <p className="text-xs text-red-400">{deleteError || "Delete failed — try again or remove manually in WordPress."}</p>
                      <button
                        onClick={() => setDeleteState("idle")}
                        className="text-[11px] text-white/30 hover:text-white/60 transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              )}

              {deleteState === "deleted" && (
                <div className="flex items-center justify-center gap-2 py-2.5">
                  <span className="text-emerald-400 text-xs">✓</span>
                  <p className="text-xs text-emerald-400/70">Post and images deleted. Resetting…</p>
                </div>
              )}

              {/* Video generation */}
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
                <div className="px-4 py-3 border-b border-white/[0.05] flex items-center gap-2">
                  <svg className="w-4 h-4 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  <p className="text-xs font-medium text-white/50 uppercase tracking-wide">Video</p>
                </div>
                <div className="px-4 py-4 space-y-4">

                  {/* Idle — generate button */}
                  {videoStatus === "idle" && (
                    <button
                      onClick={handleGenerateVideo}
                      className="w-full flex items-center justify-center gap-2 bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 hover:border-white/20 text-white/60 hover:text-white/90 text-sm py-3 rounded-lg transition-all duration-200"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z" />
                      </svg>
                      Generate video for this post
                    </button>
                  )}

                  {/* Generating — progress + elapsed */}
                  {videoStatus === "generating" && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-white/50">{videoProgress || "Preparing…"}</p>
                        <p className="text-xs text-white/30 tabular-nums">{videoElapsed}s</p>
                      </div>
                      <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#C9A84C] rounded-full transition-all duration-1000 ease-linear"
                          style={{ width: `${Math.min(videoElapsed / 150 * 90, 90)}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-white/20">Generating scenes and images (~2 min)</p>
                    </div>
                  )}

                  {/* Rendering on Shotstack — pulsing bar */}
                  {videoStatus === "rendering" && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <svg className="w-3.5 h-3.5 text-[#C9A84C] animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4" strokeDashoffset="10" />
                        </svg>
                        <p className="text-sm text-white/50">{videoProgress || "Rendering video…"}</p>
                      </div>
                      <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                        <div className="h-full bg-[#C9A84C] rounded-full animate-pulse" style={{ width: "60%" }} />
                      </div>
                      <p className="text-[10px] text-white/20">Shotstack typically renders in 2–5 min · checking every 12s</p>
                    </div>
                  )}

                  {/* Ready — video preview + upload button */}
                  {(videoStatus === "ready" || videoStatus === "uploading" || videoStatus === "uploaded") && (videoUrl || videoBase64) && (
                    <div className="space-y-3">
                      <video
                        src={videoUrl ?? `data:${videoMime};base64,${videoBase64}`}
                        controls
                        loop
                        className="w-full rounded-lg aspect-video bg-black"
                      />

                      {videoStatus === "ready" && (
                        <button
                          onClick={handleUploadToYouTube}
                          className="w-full flex items-center justify-center gap-2 bg-red-600/20 hover:bg-red-600/30 border border-red-500/30 hover:border-red-500/50 text-red-400 hover:text-red-300 text-sm py-2.5 rounded-lg transition-all duration-200"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
                          </svg>
                          Upload to YouTube
                        </button>
                      )}

                      {videoStatus === "uploading" && (
                        <div className="flex items-center justify-center gap-2 py-2">
                          <svg className="w-4 h-4 animate-spin text-red-400" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          <p className="text-sm text-white/40">Uploading to YouTube…</p>
                        </div>
                      )}

                      {videoStatus === "uploaded" && youtubeUrl && (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <div className="w-3.5 h-3.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
                              <svg className="w-2 h-2 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                            <p className="text-xs text-white/50">Uploaded · saved to WordPress</p>
                          </div>
                          <a href={youtubeUrl} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-[#C9A84C]/70 hover:text-[#C9A84C] transition-colors font-mono break-all">
                            {youtubeUrl}
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Error */}
                  {videoStatus === "error" && (
                    <div className="space-y-2">
                      <p className="text-sm text-red-400/80">{videoProgress || "Video generation failed."}</p>
                      <button onClick={handleGenerateVideo} className="text-xs text-white/40 hover:text-white/70 transition-colors">
                        Try again
                      </button>
                    </div>
                  )}

                </div>
              </div>

              {/* ── Audio section ─────────────────────────────── */}
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] overflow-hidden">
                <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 text-[#C9A84C]/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                  </svg>
                  <p className="text-xs font-medium text-white/50 uppercase tracking-wide">Audio</p>
                </div>
                <div className="px-4 py-4 space-y-4">

                  {/* Idle — generate button */}
                  {audioStatus === "idle" && (
                    <button
                      onClick={handleGenerateAudio}
                      disabled={!result?.postId}
                      className="w-full flex items-center justify-center gap-2 bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 hover:border-white/20 text-white/60 hover:text-white/90 text-sm py-3 rounded-lg transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                      </svg>
                      Generate audio for this post
                    </button>
                  )}

                  {/* Generating — progress bar + status */}
                  {audioStatus === "generating" && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-white/50">{audioProgress || "Generating…"}</p>
                        <p className="text-xs text-white/30 tabular-nums">{audioElapsed}s</p>
                      </div>
                      {/* Estimated ~60s — bar fills linearly then holds at 95% */}
                      <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#C9A84C] rounded-full transition-all duration-1000 ease-linear"
                          style={{ width: `${Math.min(audioElapsed / 60 * 95, 95)}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-white/20">ElevenLabs typically takes 30–90 seconds</p>
                    </div>
                  )}

                  {/* Done — inline audio player + WordPress link */}
                  {audioStatus === "done" && audioUrl && (
                    <div className="space-y-3">
                      <audio controls src={audioUrl} className="w-full h-10 rounded-lg" />
                      <div className="flex items-center gap-2">
                        <div className="w-3.5 h-3.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
                          <svg className="w-2 h-2 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <p className="text-xs text-white/50">Saved to WordPress ACF <code className="text-white/30">audio_url</code></p>
                      </div>
                      <a href={audioUrl} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-[#C9A84C]/70 hover:text-[#C9A84C] transition-colors font-mono break-all">
                        {audioUrl}
                      </a>
                    </div>
                  )}

                  {/* Error */}
                  {audioStatus === "error" && (
                    <div className="space-y-2">
                      <p className="text-sm text-red-400/80">{audioProgress || "Audio generation failed."}</p>
                      <button onClick={handleGenerateAudio} className="text-xs text-white/40 hover:text-white/70 transition-colors">
                        Try again
                      </button>
                    </div>
                  )}

                </div>
              </div>

              {/* Podcast — conversational two-voice episode for Spotify */}
              <div className="border border-white/[0.07] rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                  <svg className="w-4 h-4 text-white/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                  </svg>
                  <p className="text-xs font-medium text-white/50 uppercase tracking-wide">Podcast (Spotify)</p>
                </div>
                <div className="px-4 py-4 space-y-4">
                  {podcastStatus === "idle" && (
                    <>
                      <div className="flex gap-1.5">
                        {([15, 30, 45, 60] as const).map((mins) => (
                          <button
                            key={mins}
                            onClick={() => setPodcastLength(mins)}
                            className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-all duration-150 ${podcastLength === mins ? "bg-[#C9A84C]/20 border border-[#C9A84C]/40 text-[#C9A84C]" : "bg-white/[0.04] border border-white/[0.08] text-white/40 hover:text-white/60"}`}
                          >
                            {mins} min
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={handleGeneratePodcast}
                        disabled={!result?.postId}
                        className="w-full flex items-center justify-center gap-2 bg-white/[0.05] hover:bg-white/[0.09] border border-white/10 hover:border-white/20 text-white/60 hover:text-white/90 text-sm py-3 rounded-lg transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Generate {podcastLength}-min episode
                      </button>
                      <p className="text-[10px] text-white/20">Two AI voices (host + expert) with a music intro/outro. Creates a published episode in the Podcasts post type, served on the Spotify feed.</p>
                    </>
                  )}

                  {podcastStatus === "generating" && (
                    <div className="space-y-3">
                      <p className="text-sm text-white/50">{podcastProgress || "Generating…"}</p>
                      <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                        <div className="h-full bg-[#C9A84C] rounded-full animate-pulse" style={{ width: "60%" }} />
                      </div>
                      <p className="text-[10px] text-white/20">Writing the dialogue, voicing both speakers, and stitching the music — a couple of minutes.</p>
                    </div>
                  )}

                  {podcastStatus === "done" && podcastUrl && (
                    <div className="space-y-3">
                      <audio controls src={podcastUrl} className="w-full h-10 rounded-lg" />
                      <div className="flex items-center gap-2">
                        <div className="w-3.5 h-3.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0">
                          <svg className="w-2 h-2 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <p className="text-xs text-white/50">Published as an episode in the Podcasts post type — it&apos;s now in the Spotify feed.</p>
                      </div>
                    </div>
                  )}

                  {podcastStatus === "error" && (
                    <div className="space-y-2">
                      <p className="text-sm text-red-400/80">{podcastProgress || "Podcast generation failed."}</p>
                      <button onClick={handleGeneratePodcast} className="text-xs text-white/40 hover:text-white/70 transition-colors">
                        Try again
                      </button>
                    </div>
                  )}
                </div>
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
