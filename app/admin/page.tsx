"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

type QueueStatus = "queued" | "processing" | "completed" | "failed" | "paused";
type GenerationMode = "topic_only" | "source_assisted" | "improve_existing" | "notes_to_article";
type TopicPlanStatus = "idea" | "planned" | "approved" | "queued" | "archived";
type PerformanceClass = "high" | "medium" | "low" | "unknown";

interface QueueItem {
  id: string; topic: string; mode: GenerationMode; priority: number;
  status: QueueStatus; createdAt: string; completedAt: string | null;
  retryCount: number; lastError: string | null;
  wpPostId: number | null; wpEditUrl: string | null; wpPostUrl: string | null;
  qaScore: number | null; qaWarnings: string[];
  scheduledFor?: string | null;
  progress?: { step: number; total: number; label: string; updatedAt: string } | null;
  mediaOutputs?: { audio: boolean; video: boolean; podcast: boolean };
  podcastLength?: number;
}
interface QueueStats {
  total: number; queued: number; processing: number;
  completed: number; failed: number; paused: number; completedToday: number;
}
interface SchedulerSettings {
  enabled: boolean; blogsPerDay: number; publishMode: "draft_only";
  maxRetries: number; blockOnQaWarning: boolean; maxPerRun: number;
  runHour: number; imageModel: "imagen-4" | "gpt-image-2";
  mediaOutputs: { audio: boolean; video: boolean; podcast: boolean };
  podcastLength: number;
}
interface RunLog {
  runId: string; startedAt: string; completedAt: string | null;
  topicsAttempted: number; topicsCompleted: number; topicsFailed: number;
  status: "running" | "completed" | "completed_with_errors" | "failed";
}
interface LinkEntry {
  id: string; url: string; title: string; type: "internal" | "external";
  category: string; keywords: string[]; anchors: string[]; status: "active" | "inactive";
  language?: string;
}
interface TopicPlan {
  id: string; topic: string; focusKeyword: string; cluster: string;
  intent: string; priority: number; status: TopicPlanStatus; notes: string;
  createdAt: string; queuedAt: string | null;
  audience?: string; primary_country?: string; secondary_countries?: string;
  priority_service?: string; language?: string;
}
interface PostPerformance {
  postId: string; topic: string; url: string; focusKeyword: string; cluster: string;
  publishedDate: string; lastSyncedAt: string;
  impressions: number; clicks: number; avgPosition: number; ctr: number;
  pageviews: number; sessions: number; avgTimeOnPage: number; bounceRate: number;
  classification: PerformanceClass;
}
type PublishQueueStatus = "queued" | "processing" | "published" | "failed" | "paused";
interface PublishQueueTarget { target: string; config: Record<string, string>; }
interface PublishQueueResult { target: string; ok: boolean; status: "passed"|"warning"|"failed"; message: string; externalUrl?: string; }
interface PublishQueueItem {
  id: string; title: string; slug: string; excerpt: string; tags: string[];
  seoTitle: string; metaDescription: string; canonicalUrl?: string;
  wordCount?: number; wpPostId?: number;
  status: PublishQueueStatus; targets: PublishQueueTarget[];
  scheduledFor: string | null; createdAt: string; processedAt: string | null;
  retryCount: number; lastError: string | null; results: PublishQueueResult[];
}
interface PublishQueueStats {
  total: number; queued: number; processing: number;
  published: number; failed: number; paused: number;
}
interface PostHistoryEntry {
  id: string; wpPostId: number; title: string; slug?: string; focusKeyword?: string;
  wpEditUrl: string; wpPostUrl: string | null;
  source: "scheduler" | "manual"; needsReview?: boolean; createdAt: string;
  mediaOutputs?: { audio: boolean; video: boolean; podcast: boolean };
}

// ── Status maps ────────────────────────────────────────────────

const Q_STATUS: Record<QueueStatus, { dot: string; badge: string; label: string }> = {
  queued:     { dot: "bg-blue-400",            badge: "bg-blue-500/10 text-blue-300 ring-blue-500/25",     label: "Queued" },
  processing: { dot: "bg-amber-400 animate-pulse", badge: "bg-amber-500/10 text-amber-300 ring-amber-500/25", label: "Processing" },
  completed:  { dot: "bg-emerald-500",         badge: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25", label: "Completed" },
  failed:     { dot: "bg-red-500",             badge: "bg-red-500/10 text-red-300 ring-red-500/25",        label: "Failed" },
  paused:     { dot: "bg-white/15",            badge: "bg-white/[0.07] text-white/55 ring-white/15",    label: "Paused" },
};
const RUN_STATUS: Record<RunLog["status"], string> = {
  running:               "bg-amber-500/10 text-amber-300 ring-amber-500/25",
  completed:             "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25",
  completed_with_errors: "bg-orange-500/10 text-orange-300 ring-orange-500/25",
  failed:                "bg-red-500/10 text-red-300 ring-red-500/25",
};
const TOPIC_STATUS: Record<TopicPlanStatus, { badge: string; label: string }> = {
  idea:     { badge: "bg-white/[0.07] text-white/55 ring-white/15",      label: "Idea" },
  planned:  { badge: "bg-blue-500/10 text-blue-300 ring-blue-500/25",       label: "Planned" },
  approved: { badge: "bg-violet-500/10 text-violet-300 ring-violet-500/25", label: "Approved" },
  queued:   { badge: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25", label: "Queued" },
  archived: { badge: "bg-white/[0.03] text-white/35 ring-white/15",       label: "Archived" },
};
const PQ_STATUS: Record<PublishQueueStatus, { dot: string; badge: string; label: string; bar: string }> = {
  queued:     { dot: "bg-blue-500",            badge: "bg-blue-500/10 text-blue-300 ring-blue-500/25",      label: "Scheduled",  bar: "bg-blue-500" },
  processing: { dot: "bg-amber-400 animate-pulse", badge: "bg-amber-500/10 text-amber-300 ring-amber-500/25", label: "Publishing", bar: "bg-amber-400" },
  published:  { dot: "bg-emerald-500",         badge: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25", label: "Published",  bar: "bg-emerald-500" },
  failed:     { dot: "bg-red-500",             badge: "bg-red-500/10 text-red-300 ring-red-500/25",         label: "Failed",     bar: "bg-red-500" },
  paused:     { dot: "bg-white/15",            badge: "bg-white/[0.07] text-white/55 ring-white/15",     label: "Paused",     bar: "bg-white/15" },
};
const PERF_STATUS: Record<PerformanceClass, { badge: string; label: string }> = {
  high:    { badge: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25", label: "High" },
  medium:  { badge: "bg-amber-500/10 text-amber-300 ring-amber-500/25",       label: "Medium" },
  low:     { badge: "bg-red-500/10 text-red-300 ring-red-500/25",             label: "Low" },
  unknown: { badge: "bg-white/[0.07] text-white/45 ring-white/15",         label: "—" },
};

// ── Shared components ──────────────────────────────────────────

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}>
      {children}
    </span>
  );
}

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} onClick={onChange} disabled={disabled}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-gold/50 disabled:opacity-50 ${checked ? "bg-gold" : "bg-white/15"}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
      className={`block w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition ${className}`} />
  );
}

function Select({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select {...props}
      className={`block rounded-lg border border-white/10 bg-ink-2 px-3 py-2.5 text-sm text-white/85 focus:border-gold/55 focus:outline-none focus:ring-2 focus:ring-gold/15 transition ${className}`}>
      {children}
    </select>
  );
}

