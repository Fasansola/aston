"use client";

import React, { useState, useEffect, useRef } from "react";
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
  articleHtml?: string;
  excerpt?: string;
  tags?: string[];
  metaDescription?: string;
  language?: string | null;
  editUrl: string;
  previewUrl: string;
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

  const hasAutoFixes = result.subscores.some((s) => s.autoFixAvailable);
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
  const [status, setStatus]         = useState<Status>("idle");
  const [stepIndex, setStepIndex]   = useState(0);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [result, setResult]         = useState<GenerateResult | null>(null);
  const [error, setError]           = useState("");

  const [customPrompt, setCustomPrompt] = useState("");

  // Strategy inputs
  const [showStrategy, setShowStrategy]             = useState(false);
  const [audience, setAudience]                     = useState("");
  const [primaryCountry, setPrimaryCountry]         = useState("");
  const [secondaryCountries, setSecondaryCountries] = useState("");
  const [priorityService, setPriorityService]       = useState("");
  const [language, setLanguage]                     = useState("");
  const [siteLanguages, setSiteLanguages]           = useState<{ code: string; name: string }[]>([]);
  const [imageModel, setImageModel]                 = useState<"imagen-4" | "gpt-image-1">("imagen-4");

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
  const canGenerate  = (!!topic.trim() || !!customPrompt.trim()) && !!audience.trim() && (!needsSource || !!sourceText.trim());

  const handleGenerate = async () => {
    if (!canGenerate || status === "loading") return;
    setStatus("loading");
    setResult(null);
    setError("");
    setRetryMessage(null);
    const interval = startStepCycle();

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        }),
      });

      // Validation errors (400/401) come back as plain JSON before the stream starts
      if (!res.ok) {
        let errMsg = "Generation failed. Please try again.";
        try { errMsg = (await res.json()).error || errMsg; } catch { errMsg = await res.text().catch(() => errMsg); }
        throw new Error(errMsg);
      }

      // Read SSE stream
      const reader  = res.body!.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";
      let   completed = false;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const dataLine = part.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }

          if (event.type === "qa_retry") {
            setRetryMessage(`QA check didn't pass — rewriting content (attempt ${event.attempt}/${event.max})...`);
          } else if (event.type === "tech_retry") {
            const reason = event.reason ? ` (${String(event.reason).slice(0, 120)})` : "";
            setRetryMessage(`Technical issue — retrying (attempt ${event.attempt}/${event.max})...${reason}`);
          } else if (event.type === "done") {
            clearInterval(interval);
            setRetryMessage(null);
            const data = event as unknown as GenerateResult;
            setResult(data);
            setStatus("success");
            completed = true;
            if ((event.linksUsed as GenerateResult["linksUsed"])) {
              runLinkValidation([
                ...(event.linksUsed as GenerateResult["linksUsed"]).internal,
                ...(event.linksUsed as GenerateResult["linksUsed"]).external,
              ], data);
            }
            return;
          } else if (event.type === "error") {
            completed = true;
            throw new Error(String(event.message) || "Generation failed. Please try again.");
          }
        }
      }

      // Stream closed without a done/error event — server likely timed out
      if (!completed) {
        throw new Error("The server took too long to respond. Please try again.");
      }
    } catch (err: unknown) {
      clearInterval(interval);
      setRetryMessage(null);
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("error");
    }
  };

  const handleQueuePublish = async () => {
    if (!result?.articleHtml || queuePublishStatus === "adding") return;
    const selectedTargets = Object.entries(publishingTargets)
      .filter(([, v]) => v.enabled)
      .map(([target, v]) => ({ target, config: v.config }));
    if (selectedTargets.length === 0) return;

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
      // silently fail — user can retry
    } finally {
      setIsAutoFixing(false);
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

    // Helpers to update link in articleHtml
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replaceHref = (html: string, oldUrl: string, updatedUrl: string) =>
      html.replace(new RegExp(`href=["']${escapeRegex(oldUrl)}["']`, "g"), `href="${updatedUrl}"`);
    const removeLink = (html: string, url: string) =>
      html.replace(new RegExp(`<a[^>]+href=["']${escapeRegex(url)}["'][^>]*>(.*?)</a>`, "gs"), "$1");

    if (action === "remove") {
      if (!result) return;
      const updatedHtml = removeLink(result.articleHtml ?? "", issue.url);
      const updatedResult = { ...result, articleHtml: updatedHtml };
      setResult(updatedResult);
      // Remove this issue from validation state
      setLinkValidation((prev) => {
        if (!prev) return prev;
        const issues = prev.issues.filter((i) => i.id !== issue.id);
        const internals = issues.filter((i) => i.type === "internal");
        const externals = issues.filter((i) => i.type === "external");
        const count = (arr: LinkIssue[], s: string) => arr.filter((i) => i.status === s).length;
        const hasBlocking = issues.some((i) => i.blocking && i.status === "failed");
        const hasWarnings = issues.some((i) => i.status === "warning");
        return {
          ...prev,
          issues,
          canPublish: !hasBlocking,
          overallStatus: hasBlocking ? "failed" : hasWarnings ? "warning" : "passed",
          summary: {
            internal: { passed: count(internals, "passed"), warning: count(internals, "warning"), failed: count(internals, "failed") },
            external: { passed: count(externals, "passed"), warning: count(externals, "warning"), failed: count(externals, "failed") },
          },
        };
      });
      return;
    }

    if (action === "auto_fix" && newUrl) {
      if (!result) return;
      const updatedHtml = replaceHref(result.articleHtml ?? "", issue.url, newUrl);
      setResult({ ...result, articleHtml: updatedHtml });
      // Mark issue as passed with updated URL
      setLinkValidation((prev) => {
        if (!prev) return prev;
        const issues = prev.issues.map((i) =>
          i.id === issue.id ? { ...i, url: newUrl, status: "passed" as const, problem: null, suggestedFix: null, blocking: false, actions: ["recheck" as const] } : i
        );
        const internals = issues.filter((i) => i.type === "internal");
        const externals = issues.filter((i) => i.type === "external");
        const count = (arr: LinkIssue[], s: string) => arr.filter((i) => i.status === s).length;
        const hasBlocking = issues.some((i) => i.blocking && i.status === "failed");
        const hasWarnings = issues.some((i) => i.status === "warning");
        return {
          ...prev,
          issues,
          canPublish: !hasBlocking,
          overallStatus: hasBlocking ? "failed" : hasWarnings ? "warning" : "passed",
          summary: {
            internal: { passed: count(internals, "passed"), warning: count(internals, "warning"), failed: count(internals, "failed") },
            external: { passed: count(externals, "passed"), warning: count(externals, "warning"), failed: count(externals, "failed") },
          },
        };
      });
      return;
    }

    if (action === "edit" && newUrl) {
      if (!result) return;
      const updatedHtml = replaceHref(result.articleHtml ?? "", issue.url, newUrl);
      setResult({ ...result, articleHtml: updatedHtml });
      // Recheck just this link with the new URL
      try {
        const res = await fetch("/api/validate-links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ links: [{ anchor: issue.anchorText, url: newUrl }] }),
        });
        const data = await res.json();
        const recheckResult: LinkIssue | undefined = data.validation?.issues?.[0];
        if (!recheckResult) return;
        setLinkValidation((prev) => {
          if (!prev) return prev;
          const issues = prev.issues.map((i) => i.id === issue.id ? { ...recheckResult, id: issue.id } : i);
          const internals = issues.filter((i) => i.type === "internal");
          const externals = issues.filter((i) => i.type === "external");
          const count = (arr: LinkIssue[], s: string) => arr.filter((i) => i.status === s).length;
          const hasBlocking = issues.some((i) => i.blocking && i.status === "failed");
          const hasWarnings = issues.some((i) => i.status === "warning");
          return {
            ...prev,
            issues,
            canPublish: !hasBlocking,
            overallStatus: hasBlocking ? "failed" : hasWarnings ? "warning" : "passed",
            summary: {
              internal: { passed: count(internals, "passed"), warning: count(internals, "warning"), failed: count(internals, "failed") },
              external: { passed: count(externals, "passed"), warning: count(externals, "warning"), failed: count(externals, "failed") },
            },
          };
        });
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
        setLinkValidation((prev) => {
          if (!prev) return prev;
          const issues = prev.issues.map((i) => i.id === issue.id ? { ...recheckResult, id: issue.id } : i);
          const internals = issues.filter((i) => i.type === "internal");
          const externals = issues.filter((i) => i.type === "external");
          const count = (arr: LinkIssue[], s: string) => arr.filter((i) => i.status === s).length;
          const hasBlocking = issues.some((i) => i.blocking && i.status === "failed");
          const hasWarnings = issues.some((i) => i.status === "warning");
          return {
            ...prev,
            issues,
            canPublish: !hasBlocking,
            overallStatus: hasBlocking ? "failed" : hasWarnings ? "warning" : "passed",
            summary: {
              internal: { passed: count(internals, "passed"), warning: count(internals, "warning"), failed: count(internals, "failed") },
              external: { passed: count(externals, "passed"), warning: count(externals, "warning"), failed: count(externals, "failed") },
            },
          };
        });
      } catch { /* silently fail */ }
      return;
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
  };

  if (isAuthed === null) return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="w-2 h-2 rounded-full bg-[#C9A84C] animate-pulse" />
    </div>
  );

  if (isAuthed === false) return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <form onSubmit={handleLogin} className="w-80 flex flex-col gap-4">
        <div className="text-center mb-2">
          <p className="text-white/40 text-sm mt-1">Enter your password to continue</p>
        </div>
        <input
          ref={loginRef}
          type="password"
          value={loginPw}
          onChange={e => setLoginPw(e.target.value)}
          placeholder="Password"
          className="w-full bg-white/[0.06] border border-white/10 rounded-lg px-4 py-3 text-white placeholder:text-white/25 focus:outline-none focus:border-[#C9A84C]/50 text-sm"
        />
        {loginError && <p className="text-red-400 text-xs text-center">{loginError}</p>}
        <button
          type="submit"
          className="w-full bg-[#C9A84C] hover:bg-[#b8963e] text-black font-medium rounded-lg py-3 text-sm transition-colors"
        >
          Sign in
        </button>
      </form>
    </div>
  );

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

              {/* Custom prompt */}
              <div>
                <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">
                  Custom prompt <span className="text-white/20 normal-case tracking-normal">(optional if topic set)</span>
                </label>
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="e.g. I need a post about the German crypto market, what is legal and what is not, and how Aston VIP can help"
                  rows={3}
                  className="w-full bg-white/[0.04] border border-white/10 rounded-lg px-4 py-3 text-white text-sm placeholder:text-white/20 focus:outline-none focus:border-[#C9A84C]/50 focus:bg-white/[0.06] resize-none transition-all duration-200"
                />
                <p className="text-white/20 text-xs mt-2">Use alone to let AI derive the title, or alongside a topic for extra guidance</p>
              </div>

              {/* Topic */}
              <div>
                <label className="block text-xs text-white/40 tracking-[0.15em] uppercase mb-3">
                  Blog topic <span className="text-white/20 normal-case tracking-normal">(optional if custom prompt set)</span>
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
                          onChange={(e) => setImageModel(e.target.value as "imagen-4" | "gpt-image-1")}
                          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-3 py-2 text-white text-xs focus:outline-none focus:border-[#C9A84C]/40 transition-colors appearance-none"
                        >
                          <option value="imagen-4" className="bg-[#1a1a1a]">Imagen 4 (Google)</option>
                          <option value="gpt-image-1" className="bg-[#1a1a1a]">GPT-image-1 (OpenAI)</option>
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
              {retryMessage && (
                <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-[#C9A84C]/10 border border-[#C9A84C]/20">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#C9A84C] animate-pulse flex-shrink-0" />
                  <p className="text-xs text-[#C9A84C]/80">{retryMessage}</p>
                </div>
              )}
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