function Btn({ variant = "primary", size = "md", className = "", disabled, children, onClick, type = "button" }:
  { variant?: "primary"|"secondary"|"danger"|"ghost"|"success"; size?: "sm"|"md"|"lg"; className?: string; disabled?: boolean; children: React.ReactNode; onClick?: () => void; type?: "button"|"submit"|"reset" }) {
  const base = "inline-flex items-center justify-center font-medium rounded-lg transition-all focus:outline-none focus:ring-2 disabled:opacity-50 disabled:cursor-not-allowed select-none";
  const sizes = { sm: "px-3 py-1.5 text-xs gap-1.5", md: "px-4 py-2.5 text-sm gap-2", lg: "px-5 py-3 text-sm gap-2" };
  const variants = {
    primary:   "bg-gradient-to-b from-[#dcbd72] to-[#b6923a] text-black hover:brightness-110 shadow-[0_6px_18px_-8px_rgba(201,168,76,0.6)] focus:ring-gold/40",
    secondary: "bg-white/[0.05] text-white/75 border border-white/10 hover:bg-white/[0.09] hover:text-white focus:ring-white/20",
    danger:    "bg-red-500/10 text-red-300 border border-red-500/25 hover:bg-red-500/20 focus:ring-red-400/40",
    ghost:     "text-white/45 hover:text-white/85 hover:bg-white/[0.06] focus:ring-white/20",
    success:   "bg-emerald-600 text-white hover:bg-emerald-500 shadow-[0_6px_18px_-8px_rgba(16,185,129,0.5)] focus:ring-emerald-500/40",
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`panel !rounded-2xl ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between px-6 py-5 border-b border-white/[0.06]">
      <div>
        <h2 className="font-display text-base text-white/90">{title}</h2>
        {subtitle && <p className="text-xs text-white/40 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0 ml-4">{action}</div>}
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="mb-4 text-white/15">{icon}</div>
      <p className="text-sm font-semibold text-white/70">{title}</p>
      <p className="mt-1.5 text-xs text-white/35 max-w-xs leading-relaxed">{body}</p>
    </div>
  );
}

function StatCard({ label, value, color = "text-white/90", sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div className="panel !rounded-2xl p-5 text-center">
      <p className={`font-display text-3xl tabular-nums tracking-tight ${color}`}>{value}</p>
      <p className="text-xs font-medium text-white/50 mt-1.5">{label}</p>
      {sub && <p className="text-[10px] text-white/30 mt-0.5">{sub}</p>}
    </div>
  );
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="label-caps mb-1.5">
      {children}{required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  );
}

/**
 * The dashboard "How it works" strip — makes the content pipeline visible:
 * Ideas → Queue → Drafts → Publish schedule → Live. Each stage shows a live
 * count and jumps to the tab where that stage is managed.
 */
function PipelineStage({ count, label, hint, active, onClick, last }: {
  count: number; label: string; hint: string; active?: boolean; onClick: () => void; last?: boolean;
}) {
  return (
    <>
      <button onClick={onClick}
        className={`flex-1 min-w-[120px] text-left rounded-xl px-4 py-3.5 border transition-all hover:-translate-y-px ${
          active
            ? "bg-gold/10 border-gold/35 hover:border-gold/60"
            : "bg-white/[0.03] border-white/[0.06] hover:border-white/15"
        }`}>
        <p className={`font-display text-2xl tabular-nums ${count > 0 ? "text-white/90" : "text-white/30"}`}>{count}</p>
        <p className="text-xs font-semibold text-white/70 mt-1">{label}</p>
        <p className="text-[10px] text-white/35 mt-0.5 leading-snug">{hint}</p>
      </button>
      {!last && (
        <svg className="w-4 h-4 text-gold/50 shrink-0 hidden sm:block" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12l-7.5 7.5M21 12H3" />
        </svg>
      )}
    </>
  );
}

/** "in 6h 12m" style countdown to the next daily run (08:00 UTC). */
function untilNextRun(runHour: number): { when: Date; human: string } {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), runHour, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const mins = Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000));
  const human = mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return { when: next, human };
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Spinner({ size = "sm" }: { size?: "sm" | "md" }) {
  const s = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  return (
    <svg className={`animate-spin ${s} text-current`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Icons ──────────────────────────────────────────────────────
const I = {
  dashboard: <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>,
  queue:     <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>,
  topics:    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>,
  links:     <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>,
  perf:      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>,
  signout:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>,
  refresh:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
  trash:     <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
  edit:      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
  plus:      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>,
  arrow:     <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>,
  bolt:      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
  publish:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" /></svg>,
  history:   <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  settings:  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>,
  chevron:   <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>,
  clock:     <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  check:     <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>,
};

// ── Main component ─────────────────────────────────────────────

type Tab = "dashboard" | "queue" | "history" | "topics" | "links" | "performance" | "publish_queue" | "settings";

export default function AdminPage() {
  const [isAuthed, setIsAuthed]     = useState<null | boolean>(null);
  const [loginPw, setLoginPw]       = useState("");
  const [authError, setAuthError]   = useState("");
  const [tab, setTab]         = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(false);
  // First-visit guide: shown until dismissed once (persisted), reopenable any time.
  const [showHelp, setShowHelpRaw] = useState(false);
  useEffect(() => {
    try { setShowHelpRaw(localStorage.getItem("aston_admin_guide_seen") !== "1"); } catch { /* SSR/no storage */ }
  }, []);
  const setShowHelp = (v: boolean | ((p: boolean) => boolean)) => {
    setShowHelpRaw((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try { if (!next) localStorage.setItem("aston_admin_guide_seen", "1"); } catch { /* ignore */ }
      return next;
    });
  };

  const [stats, setStats]         = useState<QueueStats | null>(null);
  const [settings, setSettings]   = useState<SchedulerSettings | null>(null);
  const [runs, setRuns]           = useState<RunLog[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [spotifySyncing, setSpotifySyncing] = useState(false);
  const [spotifyResult, setSpotifyResult]   = useState<{ ok: boolean; msg: string; synced?: number } | null>(null);

  const [items, setItems]         = useState<QueueItem[]>([]);
  const [newTopic, setNewTopic]   = useState("");
  const [newMode, setNewMode]     = useState<GenerationMode>("topic_only");
  const [newPriority, setNewPriority] = useState(3);
  const [newDelay, setNewDelay] = useState("");   // "" = next scheduled run; otherwise minutes
  const [newMedia, setNewMedia] = useState({ audio: false, video: false, podcast: false });
  const [newPodcastLength, setNewPodcastLength] = useState(30);
  const [showAddForm, setShowAddForm] = useState(false);
  const [adding, setAdding]       = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showStrategyInputs, setShowStrategyInputs] = useState(false);
  const [newAudience, setNewAudience]           = useState("");
  const [newPrimaryCountry, setNewPrimaryCountry] = useState("");
  const [newSecondaryCountries, setNewSecondaryCountries] = useState("");
  const [newPriorityService, setNewPriorityService] = useState("");
  const [newLanguage, setNewLanguage]           = useState("");
  const [newCustomPrompt, setNewCustomPrompt]   = useState("");

  const [topics, setTopics]       = useState<TopicPlan[]>([]);
  const [tForm, setTForm]         = useState({ topic: "", focusKeyword: "", cluster: "", intent: "informational", priority: 3, notes: "", audience: "", primary_country: "", secondary_countries: "", priority_service: "", language: "", customPrompt: "" });
  const [addingTopic, setAddingTopic] = useState(false);
  const [confirmTopicId, setConfirmTopicId] = useState<string | null>(null);

  const [links, setLinks]         = useState<LinkEntry[]>([]);
  const [lForm, setLForm]         = useState({ url: "", title: "", type: "internal" as "internal"|"external", category: "", keywords: "", anchors: "", status: "active" as "active"|"inactive", language: "" });
  const [siteLanguages, setSiteLanguages] = useState<{ code: string; name: string; isDefault: boolean }[]>([]);
  const [addingLink, setAddingLink] = useState(false);
  const [editingLink, setEditingLink] = useState<LinkEntry | null>(null);
  const [confirmLinkId, setConfirmLinkId] = useState<string | null>(null);
  const [wpSyncing, setWpSyncing]     = useState(false);
  const [wpSyncResult, setWpSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [perfRecords, setPerfRecords] = useState<PostPerformance[]>([]);
  const [syncing, setSyncing]     = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [publishQueue, setPublishQueue]           = useState<PublishQueueItem[]>([]);
  const [publishQueueStats, setPublishQueueStats] = useState<PublishQueueStats | null>(null);
  const [pqLoading, setPqLoading]                 = useState(false);
  const [publishingId, setPublishingId]           = useState<string | null>(null);
  const [history, setHistory]                     = useState<PostHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading]       = useState(false);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  useEffect(() => {
    fetch("/api/auth").then(r => setIsAuthed(r.ok)).catch(() => setIsAuthed(false));
  }, []);

  const fetchDashboard = useCallback(async () => {
    const [qRes, schRes] = await Promise.all([
      fetch("/api/queue"),
      fetch("/api/scheduler"),
    ]);
    if (qRes.status === 401) { setIsAuthed(false); return; }
    const qData = await qRes.json();
    setItems(qData.items ?? []);
    setStats(qData.stats ?? null);
    if (schRes.ok) {
      const schData = await schRes.json();
      setSettings(schData.settings ?? null);
      setRuns(schData.recentRuns ?? []);
    }
  }, []);

  const fetchTopics = useCallback(async () => {
    const res  = await fetch("/api/topics");
    const data = await res.json();
    setTopics(data.topics ?? []);
  }, []);

  const fetchLinks = useCallback(async () => {
    const res  = await fetch("/api/links");
    const data = await res.json();
    setLinks(data.links ?? []);
  }, []);

  const fetchPerformance = useCallback(async () => {
    const res  = await fetch("/api/performance");
    const data = await res.json();
    setPerfRecords(data.records ?? []);
  }, []);

  const fetchPublishQueue = useCallback(async () => {
    try {
      const res  = await fetch("/api/publish-queue");
      if (!res.ok) return;
      const data = await res.json();
      setPublishQueue(data.items ?? []);
      setPublishQueueStats(data.stats ?? null);
    } catch { /* silently skip */ }
  }, []);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res  = await fetch("/api/history");
      if (!res.ok) return;
      const data = await res.json();
      setHistory(data.posts ?? []);
    } catch { /* silently skip */ }
    finally { setHistoryLoading(false); }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([
        fetchDashboard(),
        fetchTopics().catch(console.error),
        fetchLinks().catch(console.error),
        fetchPerformance().catch(console.error),
        fetchPublishQueue(),
        fetch("/api/links/languages")
          .then(r => r.json())
          .then(d => { if (d.languages) setSiteLanguages(d.languages); })
          .catch(console.error),
      ]);
    } finally { setLoading(false); }
  }, [fetchDashboard, fetchTopics, fetchLinks, fetchPerformance, fetchPublishQueue]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: loginPw }),
    });
    if (res.ok) { setIsAuthed(true); setLoginPw(""); }
    else { setAuthError("Incorrect password"); }
  }

  useEffect(() => { if (isAuthed) fetchAll(); }, [isAuthed, fetchAll]);

  useEffect(() => {
    if (tab === "publish_queue" && isAuthed) fetchPublishQueue();
  }, [tab, isAuthed, fetchPublishQueue]);

  useEffect(() => {
    if (tab === "history" && isAuthed) fetchHistory();
  }, [tab, isAuthed, fetchHistory]);

  // Live-refresh the queue while a post is being generated so its step-by-step
  // progress advances on screen — the scheduler equivalent of the manual
  // page's progress stream. Polls only while something is actually processing.
  const anyProcessing = items.some((i) => i.status === "processing");
  useEffect(() => {
    if (!isAuthed || !anyProcessing || (tab !== "dashboard" && tab !== "queue")) return;
    const t = setInterval(() => { fetchDashboard(); }, 4000);
    return () => clearInterval(t);
  }, [isAuthed, anyProcessing, tab, fetchDashboard]);

  // ── Queue actions ──────────────────────────────────────────────
  async function addQueueItem() {
    const hasTopic = !!newTopic.trim();
    const hasPrompt = newCustomPrompt.trim().length >= 10;
    if ((!hasTopic && !hasPrompt) || !newAudience.trim()) return;
    setAdding(true);
    try {
      await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: newTopic.trim(), mode: newMode, priority: newPriority,
          audience: newAudience.trim() || undefined,
          primary_country: newPrimaryCountry.trim() || undefined,
          secondary_countries: newSecondaryCountries.trim() || undefined,
          priority_service: newPriorityService.trim() || undefined,
          language: newLanguage.trim() || undefined,
          customPrompt: newCustomPrompt.trim() || undefined,
          delayMinutes: newDelay ? Number(newDelay) : undefined,
          mediaOutputs: newMedia,
          podcastLength: newMedia.podcast ? newPodcastLength : undefined,
        }),
      });
      setNewTopic(""); setNewPriority(3); setNewDelay("");
      setNewMedia({ audio: false, video: false, podcast: false }); setNewPodcastLength(30);
      setNewAudience(""); setNewPrimaryCountry(""); setNewSecondaryCountries(""); setNewPriorityService(""); setNewLanguage(""); setNewCustomPrompt("");
      await fetchDashboard();
      setShowAddForm(false);
      showToast(newDelay ? `Topic queued — generates in ${Number(newDelay) < 60 ? `${newDelay} min` : `${Number(newDelay) / 60}h`}` : "Topic added to queue");
    } finally { setAdding(false); }
  }

  async function patchQueue(id: string, updates: Partial<QueueItem>) {
    await fetch("/api/queue", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...updates }) });
    await fetchDashboard();
  }

  async function deleteQueueItem(id: string) {
    await fetch("/api/queue", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setConfirmDeleteId(null);
    await fetchDashboard();
    showToast("Item removed");
  }

  async function saveScheduler(patch: Partial<SchedulerSettings>) {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const res  = await fetch("/api/scheduler", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...settings, ...patch }) });
      const data = await res.json();
      setSettings(data.settings);
    } finally { setSavingSettings(false); }
  }

  async function runSpotifySync() {
    setSpotifySyncing(true);
    setSpotifyResult(null);
    try {
      const res  = await fetch("/api/spotify-sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setSpotifyResult({ ok: false, msg: data.error ?? data.message ?? "Sync failed" }); return; }
      setSpotifyResult({ ok: true, msg: data.message ?? "Done", synced: data.synced });
      showToast(typeof data.synced === "number" && data.synced > 0 ? `Embedded Spotify player in ${data.synced} post${data.synced === 1 ? "" : "s"}` : "Spotify sync complete — nothing new to embed");
    } catch {
      setSpotifyResult({ ok: false, msg: "Network error — could not reach the sync endpoint" });
    } finally { setSpotifySyncing(false); }
  }

  async function addTopic() {
    if (!tForm.topic.trim()) return;
    setAddingTopic(true);
    try {
      await fetch("/api/topics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tForm) });
      setTForm({ topic: "", focusKeyword: "", cluster: "", intent: "informational", priority: 3, notes: "", audience: "", primary_country: "", secondary_countries: "", priority_service: "", language: "", customPrompt: "" });
      await fetchTopics();
      showToast("Topic plan created");
    } finally { setAddingTopic(false); }
  }

  async function patchTopic(id: string, updates: Partial<TopicPlan> & { action?: string }) {
    await fetch("/api/topics", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...updates }) });
    await Promise.all([fetchTopics(), fetchDashboard()]);
    if (updates.action === "push_to_queue") showToast("Topic pushed to generation queue");
  }

  async function deleteTopic(id: string) {
    await fetch("/api/topics", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setConfirmTopicId(null);
    await fetchTopics();
    showToast("Topic deleted");
  }

  async function addLink() {
    if (!lForm.url.trim() || !lForm.title.trim()) return;
    setAddingLink(true);
    try {
      await fetch("/api/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...lForm, keywords: lForm.keywords.split(",").map(s => s.trim()).filter(Boolean), anchors: lForm.anchors.split(",").map(s => s.trim()).filter(Boolean) }) });
      setLForm({ url: "", title: "", type: "internal", category: "", keywords: "", anchors: "", status: "active", language: "" });
      await fetchLinks();
      showToast("Link added");
    } finally { setAddingLink(false); }
  }

  async function saveEditLink() {
    if (!editingLink) return;
    await fetch("/api/links", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editingLink) });
    setEditingLink(null);
    await fetchLinks();
    showToast("Link updated");
  }

  async function toggleLinkStatus(id: string, current: "active" | "inactive") {
    await fetch("/api/links", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: current === "active" ? "inactive" : "active" }) });
    await fetchLinks();
  }

  async function deleteLink(id: string) {
    await fetch("/api/links", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setConfirmLinkId(null);
    await fetchLinks();
    showToast("Link deleted");
  }

  async function syncWpLinks() {
    setWpSyncing(true); setWpSyncResult(null);
    try {
      const res  = await fetch("/api/links/sync-wp", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setWpSyncResult({ ok: false, msg: data.error ?? "Sync failed" }); return; }
      setWpSyncResult({ ok: true, msg: `${data.added} new posts added · ${data.skipped} already present · ${data.total} total links` });
      await fetchLinks();
    } catch { setWpSyncResult({ ok: false, msg: "Network error — try again" }); }
    finally { setWpSyncing(false); }
  }

  async function syncPerformance(action: "sync_all" | "sync_post", postId?: string) {
    setSyncing(true); setSyncResult(null);
    try {
      const res  = await fetch("/api/performance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, postId }) });
      const data = await res.json();
      if (!res.ok) { setSyncResult({ ok: false, msg: data.error }); }
      else if (action === "sync_all") { const r = data.result; setSyncResult({ ok: true, msg: `${r.synced} posts synced${r.errors.length ? `, ${r.errors.length} errors` : ""}` }); }
      else { setSyncResult({ ok: true, msg: `Synced — ${data.record?.classification} (${data.record?.impressions?.toLocaleString()} impressions)` }); }
      await fetchPerformance();
    } finally { setSyncing(false); }
  }

  async function publishNow(item: PublishQueueItem) {
    if (!confirm(`Publish "${item.title}" immediately to ${item.targets.map(t => t.target).join(", ")}?`)) return;
    setPublishingId(item.id);
    try {
      const res = await fetch("/api/publish-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const data = await res.json();
      if (res.ok) { showToast(`Published "${item.title}" successfully`); }
      else { showToast(data.error ?? "Publish failed", false); }
      await fetchPublishQueue();
    } finally { setPublishingId(null); }
  }

  // ── Loading / Login ────────────────────────────────────────────
  if (isAuthed === null) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="studio-bg" />
      <div className="w-2 h-2 rounded-full bg-gold animate-pulse" />
    </div>
  );

  if (!isAuthed) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="studio-bg" />
        <div className="relative z-10 w-full max-w-sm px-4 rise-in">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-b from-[#dcbd72] via-gold to-[#a8873a] text-black mb-5 shadow-[0_10px_30px_-8px_rgba(201,168,76,0.55)]">
              <span className="font-display font-semibold text-2xl leading-none">A</span>
            </div>
            <h1 className="font-display text-2xl text-white/95 tracking-tight">Scheduler</h1>
            <p className="text-sm text-white/40 mt-1.5">Aston Content Studio</p>
          </div>
          <Card className="p-8 space-y-4">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label>Password</Label>
                <Input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)}
                  placeholder="Enter password" autoFocus />
              </div>
              {authError && (
                <div className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2.5 text-xs text-red-300 border border-red-500/25">
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
                  {authError}
                </div>
              )}
              <Btn type="submit" variant="primary" size="lg" className="w-full">Sign in</Btn>
            </form>
          </Card>
        </div>
      </div>
    );
  }

  // ── Nav config ─────────────────────────────────────────────────
  // The sidebar itself teaches the model: the four content tabs are ONE
  // pipeline, in order — plan it, write it, review it, put it live.
  type NavItem = { id: Tab; label: string; icon: React.ReactNode; badge?: number; step?: number };
  const navSections: { label: string | null; items: NavItem[] }[] = [
    { label: null, items: [
      { id: "dashboard",    label: "Overview",     icon: I.dashboard },
    ]},
    { label: "Content pipeline", items: [
      { id: "topics",       label: "Plan topics",  icon: I.topics,  step: 1, badge: topics.filter(x => x.status !== "archived").length || undefined },
      { id: "queue",        label: "Write queue",  icon: I.queue,   step: 2, badge: stats?.queued },
      { id: "history",      label: "Recent posts", icon: I.history, step: 3 },
      { id: "publish_queue",label: "Go live",      icon: I.publish, step: 4, badge: publishQueueStats?.queued || undefined },
    ]},
    { label: "Setup", items: [
      { id: "settings",     label: "Settings",     icon: I.settings },
      { id: "links",        label: "Links",        icon: I.links,   badge: links.filter(x => x.status === "active").length || undefined },
    ]},
    { label: "Insights", items: [
      { id: "performance",  label: "Performance",  icon: I.perf,    badge: perfRecords.length || undefined },
    ]},
  ];

  return (
    <div className="flex h-screen overflow-hidden">
      <div className="studio-bg" />

      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside className="relative z-10 w-60 flex-shrink-0 bg-ink-1/90 backdrop-blur border-r border-white/[0.06] flex flex-col">
        {/* Brand */}
        <div className="px-5 py-5 border-b border-white/[0.06]">
          <a href="/" className="flex items-center gap-3 group">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-b from-[#dcbd72] via-gold to-[#a8873a] flex items-center justify-center flex-shrink-0 shadow-[0_6px_18px_-6px_rgba(201,168,76,0.55)]">
              <span className="font-display text-black font-semibold text-base leading-none">A</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">Scheduler</p>
              <p className="text-[9px] text-gold/70 tracking-[0.24em] uppercase mt-0.5">Content Studio</p>
            </div>
          </a>
        </div>

        {/* Scheduler toggle */}
        {settings && (
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <button onClick={() => saveScheduler({ enabled: !settings.enabled })} disabled={savingSettings}
              className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-medium transition-all ${settings.enabled ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15" : "bg-white/[0.04] text-white/35 hover:bg-white/[0.07]"}`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${settings.enabled ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-white/40"}`} />
              <span className="flex-1 text-left">
                <span className="block font-semibold text-[11px]">{settings.enabled ? "Scheduler active" : "Scheduler paused"}</span>
                <span className="block text-[10px] opacity-60 mt-0.5">{settings.enabled ? "Runs daily 08:00 UTC" : "Click to enable"}</span>
              </span>
            </button>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {navSections.map((section, si) => (
            <div key={si} className={si > 0 ? "mt-4" : ""}>
              {section.label && (
                <p className="px-3 pb-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-white/25">{section.label}</p>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <button key={item.id} onClick={() => setTab(item.id)}
                    className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${tab === item.id ? "bg-gradient-to-b from-[#dcbd72] to-[#b6923a] text-black shadow-[0_6px_18px_-8px_rgba(201,168,76,0.6)]" : "text-white/35 hover:bg-white/[0.06] hover:text-white"}`}>
                    {item.step !== undefined ? (
                      <span className={`flex-shrink-0 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center ${tab === item.id ? "bg-black/20 text-black" : "bg-white/[0.08] text-white/40"}`}>
                        {item.step}
                      </span>
                    ) : (
                      <span className="flex-shrink-0">{item.icon}</span>
                    )}
                    <span className="flex-1 text-left font-medium text-[13px]">{item.label}</span>
                    {item.badge !== undefined && item.badge > 0 && (
                      <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none tabular-nums ${tab === item.id ? "bg-black/20 text-black" : "bg-white/10 text-white/30"}`}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Bottom */}
        <div className="px-3 py-3 border-t border-white/[0.06] space-y-0.5">
          <button onClick={() => fetchAll()} disabled={loading}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-white/35 hover:bg-white/[0.06] hover:text-white transition-all disabled:opacity-40">
            {loading ? <Spinner /> : I.refresh}
            <span className="font-medium text-[13px]">{loading ? "Refreshing…" : "Refresh data"}</span>
          </button>
          <button onClick={() => { fetch("/api/auth", { method: "DELETE" }).finally(() => setIsAuthed(false)); }}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-white/35 hover:bg-white/[0.06] hover:text-white transition-all">
            {I.signout}
            <span className="font-medium text-[13px]">Sign out</span>
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────── */}
      <main className="relative z-10 flex-1 overflow-auto">
        {/* Toast */}
        {toast && (
          <div className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 rounded-2xl px-4 py-3.5 text-sm font-medium shadow-xl border transition-all ${toast.ok ? "bg-ink-2 text-white/80 border-white/[0.06] shadow-black/50" : "bg-red-500/10 text-red-300 border-red-500/25"}`}>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${toast.ok ? "bg-emerald-400" : "bg-red-400"}`} />
            {toast.msg}
          </div>
        )}

        <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">

          {/* ══ DASHBOARD ═══════════════════════════════════════ */}
          {tab === "dashboard" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Overview</h1>
                  <p className="text-sm text-white/45 mt-0.5">What the scheduler is doing, and what happens next</p>
                </div>
                <Btn variant="secondary" size="sm" onClick={() => setShowHelp(v => !v)}>
                  {showHelp ? "Hide guide" : "How does this work?"}
                </Btn>
              </div>

              {/* ── First-time explainer: the whole tool in four sentences ── */}
              {showHelp && (
                <Card className="!border-gold/25">
                  <div className="p-6">
                    <p className="font-display text-lg text-white/90 mb-4">This tool writes blog posts for aston.ae on autopilot. Four steps:</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {[
                        { n: 1, title: "Plan topics", tab: "topics" as Tab, body: "Collect article ideas in an idea bank. Nothing generates from here — it's just planning. When an idea is ready, push it to the Write queue." },
                        { n: 2, title: "Write queue", tab: "queue" as Tab, body: "Topics here get written automatically — every day at 08:00 UTC, or at an exact time you pick per topic. Each becomes a full article with images, saved to WordPress as a draft." },
                        { n: 3, title: "Recent posts", tab: "history" as Tab, body: "Every generated post lands here (including ones made on the Generate page). Review them in WordPress, and add audio, video or a podcast to any of them." },
                        { n: 4, title: "Go live", tab: "publish_queue" as Tab, body: "Drafts you approve get scheduled here and are published to the live site automatically." },
                      ].map((s) => (
                        <button key={s.n} onClick={() => setTab(s.tab)}
                          className="text-left rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-gold/40 transition-all px-4 py-3.5">
                          <p className="text-sm font-semibold text-white/85">
                            <span className="inline-flex w-5 h-5 mr-2 rounded-full bg-gold/15 text-gold text-[11px] font-bold items-center justify-center">{s.n}</span>
                            {s.title}
                          </p>
                          <p className="text-xs text-white/45 mt-1.5 leading-relaxed">{s.body}</p>
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-white/35 mt-4">The switch in the sidebar (or in <button className="text-gold underline underline-offset-2 hover:text-gold-bright" onClick={() => setTab("settings")}>Settings</button>) turns the daily autopilot on and off. Everything is saved as a WordPress <em>draft</em> first — nothing goes live without you.</p>
                  </div>
                </Card>
              )}

              {/* ── Plain-English status: what happens next ── */}
              {settings && stats && (() => {
                const { human } = untilNextRun(8);
                const remaining = Math.max(0, settings.blogsPerDay - stats.completedToday);
                const willWrite = Math.min(settings.maxPerRun ?? 1, remaining, stats.queued);
                const dueEarlier = items.filter(i => i.status === "queued" && i.scheduledFor && new Date(i.scheduledFor) > new Date()).length;
                return (
                  <div className={`rounded-2xl border px-5 py-4 ${settings.enabled ? "border-gold/25 bg-gold/[0.06]" : "border-white/[0.08] bg-white/[0.03]"}`}>
                    <div className="flex items-start gap-3">
                      <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${settings.enabled ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" : "bg-white/25"}`} />
                      <div>
                        <p className="text-sm text-white/85 leading-relaxed">
                          {settings.enabled ? (
                            stats.queued === 0 && dueEarlier === 0
                              ? <>The scheduler is <strong className="text-emerald-300">on</strong>, but the queue is empty — nothing will generate until you add a topic in <button className="text-gold underline underline-offset-2 hover:text-gold-bright" onClick={() => setTab("queue")}>Generate</button>.</>
                              : <>Next automatic run <strong className="text-gold-bright">{human}</strong> (08:00 UTC): it will write <strong className="text-white">{willWrite === 0 ? "no posts (daily target reached)" : `${willWrite} post${willWrite === 1 ? "" : "s"}`}</strong>{willWrite > 0 && <> from the <strong className="text-white">{stats.queued}</strong> waiting topic{stats.queued === 1 ? "" : "s"}</>} and save {willWrite === 1 ? "it" : "them"} as WordPress draft{willWrite === 1 ? "" : "s"}. {stats.completedToday} of {settings.blogsPerDay} daily posts done so far.</>
                          ) : (
                            <>The scheduler is <strong className="text-white/70">paused</strong> — nothing generates automatically. Topics with a set time still generate. Turn it on in <button className="text-gold underline underline-offset-2 hover:text-gold-bright" onClick={() => setTab("settings")}>Settings</button> or with the switch in the sidebar.</>
                          )}
                        </p>
                        {dueEarlier > 0 && (
                          <p className="text-xs text-gold/80 mt-1.5">⏱ {dueEarlier} topic{dueEarlier === 1 ? " has" : "s have"} a set generation time and will run independently of the daily schedule.</p>
                        )}
                        {stats.failed > 0 && (
                          <p className="text-xs text-red-300 mt-1.5">⚠ {stats.failed} topic{stats.failed === 1 ? "" : "s"} failed — open <button className="underline underline-offset-2 hover:text-red-200" onClick={() => setTab("queue")}>Generate</button> to retry or remove {stats.failed === 1 ? "it" : "them"}.</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ── The content pipeline, made visible ── */}
              {stats && (
                <Card>
                  <CardHeader title="Your content pipeline" subtitle="These are the four numbered tabs in the sidebar — click a stage to open it" />
                  <div className="px-5 py-5 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 overflow-x-auto">
                    <PipelineStage
                      count={topics.filter(t => t.status !== "archived" && t.status !== "queued").length}
                      label="1 · Plan topics" hint="Idea bank — nothing generates yet"
                      onClick={() => setTab("topics")} />
                    <PipelineStage
                      count={stats.queued}
                      label="2 · Write queue" hint={stats.processing > 0 ? `${stats.processing} writing right now` : "Written by the daily run or at a set time"}
                      active={stats.processing > 0}
                      onClick={() => setTab("queue")} />
                    <PipelineStage
                      count={stats.completed}
                      label="3 · Recent posts" hint="Review drafts, add audio / video / podcast"
                      onClick={() => setTab("history")} />
                    <PipelineStage
                      count={publishQueueStats?.queued ?? 0}
                      label="4 · Go live" hint="Approved drafts scheduled to publish"
                      onClick={() => setTab("publish_queue")} />
                    <PipelineStage
                      count={publishQueueStats?.published ?? 0}
                      label="Live" hint="Published on aston.ae"
                      onClick={() => setTab("publish_queue")} last />
                  </div>
                </Card>
              )}

              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <StatCard label="Done today" value={stats.completedToday} color="text-gold" sub={settings ? `of ${settings.blogsPerDay} daily target` : "posts generated"} />
                  <StatCard label="Writing now" value={stats.processing} color="text-amber-300" sub="in progress" />
                  <StatCard label="Failed" value={stats.failed} color="text-red-400" sub="need attention" />
                  <StatCard label="Paused" value={stats.paused} color="text-white/35" sub="on hold" />
                </div>
              )}

              {runs.length > 0 && (
                <Card>
                  <CardHeader title="Recent Runs" subtitle={`${runs.length} run${runs.length !== 1 ? "s" : ""} recorded`} />
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white/[0.03]/80 text-[11px] font-bold text-white/35 uppercase tracking-wide border-b border-white/[0.06]">
                          {["Run ID","Started","Completed","Tried","Done","Failed","Status"].map(h => (
                            <th key={h} className={`px-5 py-3 ${["Tried","Done","Failed","Status"].includes(h) ? "text-center" : "text-left"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.05]">
                        {[...runs].reverse().map((r) => (
                          <tr key={r.runId} className="hover:bg-white/[0.03]/60 transition-colors">
                            <td className="px-5 py-3.5 font-mono text-xs text-white/35">{r.runId.slice(4, 22)}</td>
                            <td className="px-5 py-3.5 text-xs text-white/45 whitespace-nowrap">{fmt(r.startedAt)}</td>
                            <td className="px-5 py-3.5 text-xs text-white/45 whitespace-nowrap">{fmt(r.completedAt)}</td>
                            <td className="px-5 py-3.5 text-center text-sm tabular-nums">{r.topicsAttempted}</td>
                            <td className="px-5 py-3.5 text-center text-sm font-semibold text-emerald-300 tabular-nums">{r.topicsCompleted}</td>
                            <td className="px-5 py-3.5 text-center text-sm font-semibold text-red-400 tabular-nums">{r.topicsFailed}</td>
                            <td className="px-5 py-3.5 text-center"><Badge className={RUN_STATUS[r.status]}>{r.status.replace(/_/g, " ")}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}

          {/* ══ SETTINGS ═════════════════════════════════════════ */}
          {tab === "settings" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Settings</h1>
                  <p className="text-sm text-white/45 mt-0.5">When the scheduler runs, how many posts it writes, and the quality &amp; media defaults.</p>
                </div>
              </div>

              {settings && (
                <Card>
                  <CardHeader title="Scheduler Settings" subtitle="Control when and how posts are generated"
                    action={savingSettings ? <div className="flex items-center gap-2 text-xs text-white/35"><Spinner /> Saving</div> : undefined} />
                  <div className="p-6 space-y-6">
                    <div className={`flex items-center justify-between rounded-2xl px-5 py-4 ${settings.enabled ? "bg-emerald-500/10 border border-emerald-500/25" : "bg-white/[0.03] border border-white/[0.06]"}`}>
                      <div>
                        <p className={`text-sm font-semibold ${settings.enabled ? "text-emerald-300" : "text-white/70"}`}>
                          {settings.enabled ? "Scheduler is running" : "Scheduler is paused"}
                        </p>
                        <p className={`text-xs mt-0.5 ${settings.enabled ? "text-emerald-300" : "text-white/35"}`}>
                          {settings.enabled ? "Generates posts daily at 08:00 UTC" : "Enable to start generating posts automatically"}
                        </p>
                      </div>
                      <Toggle checked={settings.enabled} onChange={() => saveScheduler({ enabled: !settings.enabled })} disabled={savingSettings} />
                    </div>

                    <div>
                      <p className="text-[11px] font-bold text-white/35 uppercase tracking-widest mb-1.5">Daily Schedule</p>
                      <p className="text-xs text-white/45 mb-3 leading-relaxed">
                        In plain terms: every day at 08:00 UTC the scheduler writes <strong className="text-white/70">{settings.maxPerRun ?? 1} post{(settings.maxPerRun ?? 1) === 1 ? "" : "s"}</strong>, and stops once <strong className="text-white/70">{settings.blogsPerDay} post{settings.blogsPerDay === 1 ? "" : "s"}</strong> have been written that day. Topics with a set time ignore this and run at their own moment.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                          <p className="text-xs font-medium text-white/45 mb-1">Run time</p>
                          <p className="text-sm font-bold text-white/80">08:00 UTC</p>
                          <p className="text-[10px] text-white/35 mt-0.5">Fixed in vercel.json</p>
                        </div>
                        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                          <p className="text-xs font-medium text-white/45 mb-2">Posts per day</p>
                          <Select value={settings.blogsPerDay} onChange={(e) => saveScheduler({ blogsPerDay: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                            {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n} {n === 1 ? "post" : "posts"}</option>)}
                          </Select>
                        </div>
                        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                          <p className="text-xs font-medium text-white/45 mb-2">Posts per run</p>
                          <Select value={settings.maxPerRun} onChange={(e) => saveScheduler({ maxPerRun: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                            {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} {n === 1 ? "post" : "posts"}</option>)}
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-bold text-white/35 uppercase tracking-widest mb-3">Quality Controls</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="flex items-center justify-between rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                          <div>
                            <p className="text-sm font-medium text-white/70">Block on QA warning</p>
                            <p className="text-xs text-white/35 mt-0.5">Only publish posts that pass all checks</p>
                          </div>
                          <Toggle checked={settings.blockOnQaWarning} onChange={() => saveScheduler({ blockOnQaWarning: !settings.blockOnQaWarning })} disabled={savingSettings} />
                        </div>
                        <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                          <p className="text-xs font-medium text-white/45 mb-2">Auto-retries on failure</p>
                          <Select value={settings.maxRetries} onChange={(e) => saveScheduler({ maxRetries: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                            {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n === 0 ? "No retries" : `${n} ${n === 1 ? "retry" : "retries"}`}</option>)}
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-bold text-white/35 uppercase tracking-widest mb-3">Image Generation</p>
                      <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                        <p className="text-xs font-medium text-white/45 mb-2">Image model</p>
                        <Select value={settings.imageModel ?? "gpt-image-2"} onChange={(e) => saveScheduler({ imageModel: e.target.value as "imagen-4" | "gpt-image-2" })} disabled={savingSettings} className="w-full">
                          <option value="gpt-image-2">GPT Image 2 (OpenAI)</option>
                          <option value="imagen-4">Imagen 4 (Google)</option>
                        </Select>
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-bold text-white/35 uppercase tracking-widest mb-3">Default Media Outputs</p>
                      <p className="text-xs text-white/35 mb-3 leading-relaxed">
                        You normally choose media per post when adding it to <button className="text-gold underline underline-offset-2 hover:text-gold-bright" onClick={() => setTab("queue")}>Generate</button>. These defaults only apply to older queue items that were added before per-post selection existed. Leave them off unless you want media on everything.
                      </p>
                      <div className="space-y-2.5">
                        {([
                          { key: "audio"   as const, label: "Read-aloud audio", desc: "Kokoro narration MP3, saved to the post's audio player" },
                          { key: "video"   as const, label: "YouTube video",    desc: "Narrated scene-by-scene video, rendered + uploaded to YouTube" },
                          { key: "podcast" as const, label: "Podcast episode",  desc: "Two-voice conversation, published to the podcast feed" },
                        ]).map((m) => (
                          <div key={m.key} className="flex items-center justify-between rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                            <div>
                              <p className="text-sm font-medium text-white/80">{m.label}</p>
                              <p className="text-xs text-white/35 mt-0.5">{m.desc}</p>
                            </div>
                            <Toggle
                              checked={settings.mediaOutputs?.[m.key] ?? false}
                              onChange={() => saveScheduler({ mediaOutputs: { ...(settings.mediaOutputs ?? { audio: false, video: false, podcast: false }), [m.key]: !(settings.mediaOutputs?.[m.key] ?? false) } })}
                              disabled={savingSettings}
                            />
                          </div>
                        ))}
                        {settings.mediaOutputs?.podcast && (
                          <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                            <p className="text-xs font-medium text-white/45 mb-2">Podcast length</p>
                            <Select value={settings.podcastLength ?? 30} onChange={(e) => saveScheduler({ podcastLength: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                              <option value={3}>3 minutes (test)</option>
                              <option value={15}>15 minutes</option>
                              <option value={30}>30 minutes</option>
                              <option value={45}>45 minutes</option>
                              <option value={60}>60 minutes</option>
                            </Select>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              )}

              {/* ── Maintenance / integrations ── */}
              <Card>
                <CardHeader title="Podcast → Spotify sync" subtitle="When a podcast goes live on Spotify, its player is embedded back into the blog post. This runs automatically every hour — use this to force it now." />
                <div className="p-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm text-white/70">Just published an episode on Spotify and want it on the site immediately?</p>
                      <p className="text-xs text-white/35 mt-0.5">Only posts whose episode is already live on Spotify get embedded — nothing else is touched.</p>
                    </div>
                    <Btn variant="secondary" onClick={runSpotifySync} disabled={spotifySyncing}>
                      {spotifySyncing ? <><Spinner /> Syncing…</> : <>{I.refresh} Sync Spotify now</>}
                    </Btn>
                  </div>
                  {spotifyResult && (
                    <div className={`mt-4 flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm border ${spotifyResult.ok ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25" : "bg-red-500/10 text-red-300 border-red-500/25"}`}>
                      <span className="mt-0.5">{spotifyResult.ok ? "✓" : "✕"}</span>
                      <span>{spotifyResult.msg}</span>
                    </div>
                  )}
                </div>
              </Card>
            </>
          )}

          {/* ══ GEN QUEUE ════════════════════════════════════════ */}
          {tab === "queue" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Write queue</h1>
                  <p className="text-sm text-white/45 mt-0.5">Topics here get written automatically — top priority first at the daily run, or at the exact time you set per topic.</p>
                </div>
                {!(showAddForm || items.length === 0) && (
                  <Btn variant="primary" onClick={() => setShowAddForm(true)}>{I.plus} Add topic</Btn>
                )}
              </div>

              {(showAddForm || items.length === 0) && (
              <Card>
                <CardHeader title="Add a topic" subtitle="It will be written at the next daily run — or pick an exact time below."
                  action={items.length > 0 ? <Btn variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>Close</Btn> : undefined} />
                <div className="p-6 space-y-4">
                  <div>
                    <Label>Custom prompt <span className="text-white/35 font-normal">(optional if topic set — AI will derive title)</span></Label>
                    <textarea
                      value={newCustomPrompt}
                      onChange={(e) => setNewCustomPrompt(e.target.value)}
                      placeholder="e.g. I need a post about the German crypto market, what is legal and what is not, and how Aston VIP can help"
                      rows={2}
                      className="w-full border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-gold/20 focus:border-gold/55 resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label>Topic title <span className="text-white/35 font-normal">(optional if custom prompt set)</span></Label>
                      <Input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addQueueItem()} placeholder="e.g. How to open a company in DIFC" />
                    </div>
                    <div>
                      <Label required>Target audience</Label>
                      <Input value={newAudience} onChange={(e) => setNewAudience(e.target.value)} placeholder="e.g. founders, investors, crypto companies" />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <Label>Mode</Label>
                      <Select value={newMode} onChange={(e) => setNewMode(e.target.value as GenerationMode)}>
                        <option value="topic_only">Topic only</option>
                        <option value="source_assisted">Source assisted</option>
                        <option value="improve_existing">Improve existing</option>
                        <option value="notes_to_article">Notes to article</option>
                      </Select>
                    </div>
                    <div>
                      <Label>Priority</Label>
                      <Select value={newPriority} onChange={(e) => setNewPriority(Number(e.target.value))} className="w-32">
                        <option value={5}>5 — High</option>
                        <option value={4}>4</option>
                        <option value={3}>3 — Normal</option>
                        <option value={2}>2</option>
                        <option value={1}>1 — Low</option>
                      </Select>
                    </div>
                    <div>
                      <Label>Generate</Label>
                      <Select value={newDelay} onChange={(e) => setNewDelay(e.target.value)} className="w-44">
                        <option value="">Next scheduled run</option>
                        <option value="5">In 5 minutes</option>
                        <option value="30">In 30 minutes</option>
                        <option value="60">In 1 hour</option>
                        <option value="180">In 3 hours</option>
                        <option value="300">In 5 hours</option>
                        <option value="720">In 12 hours</option>
                        <option value="1440">In 24 hours</option>
                      </Select>
                    </div>
                    <Btn variant="primary" onClick={addQueueItem} disabled={adding || (!newTopic.trim() && newCustomPrompt.trim().length < 10) || !newAudience.trim()}>
                      {adding ? <><Spinner /> Adding…</> : <>{I.plus} Add to queue</>}
                    </Btn>
                  </div>

                  {/* Per-post media outputs — chosen here so only the posts
                      that need a podcast/video/audio get one */}
                  <div className="rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3.5">
                    <p className="text-xs font-medium text-white/45 mb-2.5">Media outputs for this post <span className="text-white/30 font-normal">— generated automatically after the draft is saved</span></p>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
                      {([
                        { key: "audio"   as const, label: "Read-aloud audio" },
                        { key: "video"   as const, label: "YouTube video" },
                        { key: "podcast" as const, label: "Podcast episode" },
                      ]).map((m) => (
                        <label key={m.key} className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={newMedia[m.key]}
                            onChange={() => setNewMedia(v => ({ ...v, [m.key]: !v[m.key] }))}
                            className="w-3.5 h-3.5 accent-gold"
                          />
                          <span className={`text-sm ${newMedia[m.key] ? "text-white/85" : "text-white/50"}`}>{m.label}</span>
                        </label>
                      ))}
                      {newMedia.podcast && (
                        <Select value={newPodcastLength} onChange={(e) => setNewPodcastLength(Number(e.target.value))} className="!py-1.5 text-xs">
                          <option value={3}>3 min (test)</option>
                          <option value={15}>15 min</option>
                          <option value={30}>30 min</option>
                          <option value={45}>45 min</option>
                          <option value={60}>60 min</option>
                        </Select>
                      )}
                    </div>
                  </div>

                  <div>
                    <button type="button" onClick={() => setShowStrategyInputs(v => !v)}
                      className="flex items-center gap-1.5 text-xs text-gold hover:text-gold-bright font-semibold transition-colors">
                      <span className={`transition-transform ${showStrategyInputs ? "rotate-90" : ""}`}>{I.chevron}</span>
                      Additional strategy inputs (optional)
                    </button>
                    {showStrategyInputs && (
                      <div className="mt-3 p-4 bg-gold/[0.07] rounded-xl border border-gold/25 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        <p className="col-span-full text-xs text-white/45">These optional fields shape jurisdiction focus, service emphasis, and output language.</p>
                        <div>
                          <Label>Primary country</Label>
                          <Input value={newPrimaryCountry} onChange={(e) => setNewPrimaryCountry(e.target.value)} placeholder="e.g. UAE" />
                        </div>
                        <div>
                          <Label>Secondary countries</Label>
                          <Input value={newSecondaryCountries} onChange={(e) => setNewSecondaryCountries(e.target.value)} placeholder="e.g. UK, Germany" />
                        </div>
                        <div>
                          <Label>Priority service</Label>
                          <Input value={newPriorityService} onChange={(e) => setNewPriorityService(e.target.value)} placeholder="e.g. VARA licensing" />
                        </div>
                        <div>
                          <Label>Language</Label>
                          <Select value={newLanguage} onChange={(e) => setNewLanguage(e.target.value)} className="w-full">
                            <option value="">Default (British English)</option>
                            {siteLanguages.map(l => <option key={l.code} value={l.code}>{l.name} ({l.code})</option>)}
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
              )}

              <Card>
                <CardHeader title="Queue" subtitle={`${items.length} items · ${items.filter(i => i.status === "queued").length} waiting`} />
                {items.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>} title="Queue is empty" body="Add a topic above to get started. The scheduler processes items automatically when enabled." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white/[0.03]/80 text-[11px] font-bold text-white/35 uppercase tracking-wide border-b border-white/[0.06]">
                          <th className="px-5 py-3 text-left">Topic</th>
                          <th className="px-5 py-3 text-left">Mode</th>
                          <th className="px-5 py-3 text-center">Priority</th>
                          <th className="px-5 py-3 text-center">Status</th>
                          <th className="px-5 py-3 text-left">Added</th>
                          <th className="px-5 py-3 text-center">QA</th>
                          <th className="px-5 py-3 text-center">WordPress</th>
                          <th className="px-5 py-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.05]">
                        {items.map((item) => (
                          <tr key={item.id} className="hover:bg-white/[0.03]/60 transition-colors">
                            <td className="px-5 py-4 max-w-[240px]">
                              <p className="font-semibold text-white/90 truncate text-sm" title={item.topic}>{item.topic}</p>
                              {item.lastError && <p className="text-xs text-red-400 mt-0.5 truncate" title={item.lastError}>{item.lastError}</p>}
                              {item.status === "completed" && item.completedAt && <p className="text-xs text-white/35 mt-0.5">Done {fmt(item.completedAt)}</p>}
                              {item.status === "processing" && item.progress && (
                                <div className="mt-1.5 max-w-[220px]">
                                  <div className="flex items-center justify-between mb-1">
                                    <p className="text-xs text-amber-300 truncate" title={item.progress.label}>{item.progress.label}</p>
                                    <span className="text-[10px] text-white/35 tabular-nums shrink-0 ml-2">{item.progress.step}/{item.progress.total}</span>
                                  </div>
                                  <div className="progress-track">
                                    <div className="progress-fill" style={{ width: `${Math.round((item.progress.step / item.progress.total) * 100)}%` }} />
                                  </div>
                                </div>
                              )}
                              {item.status === "processing" && !item.progress && (
                                <p className="text-xs text-amber-300 mt-0.5">Starting…</p>
                              )}
                              {item.status === "queued" && item.scheduledFor && (
                                <p className={`text-xs mt-0.5 ${new Date(item.scheduledFor) > new Date() ? "text-gold/80" : "text-white/35"}`}>
                                  ⏱ Generates {fmt(item.scheduledFor)}
                                </p>
                              )}
                              {item.mediaOutputs && (item.mediaOutputs.audio || item.mediaOutputs.video || item.mediaOutputs.podcast) && (
                                <span className="flex flex-wrap gap-1 mt-1">
                                  {item.mediaOutputs.audio   && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gold/10 text-gold/85 border border-gold/25">audio</span>}
                                  {item.mediaOutputs.video   && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gold/10 text-gold/85 border border-gold/25">video</span>}
                                  {item.mediaOutputs.podcast && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gold/10 text-gold/85 border border-gold/25">podcast {item.podcastLength ?? 30}m</span>}
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-4 text-xs text-white/45 whitespace-nowrap capitalize">{item.mode.replace(/_/g, " ")}</td>
                            <td className="px-5 py-4 text-center">
                              <Select value={item.priority} onChange={(e) => patchQueue(item.id, { priority: Number(e.target.value) })} disabled={item.status === "completed" || item.status === "processing"} className="w-14 text-center disabled:opacity-40">
                                {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                              </Select>
                            </td>
                            <td className="px-5 py-4 text-center">
                              <span className="inline-flex items-center gap-1.5">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${Q_STATUS[item.status].dot}`} />
                                <Badge className={Q_STATUS[item.status].badge}>{Q_STATUS[item.status].label}</Badge>
                              </span>
                            </td>
                            <td className="px-5 py-4 text-xs text-white/35 whitespace-nowrap">{fmt(item.createdAt)}</td>
                            <td className="px-5 py-4 text-center">
                              {item.qaScore != null ? (
                                <span className={`text-xs font-bold tabular-nums ${item.qaScore >= 80 ? "text-emerald-300" : item.qaScore >= 60 ? "text-amber-300" : "text-red-400"}`}>
                                  {item.qaScore}<span className="font-normal text-white/30">/100</span>
                                </span>
                              ) : <span className="text-white/30 text-xs">—</span>}
                            </td>
                            <td className="px-5 py-4 text-center">
                              {item.wpEditUrl ? (
                                <div className="flex flex-col items-center gap-1">
                                  <div className="flex items-center justify-center gap-2">
                                    <a href={item.wpEditUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-gold hover:text-gold-bright hover:underline font-medium">Edit in WP</a>
                                    {item.wpPostUrl && <a href={item.wpPostUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-white/35 hover:text-white/55 hover:underline">Preview</a>}
                                  </div>
                                  {item.wpPostId && (
                                    <a href={`/media?postId=${item.wpPostId}&title=${encodeURIComponent(item.topic)}`}
                                      className="text-[11px] text-white/45 hover:text-gold-bright hover:underline inline-flex items-center gap-1">
                                      🎬 Add media
                                    </a>
                                  )}
                                </div>
                              ) : <span className="text-white/30 text-xs">—</span>}
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex items-center justify-center gap-1">
                                {item.status === "paused"  && <Btn variant="ghost" size="sm" onClick={() => patchQueue(item.id, { status: "queued" })}>Resume</Btn>}
                                {item.status === "queued"  && <Btn variant="ghost" size="sm" onClick={() => patchQueue(item.id, { status: "paused" })}>Pause</Btn>}
                                {item.status === "failed"  && <Btn variant="ghost" size="sm" onClick={() => patchQueue(item.id, { status: "queued", retryCount: 0, lastError: null } as Partial<QueueItem>)}>Retry</Btn>}
                                {item.status !== "processing" && (
                                  confirmDeleteId === item.id ? (
                                    <span className="flex items-center gap-1">
                                      <Btn variant="danger" size="sm" onClick={() => deleteQueueItem(item.id)}>Confirm</Btn>
                                      <Btn variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Btn>
                                    </span>
                                  ) : (
                                    <Btn variant="ghost" size="sm" onClick={() => setConfirmDeleteId(item.id)}>{I.trash}</Btn>
                                  )
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}

          {/* ══ HISTORY ══════════════════════════════════════════ */}
          {tab === "history" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Recent posts</h1>
                  <p className="text-sm text-white/45 mt-0.5">The 20 most recent articles — from the scheduler and the Generate page. Add media to any of them.</p>
                </div>
                <Btn variant="secondary" onClick={() => fetchHistory()} disabled={historyLoading}>
                  {historyLoading ? <Spinner /> : I.refresh} Refresh
                </Btn>
              </div>

              {history.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={I.history}
                    title="No posts yet"
                    body="Once you generate a post — here or on the Generate page — it appears here so you can add audio, video or a podcast to it."
                  />
                </Card>
              ) : (
                <Card>
                  <div className="divide-y divide-white/[0.05]">
                    {history.map((h) => (
                      <div key={h.id} className="flex items-center gap-4 px-6 py-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-white/90 text-sm truncate" title={h.title}>{h.title}</p>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded ring-1 ring-inset ${h.source === "manual" ? "bg-sky-500/10 text-sky-300 ring-sky-500/25" : "bg-gold/10 text-gold/85 ring-gold/25"}`}>
                              {h.source === "manual" ? "Generate page" : "Scheduler"}
                            </span>
                            {h.needsReview && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/25">needs review</span>}
                          </div>
                          <p className="text-xs text-white/35 mt-0.5">
                            {fmt(h.createdAt)}{h.focusKeyword ? ` · ${h.focusKeyword}` : ""}
                            {h.mediaOutputs && (h.mediaOutputs.audio || h.mediaOutputs.video || h.mediaOutputs.podcast) && (
                              <span className="text-white/25"> · media at generation: {[h.mediaOutputs.audio && "audio", h.mediaOutputs.video && "video", h.mediaOutputs.podcast && "podcast"].filter(Boolean).join(", ")}</span>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <a href={h.wpEditUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-white/45 hover:text-white/70 hover:underline">Edit in WP</a>
                          {h.wpPostUrl && <a href={h.wpPostUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-white/45 hover:text-white/70 hover:underline">View</a>}
                          <a href={`/media?postId=${h.wpPostId}&title=${encodeURIComponent(h.title)}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-gold hover:text-gold-bright">
                            🎬 Add media
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}

          {/* ══ PUBLISH QUEUE ════════════════════════════════════ */}
          {tab === "publish_queue" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Go live</h1>
                  <p className="text-sm text-white/45 mt-0.5">Finished drafts scheduled to go live. Each publishes automatically at its set time (checked hourly) — or push one live now.</p>
                </div>
                <Btn variant="secondary" onClick={() => { setPqLoading(true); fetchPublishQueue().finally(() => setPqLoading(false)); }} disabled={pqLoading}>
                  {pqLoading ? <Spinner /> : I.refresh} Refresh
                </Btn>
              </div>

              {publishQueueStats && (
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-4">
                  <StatCard label="Total" value={publishQueueStats.total} />
                  <StatCard label="Scheduled" value={publishQueueStats.queued} color="text-blue-300" />
                  <StatCard label="Publishing" value={publishQueueStats.processing} color="text-amber-300" />
                  <StatCard label="Published" value={publishQueueStats.published} color="text-emerald-300" />
                  <StatCard label="Failed" value={publishQueueStats.failed} color="text-red-400" />
                  <StatCard label="Paused" value={publishQueueStats.paused} color="text-white/35" />
                </div>
              )}

              {publishQueue.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" /></svg>}
                    title="Publish queue is empty"
                    body="Generate an article on the Blog Generator page, then choose 'Queue for publishing' to schedule it for external platforms."
                  />
                </Card>
              ) : (
                <div className="space-y-3">
                  {publishQueue.map((item) => {
                    const canAct = item.status === "queued" || item.status === "failed" || item.status === "paused";
                    const isPublishing = publishingId === item.id;
                    return (
                      <Card key={item.id} className={item.status === "published" ? "opacity-70" : ""}>
                        {/* Status bar */}
                        <div className={`h-1 rounded-t-2xl ${PQ_STATUS[item.status].bar}`} />
                        <div className="p-5">
                          <div className="flex items-start justify-between gap-4">
                            {/* Left: title + meta */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2.5 flex-wrap">
                                <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${PQ_STATUS[item.status].badge}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${PQ_STATUS[item.status].dot}`} />
                                  {PQ_STATUS[item.status].label}
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                  {item.targets.map((t) => (
                                    <span key={t.target} className="text-[10px] font-bold uppercase tracking-wide text-white/45 bg-white/[0.07] rounded-md px-2 py-0.5">{t.target}</span>
                                  ))}
                                </div>
                              </div>
                              <h3 className="text-sm font-semibold text-white/90 mt-2 leading-snug" title={item.title}>{item.title}</h3>
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-white/35">
                                <span className="flex items-center gap-1">{I.clock}
                                  {item.scheduledFor ? fmt(item.scheduledFor) : <span className="text-blue-300 font-semibold">ASAP</span>}
                                </span>
                                <span>Added {fmt(item.createdAt)}</span>
                                {item.retryCount > 0 && <span className="text-amber-500">{item.retryCount} {item.retryCount === 1 ? "retry" : "retries"}</span>}
                              </div>
                              {/* Results */}
                              {item.results.length > 0 && (
                                <div className="flex flex-wrap gap-2 mt-3">
                                  {item.results.map((r) => (
                                    <span key={r.target} className={`inline-flex items-center gap-1.5 text-xs rounded-lg px-2.5 py-1 font-medium ${r.ok ? "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-200" : "bg-red-500/10 text-red-300 ring-1 ring-red-200"}`}>
                                      <span className={`w-1.5 h-1.5 rounded-full ${r.ok ? "bg-emerald-500" : "bg-red-500"}`} />
                                      <span className="capitalize">{r.target}</span>
                                      {r.externalUrl && <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 opacity-70 hover:opacity-100">↗</a>}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {item.lastError && !item.results.length && (
                                <p className="text-xs text-red-400 mt-2 bg-red-500/10 rounded-lg px-3 py-2 border border-red-500/25">{item.lastError}</p>
                              )}
                            </div>

                            {/* Right: actions */}
                            <div className="flex-shrink-0 flex flex-col gap-2 min-w-[130px]">
                              {canAct && (
                                <Btn variant="success" size="sm" className="w-full" disabled={isPublishing} onClick={() => publishNow(item)}>
                                  {isPublishing ? <><Spinner /> Publishing…</> : <>{I.bolt} Publish now</>}
                                </Btn>
                              )}
                              {item.status === "queued" && (
                                <Btn variant="secondary" size="sm" className="w-full" onClick={async () => {
                                  await fetch("/api/publish-queue", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, status: "paused" }) });
                                  fetchPublishQueue();
                                }}>Pause</Btn>
                              )}
                              {item.status === "paused" && (
                                <Btn variant="secondary" size="sm" className="w-full" onClick={async () => {
                                  await fetch("/api/publish-queue", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, status: "queued" }) });
                                  fetchPublishQueue();
                                }}>Resume</Btn>
                              )}
                              {item.status === "failed" && (
                                <Btn variant="secondary" size="sm" className="w-full" onClick={async () => {
                                  await fetch("/api/publish-queue", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, status: "queued" }) });
                                  fetchPublishQueue();
                                }}>Retry (cron)</Btn>
                              )}
                              <Btn variant="danger" size="sm" className="w-full" onClick={async () => {
                                if (!confirm("Remove this item from the publish queue?")) return;
                                await fetch(`/api/publish-queue?id=${item.id}`, { method: "DELETE" });
                                fetchPublishQueue();
                              }}>{I.trash} Remove</Btn>
                            </div>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* ══ TOPICS ═══════════════════════════════════════════ */}
          {tab === "topics" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Plan topics</h1>
                  <p className="text-sm text-white/45 mt-0.5">Your idea bank. Nothing here generates — approve an idea and push it to the Write queue when it&apos;s ready.</p>
                </div>
              </div>

              <Card>
                <CardHeader title="Add Topic Plan" subtitle="Plan topics here, approve them, then push to the generation queue." />
                <div className="p-6 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                      <Label required>Topic title</Label>
                      <Input value={tForm.topic} onChange={(e) => setTForm({ ...tForm, topic: e.target.value })} placeholder="e.g. How to get a VARA licence in Dubai" />
                    </div>
                    <div>
                      <Label>Focus keyword</Label>
                      <Input value={tForm.focusKeyword} onChange={(e) => setTForm({ ...tForm, focusKeyword: e.target.value })} placeholder="e.g. vara licence dubai" />
                    </div>
                    <div>
                      <Label>Cluster</Label>
                      <Input value={tForm.cluster} onChange={(e) => setTForm({ ...tForm, cluster: e.target.value })} placeholder="e.g. crypto-vara" />
                    </div>
                    <div>
                      <Label>Intent</Label>
                      <Select value={tForm.intent} onChange={(e) => setTForm({ ...tForm, intent: e.target.value })} className="w-full">
                        <option value="informational">Informational</option>
                        <option value="commercial">Commercial</option>
                        <option value="navigational">Navigational</option>
                        <option value="transactional">Transactional</option>
                      </Select>
                    </div>
                    <div>
                      <Label>Priority</Label>
                      <Select value={tForm.priority} onChange={(e) => setTForm({ ...tForm, priority: Number(e.target.value) })} className="w-full">
                        {[1,2,3,4,5].map(n => <option key={n} value={n}>Priority {n}</option>)}
                      </Select>
                    </div>
                    <div className="sm:col-span-2">
                      <Label>Notes</Label>
                      <Input value={tForm.notes} onChange={(e) => setTForm({ ...tForm, notes: e.target.value })} placeholder="Optional notes…" />
                    </div>
                  </div>
                  <div className="border-t border-white/[0.06] pt-4">
                    <p className="text-[11px] font-bold text-white/35 uppercase tracking-widest mb-3">Strategy inputs — carried to generation</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      <div className="sm:col-span-2 lg:col-span-3">
                        <Label>Custom prompt <span className="text-white/35 font-normal">(optional — injected into research, strategy and writing)</span></Label>
                        <textarea
                          value={tForm.customPrompt}
                          onChange={(e) => setTForm({ ...tForm, customPrompt: e.target.value })}
                          placeholder="e.g. Focus on founders relocating from Germany. Emphasise VARA licensing and nominee structures."
                          rows={2}
                          className="w-full border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-gold/20 focus:border-gold/55 resize-none"
                        />
                      </div>
                      <div>
                        <Label>Audience</Label>
                        <Input value={tForm.audience} onChange={(e) => setTForm({ ...tForm, audience: e.target.value })} placeholder="e.g. crypto investors in UAE" />
                      </div>
                      <div>
                        <Label>Primary country</Label>
                        <Input value={tForm.primary_country} onChange={(e) => setTForm({ ...tForm, primary_country: e.target.value })} placeholder="e.g. UAE" />
                      </div>
                      <div>
                        <Label>Secondary countries</Label>
                        <Input value={tForm.secondary_countries} onChange={(e) => setTForm({ ...tForm, secondary_countries: e.target.value })} placeholder="e.g. Saudi Arabia, Bahrain" />
                      </div>
                      <div>
                        <Label>Priority service</Label>
                        <Input value={tForm.priority_service} onChange={(e) => setTForm({ ...tForm, priority_service: e.target.value })} placeholder="e.g. VARA licence" />
                      </div>
                      <div>
                        <Label>Language</Label>
                        <Select value={tForm.language} onChange={(e) => setTForm({ ...tForm, language: e.target.value })} className="w-full">
                          <option value="">Default (British English)</option>
                          {siteLanguages.map(l => <option key={l.code} value={l.code}>{l.name} ({l.code})</option>)}
                        </Select>
                      </div>
                    </div>
                  </div>
                  <Btn variant="primary" onClick={addTopic} disabled={addingTopic || !tForm.topic.trim()}>
                    {addingTopic ? <><Spinner /> Adding…</> : <>{I.plus} Add topic</>}
                  </Btn>
                </div>
              </Card>

              <Card>
                <CardHeader title="All Topics" subtitle={`${topics.length} total · ${topics.filter(t => t.status !== "archived").length} active`} />
                {topics.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>} title="No topics yet" body="Add topic ideas above. Approve them, then push to the generation queue when ready." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white/[0.03]/80 text-[11px] font-bold text-white/35 uppercase tracking-wide border-b border-white/[0.06]">
                          <th className="px-5 py-3 text-left">Topic</th>
                          <th className="px-5 py-3 text-left">Keyword</th>
                          <th className="px-5 py-3 text-left">Cluster</th>
                          <th className="px-5 py-3 text-center">Pri</th>
                          <th className="px-5 py-3 text-center">Status</th>
                          <th className="px-5 py-3 text-left">Added</th>
                          <th className="px-5 py-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.05]">
                        {topics.map((t) => (
                          <tr key={t.id} className={`hover:bg-white/[0.03]/60 transition-colors ${t.status === "archived" ? "opacity-40" : ""}`}>
                            <td className="px-5 py-4 max-w-[240px]">
                              <p className="font-semibold text-white/90 truncate text-sm" title={t.topic}>{t.topic}</p>
                              {t.audience && <p className="text-xs text-gold mt-0.5 truncate">{t.audience}</p>}
                              {t.notes && <p className="text-xs text-white/35 mt-0.5 truncate">{t.notes}</p>}
                            </td>
                            <td className="px-5 py-4 text-xs text-white/45">{t.focusKeyword || <span className="text-white/30">—</span>}</td>
                            <td className="px-5 py-4 text-xs text-white/45">{t.cluster || <span className="text-white/30">—</span>}</td>
                            <td className="px-5 py-4 text-center text-xs font-bold text-white/55">{t.priority}</td>
                            <td className="px-5 py-4 text-center">
                              <Select value={t.status} onChange={(e) => patchTopic(t.id, { status: e.target.value as TopicPlanStatus })}
                                className={`text-xs rounded-lg px-2 py-1 border-0 ring-1 ring-inset font-semibold ${TOPIC_STATUS[t.status].badge}`}>
                                {(["idea","planned","approved","queued","archived"] as TopicPlanStatus[]).map(s => (
                                  <option key={s} value={s}>{TOPIC_STATUS[s].label}</option>
                                ))}
                              </Select>
                            </td>
                            <td className="px-5 py-4 text-xs text-white/35 whitespace-nowrap">{fmt(t.createdAt)}</td>
                            <td className="px-5 py-4">
                              <div className="flex items-center justify-center gap-1.5">
                                {t.status === "approved" && (
                                  <Btn variant="primary" size="sm" onClick={() => patchTopic(t.id, { action: "push_to_queue" } as Partial<TopicPlan> & { action: string })}>
                                    {I.arrow} Queue
                                  </Btn>
                                )}
                                {confirmTopicId === t.id ? (
                                  <>
                                    <Btn variant="danger" size="sm" onClick={() => deleteTopic(t.id)}>Confirm</Btn>
                                    <Btn variant="ghost" size="sm" onClick={() => setConfirmTopicId(null)}>Cancel</Btn>
                                  </>
                                ) : (
                                  <Btn variant="ghost" size="sm" onClick={() => setConfirmTopicId(t.id)}>{I.trash}</Btn>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}

          {/* ══ LINKS ════════════════════════════════════════════ */}
          {tab === "links" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Links</h1>
                  <p className="text-sm text-white/45 mt-0.5">The approved links every generated article can weave in — internal aston.ae pages and trusted external sources.</p>
                </div>
                <div className="flex items-center gap-3">
                  {wpSyncResult && (
                    <p className={`text-xs font-medium ${wpSyncResult.ok ? "text-emerald-300" : "text-red-400"}`}>{wpSyncResult.msg}</p>
                  )}
                  <Btn variant="secondary" onClick={syncWpLinks} disabled={wpSyncing}>
                    {wpSyncing ? <><Spinner /> Syncing…</> : "Sync from WordPress"}
                  </Btn>
                </div>
              </div>

              <Card>
                {editingLink ? (
                  <>
                    <CardHeader title="Edit Link" action={<Btn variant="ghost" size="sm" onClick={() => setEditingLink(null)}>Cancel</Btn>} />
                    <div className="p-6 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="sm:col-span-2">
                          <Label required>URL</Label>
                          <Input value={editingLink.url} onChange={(e) => setEditingLink({ ...editingLink, url: e.target.value })} />
                        </div>
                        <div>
                          <Label required>Title</Label>
                          <Input value={editingLink.title} onChange={(e) => setEditingLink({ ...editingLink, title: e.target.value })} />
                        </div>
                        <div>
                          <Label>Category</Label>
                          <Input value={editingLink.category} onChange={(e) => setEditingLink({ ...editingLink, category: e.target.value })} />
                        </div>
                        <div>
                          <Label>Keywords <span className="text-white/35 font-normal">(comma-separated)</span></Label>
                          <Input value={editingLink.keywords.join(", ")} onChange={(e) => setEditingLink({ ...editingLink, keywords: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
                        </div>
                        <div>
                          <Label>Anchor texts <span className="text-white/35 font-normal">(comma-separated)</span></Label>
                          <Input value={editingLink.anchors.join(", ")} onChange={(e) => setEditingLink({ ...editingLink, anchors: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
                        </div>
                        <div>
                          <Label>Type</Label>
                          <Select value={editingLink.type} onChange={(e) => setEditingLink({ ...editingLink, type: e.target.value as "internal"|"external" })} className="w-full">
                            <option value="internal">Internal</option>
                            <option value="external">External</option>
                          </Select>
                        </div>
                        <div>
                          <Label>Language</Label>
                          <Select value={editingLink.language ?? ""} onChange={(e) => setEditingLink({ ...editingLink, language: e.target.value || undefined })} className="w-full">
                            <option value="">All languages</option>
                            {siteLanguages.map(l => <option key={l.code} value={l.code}>{l.name} ({l.code})</option>)}
                          </Select>
                        </div>
                        <div>
                          <Label>Status</Label>
                          <Select value={editingLink.status} onChange={(e) => setEditingLink({ ...editingLink, status: e.target.value as "active"|"inactive" })} className="w-full">
                            <option value="active">Active</option>
                            <option value="inactive">Inactive</option>
                          </Select>
                        </div>
                      </div>
                      <Btn variant="primary" onClick={saveEditLink}>Save changes</Btn>
                    </div>
                  </>
                ) : (
                  <>
                    <CardHeader title="Add Link" subtitle="Links are automatically inserted into generated posts based on keyword matching." />
                    <div className="p-6 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="sm:col-span-2">
                          <Label required>URL</Label>
                          <Input value={lForm.url} onChange={(e) => setLForm({ ...lForm, url: e.target.value })} placeholder="https://aston.ae/…" />
                        </div>
                        <div>
                          <Label required>Title</Label>
                          <Input value={lForm.title} onChange={(e) => setLForm({ ...lForm, title: e.target.value })} placeholder="Page title" />
                        </div>
                        <div>
                          <Label>Category</Label>
                          <Input value={lForm.category} onChange={(e) => setLForm({ ...lForm, category: e.target.value })} placeholder="e.g. company-formation" />
                        </div>
                        <div>
                          <Label>Keywords <span className="text-white/35 font-normal">(comma-separated)</span></Label>
                          <Input value={lForm.keywords} onChange={(e) => setLForm({ ...lForm, keywords: e.target.value })} placeholder="vara, crypto licence, …" />
                        </div>
                        <div>
                          <Label>Anchor texts <span className="text-white/35 font-normal">(comma-separated)</span></Label>
                          <Input value={lForm.anchors} onChange={(e) => setLForm({ ...lForm, anchors: e.target.value })} placeholder="VARA licence, crypto licence in Dubai" />
                        </div>
                        <div>
                          <Label>Type</Label>
                          <Select value={lForm.type} onChange={(e) => setLForm({ ...lForm, type: e.target.value as "internal"|"external" })} className="w-full">
                            <option value="internal">Internal</option>
                            <option value="external">External</option>
                          </Select>
                        </div>
                        <div>
                          <Label>Language</Label>
                          <Select value={lForm.language} onChange={(e) => setLForm({ ...lForm, language: e.target.value })} className="w-full">
                            <option value="">All languages</option>
                            {siteLanguages.map(l => <option key={l.code} value={l.code}>{l.name} ({l.code})</option>)}
                          </Select>
                        </div>
                      </div>
                      <Btn variant="primary" onClick={addLink} disabled={addingLink || !lForm.url.trim() || !lForm.title.trim()}>
                        {addingLink ? <><Spinner /> Adding…</> : <>{I.plus} Add link</>}
                      </Btn>
                    </div>
                  </>
                )}
              </Card>

              <Card>
                <CardHeader title="Links" subtitle={`${links.filter(l => l.status === "active").length} active · ${links.length} total`} />
                {links.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>} title="No links yet" body="Add internal Aston pages and trusted external sources above." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white/[0.03]/80 text-[11px] font-bold text-white/35 uppercase tracking-wide border-b border-white/[0.06]">
                          <th className="px-5 py-3 text-left">Title</th>
                          <th className="px-5 py-3 text-left">URL</th>
                          <th className="px-5 py-3 text-left">Type</th>
                          <th className="px-5 py-3 text-left">Language</th>
                          <th className="px-5 py-3 text-left">Category</th>
                          <th className="px-5 py-3 text-left">Keywords</th>
                          <th className="px-5 py-3 text-center">Status</th>
                          <th className="px-5 py-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.05]">
                        {links.map((l) => (
                          <tr key={l.id} className={`hover:bg-white/[0.03]/60 transition-colors ${l.status === "inactive" ? "opacity-50" : ""}`}>
                            <td className="px-5 py-4 max-w-[140px]">
                              <p className="font-semibold text-white/90 truncate text-xs">{l.title}</p>
                            </td>
                            <td className="px-5 py-4 max-w-[180px]">
                              <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-xs text-gold hover:underline truncate block">{l.url}</a>
                            </td>
                            <td className="px-5 py-4">
                              <Badge className={l.type === "internal" ? "bg-blue-500/10 text-blue-300 ring-blue-500/25" : "bg-violet-500/10 text-violet-300 ring-violet-500/25"}>{l.type}</Badge>
                            </td>
                            <td className="px-5 py-4 text-xs text-white/55 font-medium uppercase tracking-wide">
                              {l.language
                                ? <span className="px-2 py-0.5 bg-gold/10 text-gold-bright rounded font-semibold">{l.language}</span>
                                : <span className="text-white/30">—</span>}
                            </td>
                            <td className="px-5 py-4 text-xs text-white/45">{l.category || <span className="text-white/30">—</span>}</td>
                            <td className="px-5 py-4 text-xs text-white/45 max-w-[160px] truncate" title={l.keywords.join(", ")}>{l.keywords.join(", ") || <span className="text-white/30">—</span>}</td>
                            <td className="px-5 py-4 text-center">
                              <button onClick={() => toggleLinkStatus(l.id, l.status)}
                                className={`text-xs font-semibold px-2.5 py-1 rounded-lg ring-1 ring-inset transition-all ${l.status === "active" ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25 hover:bg-red-500/10 hover:text-red-300 hover:ring-red-500/25" : "bg-white/[0.07] text-white/45 ring-white/15 hover:bg-emerald-500/10 hover:text-emerald-300 hover:ring-emerald-500/25"}`}>
                                {l.status}
                              </button>
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex items-center justify-center gap-1">
                                <Btn variant="ghost" size="sm" onClick={() => setEditingLink(l)}>{I.edit}</Btn>
                                {confirmLinkId === l.id ? (
                                  <>
                                    <Btn variant="danger" size="sm" onClick={() => deleteLink(l.id)}>Confirm</Btn>
                                    <Btn variant="ghost" size="sm" onClick={() => setConfirmLinkId(null)}>Cancel</Btn>
                                  </>
                                ) : (
                                  <Btn variant="ghost" size="sm" onClick={() => setConfirmLinkId(l.id)}>{I.trash}</Btn>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}

          {/* ══ PERFORMANCE ══════════════════════════════════════ */}
          {tab === "performance" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-display text-2xl text-white/95 tracking-tight">Performance</h1>
                  <p className="text-sm text-white/45 mt-0.5">How published posts are doing in Google Search — synced weekly.</p>
                </div>
              </div>

              <Card>
                <div className="p-6 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-white/90">Performance Sync</h2>
                    <p className="text-xs text-white/45 mt-1">Pulls last 90 days from Google Search Console + GA4. Auto-runs every Monday 03:00 UTC.</p>
                    {syncResult && (
                      <p className={`mt-2.5 text-xs font-semibold ${syncResult.ok ? "text-emerald-300" : "text-red-400"}`}>{syncResult.msg}</p>
                    )}
                  </div>
                  <Btn variant="primary" onClick={() => syncPerformance("sync_all")} disabled={syncing}>
                    {syncing ? <><Spinner /> Syncing…</> : "Sync all posts"}
                  </Btn>
                </div>
              </Card>

              {perfRecords.length > 0 && (() => {
                const high    = perfRecords.filter(p => p.classification === "high").length;
                const medium  = perfRecords.filter(p => p.classification === "medium").length;
                const low     = perfRecords.filter(p => p.classification === "low").length;
                const unknown = perfRecords.filter(p => p.classification === "unknown").length;
                const tracked = perfRecords.filter(p => p.impressions > 0);
                const avgPos  = tracked.length ? (tracked.reduce((s, p) => s + p.avgPosition, 0) / tracked.length).toFixed(1) : "—";
                const avgCtr  = tracked.length ? (tracked.reduce((s, p) => s + p.ctr, 0) / tracked.length).toFixed(1) : "—";
                const totalClicks = perfRecords.reduce((s, p) => s + p.clicks, 0);
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-4">
                    <StatCard label="High" value={high} color="text-emerald-300" />
                    <StatCard label="Medium" value={medium} color="text-amber-300" />
                    <StatCard label="Low" value={low} color="text-red-400" />
                    <StatCard label="Not indexed" value={unknown} color="text-white/35" />
                    <StatCard label="Avg position" value={avgPos} />
                    <StatCard label="Avg CTR %" value={avgCtr} />
                    <StatCard label="Total clicks" value={totalClicks.toLocaleString()} color="text-gold" />
                  </div>
                );
              })()}

              <Card>
                <CardHeader title="Posts" subtitle={`${perfRecords.length} tracked`} />
                {perfRecords.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>} title="No performance data yet" body="Click 'Sync all posts' to pull data from Google Search Console. Ensure GSC credentials are set in Vercel env vars." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-white/[0.03]/80 text-[11px] font-bold text-white/35 uppercase tracking-wide border-b border-white/[0.06]">
                          <th className="px-5 py-3 text-left">Topic</th>
                          <th className="px-5 py-3 text-center">Class</th>
                          <th className="px-5 py-3 text-right">Impressions</th>
                          <th className="px-5 py-3 text-right">Clicks</th>
                          <th className="px-5 py-3 text-right">Avg pos</th>
                          <th className="px-5 py-3 text-right">CTR</th>
                          <th className="px-5 py-3 text-right">Pageviews</th>
                          <th className="px-5 py-3 text-right">Avg time</th>
                          <th className="px-5 py-3 text-left">Synced</th>
                          <th className="px-5 py-3 text-center">Sync</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.05]">
                        {[...perfRecords]
                          .sort((a, b) => {
                            const o: Record<PerformanceClass, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
                            return (o[a.classification] - o[b.classification]) || (a.avgPosition - b.avgPosition);
                          })
                          .map((p) => (
                            <tr key={p.postId} className="hover:bg-white/[0.03]/60 transition-colors">
                              <td className="px-5 py-4 max-w-[200px]">
                                <a href={p.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-white/90 hover:text-gold-bright truncate block text-sm">{p.topic}</a>
                                {p.cluster && <p className="text-xs text-white/35 mt-0.5">{p.cluster}</p>}
                              </td>
                              <td className="px-5 py-4 text-center"><Badge className={PERF_STATUS[p.classification].badge}>{PERF_STATUS[p.classification].label}</Badge></td>
                              <td className="px-5 py-4 text-right text-xs text-white/55 tabular-nums">{p.impressions.toLocaleString()}</td>
                              <td className="px-5 py-4 text-right text-xs font-semibold text-white/90 tabular-nums">{p.clicks.toLocaleString()}</td>
                              <td className="px-5 py-4 text-right text-xs text-white/55 tabular-nums">{p.avgPosition.toFixed(1)}</td>
                              <td className="px-5 py-4 text-right text-xs text-white/55 tabular-nums">{p.ctr.toFixed(1)}%</td>
                              <td className="px-5 py-4 text-right text-xs text-white/55 tabular-nums">{p.pageviews.toLocaleString()}</td>
                              <td className="px-5 py-4 text-right text-xs text-white/55 tabular-nums">{Math.round(p.avgTimeOnPage)}s</td>
                              <td className="px-5 py-4 text-xs text-white/35 whitespace-nowrap">{fmt(p.lastSyncedAt)}</td>
                              <td className="px-5 py-4 text-center">
                                <Btn variant="ghost" size="sm" onClick={() => syncPerformance("sync_post", p.postId)} disabled={syncing}>
                                  {I.refresh}
                                </Btn>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          )}

        </div>
      </main>
    </div>
  );
}
