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
}
interface QueueStats {
  total: number; queued: number; processing: number;
  completed: number; failed: number; paused: number; completedToday: number;
}
interface SchedulerSettings {
  enabled: boolean; blogsPerDay: number; publishMode: "draft_only";
  maxRetries: number; blockOnQaWarning: boolean; maxPerRun: number;
  runHour: number; imageModel: "imagen-4" | "gpt-image-1";
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

// ── Status maps ────────────────────────────────────────────────

const Q_STATUS: Record<QueueStatus, { dot: string; badge: string; label: string }> = {
  queued:     { dot: "bg-blue-400",            badge: "bg-blue-50 text-blue-700 ring-blue-600/20",     label: "Queued" },
  processing: { dot: "bg-amber-400 animate-pulse", badge: "bg-amber-50 text-amber-700 ring-amber-600/20", label: "Processing" },
  completed:  { dot: "bg-emerald-500",         badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", label: "Completed" },
  failed:     { dot: "bg-red-500",             badge: "bg-red-50 text-red-700 ring-red-600/20",        label: "Failed" },
  paused:     { dot: "bg-gray-300",            badge: "bg-gray-100 text-gray-600 ring-gray-500/20",    label: "Paused" },
};
const RUN_STATUS: Record<RunLog["status"], string> = {
  running:               "bg-amber-50 text-amber-700 ring-amber-600/20",
  completed:             "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  completed_with_errors: "bg-orange-50 text-orange-700 ring-orange-600/20",
  failed:                "bg-red-50 text-red-700 ring-red-600/20",
};
const TOPIC_STATUS: Record<TopicPlanStatus, { badge: string; label: string }> = {
  idea:     { badge: "bg-gray-100 text-gray-600 ring-gray-500/20",      label: "Idea" },
  planned:  { badge: "bg-blue-50 text-blue-700 ring-blue-600/20",       label: "Planned" },
  approved: { badge: "bg-violet-50 text-violet-700 ring-violet-600/20", label: "Approved" },
  queued:   { badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", label: "Queued" },
  archived: { badge: "bg-gray-50 text-gray-400 ring-gray-500/20",       label: "Archived" },
};
const PQ_STATUS: Record<PublishQueueStatus, { dot: string; badge: string; label: string; bar: string }> = {
  queued:     { dot: "bg-blue-500",            badge: "bg-blue-50 text-blue-700 ring-blue-600/20",      label: "Scheduled",  bar: "bg-blue-500" },
  processing: { dot: "bg-amber-400 animate-pulse", badge: "bg-amber-50 text-amber-700 ring-amber-600/20", label: "Publishing", bar: "bg-amber-400" },
  published:  { dot: "bg-emerald-500",         badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", label: "Published",  bar: "bg-emerald-500" },
  failed:     { dot: "bg-red-500",             badge: "bg-red-50 text-red-700 ring-red-600/20",         label: "Failed",     bar: "bg-red-500" },
  paused:     { dot: "bg-gray-300",            badge: "bg-gray-100 text-gray-600 ring-gray-500/20",     label: "Paused",     bar: "bg-gray-300" },
};
const PERF_STATUS: Record<PerformanceClass, { badge: string; label: string }> = {
  high:    { badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", label: "High" },
  medium:  { badge: "bg-amber-50 text-amber-700 ring-amber-600/20",       label: "Medium" },
  low:     { badge: "bg-red-50 text-red-700 ring-red-600/20",             label: "Low" },
  unknown: { badge: "bg-gray-100 text-gray-500 ring-gray-500/20",         label: "—" },
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
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 ${checked ? "bg-indigo-600" : "bg-gray-200"}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
      className={`block w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition ${className}`} />
  );
}

function Select({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select {...props}
      className={`block rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition ${className}`}>
      {children}
    </select>
  );
}

function Btn({ variant = "primary", size = "md", className = "", disabled, children, onClick, type = "button" }:
  { variant?: "primary"|"secondary"|"danger"|"ghost"|"success"; size?: "sm"|"md"|"lg"; className?: string; disabled?: boolean; children: React.ReactNode; onClick?: () => void; type?: "button"|"submit"|"reset" }) {
  const base = "inline-flex items-center justify-center font-medium rounded-lg transition-all focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed select-none";
  const sizes = { sm: "px-3 py-1.5 text-xs gap-1.5", md: "px-4 py-2.5 text-sm gap-2", lg: "px-5 py-3 text-sm gap-2" };
  const variants = {
    primary:   "bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800 shadow-sm focus:ring-indigo-500",
    secondary: "bg-white text-gray-700 border border-gray-200 hover:bg-gray-50 active:bg-gray-100 shadow-sm focus:ring-gray-400",
    danger:    "bg-white text-red-600 border border-red-200 hover:bg-red-50 active:bg-red-100 shadow-sm focus:ring-red-400",
    ghost:     "text-gray-500 hover:text-gray-800 hover:bg-gray-100 active:bg-gray-200 focus:ring-gray-400",
    success:   "bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 shadow-sm focus:ring-emerald-500",
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-gray-200 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
      <div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0 ml-4">{action}</div>}
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="mb-4 text-gray-200">{icon}</div>
      <p className="text-sm font-semibold text-gray-700">{title}</p>
      <p className="mt-1.5 text-xs text-gray-400 max-w-xs leading-relaxed">{body}</p>
    </div>
  );
}

function StatCard({ label, value, color = "text-gray-900", sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 text-center">
      <p className={`text-3xl font-bold tabular-nums tracking-tight ${color}`}>{value}</p>
      <p className="text-xs font-semibold text-gray-600 mt-1.5">{label}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-semibold text-gray-600 mb-1.5">
      {children}{required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
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
  chevron:   <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>,
  clock:     <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  check:     <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>,
};

// ── Main component ─────────────────────────────────────────────

type Tab = "dashboard" | "queue" | "topics" | "links" | "performance" | "publish_queue";

export default function AdminPage() {
  const [isAuthed, setIsAuthed]     = useState<null | boolean>(null);
  const [loginPw, setLoginPw]       = useState("");
  const [authError, setAuthError]   = useState("");
  const [tab, setTab]         = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(false);

  const [stats, setStats]         = useState<QueueStats | null>(null);
  const [settings, setSettings]   = useState<SchedulerSettings | null>(null);
  const [runs, setRuns]           = useState<RunLog[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);

  const [items, setItems]         = useState<QueueItem[]>([]);
  const [newTopic, setNewTopic]   = useState("");
  const [newMode, setNewMode]     = useState<GenerationMode>("topic_only");
  const [newPriority, setNewPriority] = useState(3);
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
        }),
      });
      setNewTopic(""); setNewPriority(3);
      setNewAudience(""); setNewPrimaryCountry(""); setNewSecondaryCountries(""); setNewPriorityService(""); setNewLanguage(""); setNewCustomPrompt("");
      await fetchDashboard();
      showToast("Topic added to queue");
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-2 h-2 rounded-full bg-indigo-600 animate-pulse" />
    </div>
  );

  if (!isAuthed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-sm px-4">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-indigo-600 text-white mb-5 shadow-lg shadow-indigo-200">
              <svg className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Blog Scheduler</h1>
            <p className="text-sm text-gray-500 mt-1">Aston.ae — internal tool</p>
          </div>
          <Card className="p-8 space-y-4">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label>Password</Label>
                <Input type="password" value={loginPw} onChange={(e) => setLoginPw(e.target.value)}
                  placeholder="Enter password" autoFocus />
              </div>
              {authError && (
                <div className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-xs text-red-700 border border-red-100">
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
  const navItems: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "dashboard",    label: "Dashboard",    icon: I.dashboard },
    { id: "queue",        label: "Gen Queue",    icon: I.queue,   badge: stats?.queued },
    { id: "publish_queue",label: "Publish Queue",icon: I.publish, badge: publishQueueStats?.queued || undefined },
    { id: "topics",       label: "Topics",       icon: I.topics,  badge: topics.filter(x => x.status !== "archived").length || undefined },
    { id: "links",        label: "Links",        icon: I.links,   badge: links.filter(x => x.status === "active").length || undefined },
    { id: "performance",  label: "Performance",  icon: I.perf,    badge: perfRecords.length || undefined },
  ];

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside className="w-60 flex-shrink-0 bg-gray-950 flex flex-col">
        {/* Brand */}
        <div className="px-5 py-5 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-500 flex items-center justify-center flex-shrink-0 shadow-lg shadow-indigo-900/50">
              <svg className="w-[18px] h-[18px] text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">Blog Scheduler</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Aston.ae</p>
            </div>
          </div>
        </div>

        {/* Scheduler toggle */}
        {settings && (
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <button onClick={() => saveScheduler({ enabled: !settings.enabled })} disabled={savingSettings}
              className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-medium transition-all ${settings.enabled ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15" : "bg-white/[0.04] text-gray-400 hover:bg-white/[0.07]"}`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${settings.enabled ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" : "bg-gray-600"}`} />
              <span className="flex-1 text-left">
                <span className="block font-semibold text-[11px]">{settings.enabled ? "Scheduler active" : "Scheduler paused"}</span>
                <span className="block text-[10px] opacity-60 mt-0.5">{settings.enabled ? "Runs daily 08:00 UTC" : "Click to enable"}</span>
              </span>
            </button>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => (
            <button key={item.id} onClick={() => setTab(item.id)}
              className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${tab === item.id ? "bg-indigo-600 text-white shadow-lg shadow-indigo-900/30" : "text-gray-400 hover:bg-white/[0.06] hover:text-white"}`}>
              <span className="flex-shrink-0">{item.icon}</span>
              <span className="flex-1 text-left font-medium text-[13px]">{item.label}</span>
              {item.badge !== undefined && item.badge > 0 && (
                <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none tabular-nums ${tab === item.id ? "bg-white/25 text-white" : "bg-white/10 text-gray-300"}`}>
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Bottom */}
        <div className="px-3 py-3 border-t border-white/[0.06] space-y-0.5">
          <button onClick={() => fetchAll()} disabled={loading}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-400 hover:bg-white/[0.06] hover:text-white transition-all disabled:opacity-40">
            {loading ? <Spinner /> : I.refresh}
            <span className="font-medium text-[13px]">{loading ? "Refreshing…" : "Refresh data"}</span>
          </button>
          <button onClick={() => { fetch("/api/auth", { method: "DELETE" }).finally(() => setIsAuthed(false)); }}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-400 hover:bg-white/[0.06] hover:text-white transition-all">
            {I.signout}
            <span className="font-medium text-[13px]">Sign out</span>
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        {/* Toast */}
        {toast && (
          <div className={`fixed top-5 right-5 z-50 flex items-center gap-2.5 rounded-2xl px-4 py-3.5 text-sm font-medium shadow-xl border transition-all ${toast.ok ? "bg-white text-gray-800 border-gray-100 shadow-gray-200/80" : "bg-red-50 text-red-700 border-red-100"}`}>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${toast.ok ? "bg-emerald-400" : "bg-red-400"}`} />
            {toast.msg}
          </div>
        )}

        <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">

          {/* ══ DASHBOARD ═══════════════════════════════════════ */}
          {tab === "dashboard" && (
            <>
              <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold text-gray-900">Dashboard</h1>
              </div>

              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-4">
                  <StatCard label="All time" value={stats.total} sub="posts in queue" />
                  <StatCard label="Waiting" value={stats.queued} color="text-blue-600" sub="to generate" />
                  <StatCard label="Generating" value={stats.processing} color="text-amber-600" sub="right now" />
                  <StatCard label="Published" value={stats.completed} color="text-emerald-600" sub="all time" />
                  <StatCard label="Failed" value={stats.failed} color="text-red-500" sub="need attention" />
                  <StatCard label="Paused" value={stats.paused} color="text-gray-400" sub="on hold" />
                  <StatCard label="Done today" value={stats.completedToday} color="text-indigo-600" sub="this run" />
                </div>
              )}

              {settings && (
                <Card>
                  <CardHeader title="Scheduler Settings" subtitle="Control when and how posts are generated"
                    action={savingSettings ? <div className="flex items-center gap-2 text-xs text-gray-400"><Spinner /> Saving</div> : undefined} />
                  <div className="p-6 space-y-6">
                    <div className={`flex items-center justify-between rounded-2xl px-5 py-4 ${settings.enabled ? "bg-emerald-50 border border-emerald-100" : "bg-gray-50 border border-gray-100"}`}>
                      <div>
                        <p className={`text-sm font-semibold ${settings.enabled ? "text-emerald-800" : "text-gray-700"}`}>
                          {settings.enabled ? "Scheduler is running" : "Scheduler is paused"}
                        </p>
                        <p className={`text-xs mt-0.5 ${settings.enabled ? "text-emerald-600" : "text-gray-400"}`}>
                          {settings.enabled ? "Generates posts daily at 08:00 UTC" : "Enable to start generating posts automatically"}
                        </p>
                      </div>
                      <Toggle checked={settings.enabled} onChange={() => saveScheduler({ enabled: !settings.enabled })} disabled={savingSettings} />
                    </div>

                    <div>
                      <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-3">Daily Schedule</p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3.5">
                          <p className="text-xs font-medium text-gray-500 mb-1">Run time</p>
                          <p className="text-sm font-bold text-gray-800">08:00 UTC</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">Fixed in vercel.json</p>
                        </div>
                        <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3.5">
                          <p className="text-xs font-medium text-gray-500 mb-2">Posts per day</p>
                          <Select value={settings.blogsPerDay} onChange={(e) => saveScheduler({ blogsPerDay: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                            {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n} {n === 1 ? "post" : "posts"}</option>)}
                          </Select>
                        </div>
                        <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3.5">
                          <p className="text-xs font-medium text-gray-500 mb-2">Posts per run</p>
                          <Select value={settings.maxPerRun} onChange={(e) => saveScheduler({ maxPerRun: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                            {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} {n === 1 ? "post" : "posts"}</option>)}
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-3">Quality Controls</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="flex items-center justify-between rounded-xl bg-gray-50 border border-gray-100 px-4 py-3.5">
                          <div>
                            <p className="text-sm font-medium text-gray-700">Block on QA warning</p>
                            <p className="text-xs text-gray-400 mt-0.5">Only publish posts that pass all checks</p>
                          </div>
                          <Toggle checked={settings.blockOnQaWarning} onChange={() => saveScheduler({ blockOnQaWarning: !settings.blockOnQaWarning })} disabled={savingSettings} />
                        </div>
                        <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3.5">
                          <p className="text-xs font-medium text-gray-500 mb-2">Auto-retries on failure</p>
                          <Select value={settings.maxRetries} onChange={(e) => saveScheduler({ maxRetries: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                            {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n === 0 ? "No retries" : `${n} ${n === 1 ? "retry" : "retries"}`}</option>)}
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-3">Image Generation</p>
                      <div className="rounded-xl bg-gray-50 border border-gray-100 px-4 py-3.5">
                        <p className="text-xs font-medium text-gray-500 mb-2">Image model</p>
                        <Select value={settings.imageModel ?? "imagen-4"} onChange={(e) => saveScheduler({ imageModel: e.target.value as "imagen-4" | "gpt-image-1" })} disabled={savingSettings} className="w-full">
                          <option value="imagen-4">Imagen 4 (Google)</option>
                          <option value="gpt-image-1">GPT-image-1 (OpenAI)</option>
                        </Select>
                      </div>
                    </div>
                  </div>
                </Card>
              )}

              {runs.length > 0 && (
                <Card>
                  <CardHeader title="Recent Runs" subtitle={`${runs.length} run${runs.length !== 1 ? "s" : ""} recorded`} />
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50/80 text-[11px] font-bold text-gray-400 uppercase tracking-wide border-b border-gray-100">
                          {["Run ID","Started","Completed","Tried","Done","Failed","Status"].map(h => (
                            <th key={h} className={`px-5 py-3 ${["Tried","Done","Failed","Status"].includes(h) ? "text-center" : "text-left"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {[...runs].reverse().map((r) => (
                          <tr key={r.runId} className="hover:bg-gray-50/60 transition-colors">
                            <td className="px-5 py-3.5 font-mono text-xs text-gray-400">{r.runId.slice(4, 22)}</td>
                            <td className="px-5 py-3.5 text-xs text-gray-500 whitespace-nowrap">{fmt(r.startedAt)}</td>
                            <td className="px-5 py-3.5 text-xs text-gray-500 whitespace-nowrap">{fmt(r.completedAt)}</td>
                            <td className="px-5 py-3.5 text-center text-sm tabular-nums">{r.topicsAttempted}</td>
                            <td className="px-5 py-3.5 text-center text-sm font-semibold text-emerald-600 tabular-nums">{r.topicsCompleted}</td>
                            <td className="px-5 py-3.5 text-center text-sm font-semibold text-red-500 tabular-nums">{r.topicsFailed}</td>
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

          {/* ══ GEN QUEUE ════════════════════════════════════════ */}
          {tab === "queue" && (
            <>
              <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold text-gray-900">Generation Queue</h1>
              </div>

              <Card>
                <CardHeader title="Add to Queue" subtitle="Topics are picked up by the scheduler, or processed manually." />
                <div className="p-6 space-y-4">
                  <div>
                    <Label>Custom prompt <span className="text-gray-400 font-normal">(optional if topic set — AI will derive title)</span></Label>
                    <textarea
                      value={newCustomPrompt}
                      onChange={(e) => setNewCustomPrompt(e.target.value)}
                      placeholder="e.g. I need a post about the German crypto market, what is legal and what is not, and how Aston VIP can help"
                      rows={2}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 resize-none"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label>Topic title <span className="text-gray-400 font-normal">(optional if custom prompt set)</span></Label>
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
                    <Btn variant="primary" onClick={addQueueItem} disabled={adding || (!newTopic.trim() && newCustomPrompt.trim().length < 10) || !newAudience.trim()}>
                      {adding ? <><Spinner /> Adding…</> : <>{I.plus} Add to queue</>}
                    </Btn>
                  </div>
                  <div>
                    <button type="button" onClick={() => setShowStrategyInputs(v => !v)}
                      className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-semibold transition-colors">
                      <span className={`transition-transform ${showStrategyInputs ? "rotate-90" : ""}`}>{I.chevron}</span>
                      Additional strategy inputs (optional)
                    </button>
                    {showStrategyInputs && (
                      <div className="mt-3 p-4 bg-indigo-50/60 rounded-xl border border-indigo-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        <p className="col-span-full text-xs text-gray-500">These optional fields shape jurisdiction focus, service emphasis, and output language.</p>
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

              <Card>
                <CardHeader title="Queue" subtitle={`${items.length} items · ${items.filter(i => i.status === "queued").length} waiting`} />
                {items.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>} title="Queue is empty" body="Add a topic above to get started. The scheduler processes items automatically when enabled." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50/80 text-[11px] font-bold text-gray-400 uppercase tracking-wide border-b border-gray-100">
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
                      <tbody className="divide-y divide-gray-50">
                        {items.map((item) => (
                          <tr key={item.id} className="hover:bg-gray-50/60 transition-colors">
                            <td className="px-5 py-4 max-w-[240px]">
                              <p className="font-semibold text-gray-900 truncate text-sm" title={item.topic}>{item.topic}</p>
                              {item.lastError && <p className="text-xs text-red-500 mt-0.5 truncate" title={item.lastError}>{item.lastError}</p>}
                              {item.status === "completed" && item.completedAt && <p className="text-xs text-gray-400 mt-0.5">Done {fmt(item.completedAt)}</p>}
                            </td>
                            <td className="px-5 py-4 text-xs text-gray-500 whitespace-nowrap capitalize">{item.mode.replace(/_/g, " ")}</td>
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
                            <td className="px-5 py-4 text-xs text-gray-400 whitespace-nowrap">{fmt(item.createdAt)}</td>
                            <td className="px-5 py-4 text-center">
                              {item.qaScore != null ? (
                                <span className={`text-xs font-bold tabular-nums ${item.qaScore >= 80 ? "text-emerald-600" : item.qaScore >= 60 ? "text-amber-600" : "text-red-500"}`}>
                                  {item.qaScore}<span className="font-normal text-gray-300">/100</span>
                                </span>
                              ) : <span className="text-gray-300 text-xs">—</span>}
                            </td>
                            <td className="px-5 py-4 text-center">
                              {item.wpEditUrl ? (
                                <div className="flex items-center justify-center gap-2">
                                  <a href={item.wpEditUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline font-medium">Edit in WP</a>
                                  {item.wpPostUrl && <a href={item.wpPostUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 hover:text-gray-600 hover:underline">Preview</a>}
                                </div>
                              ) : <span className="text-gray-300 text-xs">—</span>}
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

          {/* ══ PUBLISH QUEUE ════════════════════════════════════ */}
          {tab === "publish_queue" && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-gray-900">Publish Queue</h1>
                  <p className="text-sm text-gray-500 mt-0.5">Articles are dispatched to external platforms by the hourly cron, or you can publish immediately.</p>
                </div>
                <Btn variant="secondary" onClick={() => { setPqLoading(true); fetchPublishQueue().finally(() => setPqLoading(false)); }} disabled={pqLoading}>
                  {pqLoading ? <Spinner /> : I.refresh} Refresh
                </Btn>
              </div>

              {publishQueueStats && (
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-4">
                  <StatCard label="Total" value={publishQueueStats.total} />
                  <StatCard label="Scheduled" value={publishQueueStats.queued} color="text-blue-600" />
                  <StatCard label="Publishing" value={publishQueueStats.processing} color="text-amber-600" />
                  <StatCard label="Published" value={publishQueueStats.published} color="text-emerald-600" />
                  <StatCard label="Failed" value={publishQueueStats.failed} color="text-red-500" />
                  <StatCard label="Paused" value={publishQueueStats.paused} color="text-gray-400" />
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
                                    <span key={t.target} className="text-[10px] font-bold uppercase tracking-wide text-gray-500 bg-gray-100 rounded-md px-2 py-0.5">{t.target}</span>
                                  ))}
                                </div>
                              </div>
                              <h3 className="text-sm font-semibold text-gray-900 mt-2 leading-snug" title={item.title}>{item.title}</h3>
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-gray-400">
                                <span className="flex items-center gap-1">{I.clock}
                                  {item.scheduledFor ? fmt(item.scheduledFor) : <span className="text-blue-600 font-semibold">ASAP</span>}
                                </span>
                                <span>Added {fmt(item.createdAt)}</span>
                                {item.retryCount > 0 && <span className="text-amber-500">{item.retryCount} {item.retryCount === 1 ? "retry" : "retries"}</span>}
                              </div>
                              {/* Results */}
                              {item.results.length > 0 && (
                                <div className="flex flex-wrap gap-2 mt-3">
                                  {item.results.map((r) => (
                                    <span key={r.target} className={`inline-flex items-center gap-1.5 text-xs rounded-lg px-2.5 py-1 font-medium ${r.ok ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-red-50 text-red-700 ring-1 ring-red-200"}`}>
                                      <span className={`w-1.5 h-1.5 rounded-full ${r.ok ? "bg-emerald-500" : "bg-red-500"}`} />
                                      <span className="capitalize">{r.target}</span>
                                      {r.externalUrl && <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 opacity-70 hover:opacity-100">↗</a>}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {item.lastError && !item.results.length && (
                                <p className="text-xs text-red-500 mt-2 bg-red-50 rounded-lg px-3 py-2 border border-red-100">{item.lastError}</p>
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
                <h1 className="text-xl font-bold text-gray-900">Topic Plans</h1>
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
                  <div className="border-t border-gray-100 pt-4">
                    <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest mb-3">Strategy inputs — carried to generation</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      <div className="sm:col-span-2 lg:col-span-3">
                        <Label>Custom prompt <span className="text-gray-400 font-normal">(optional — injected into research, strategy and writing)</span></Label>
                        <textarea
                          value={tForm.customPrompt}
                          onChange={(e) => setTForm({ ...tForm, customPrompt: e.target.value })}
                          placeholder="e.g. Focus on founders relocating from Germany. Emphasise VARA licensing and nominee structures."
                          rows={2}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 resize-none"
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
                        <tr className="bg-gray-50/80 text-[11px] font-bold text-gray-400 uppercase tracking-wide border-b border-gray-100">
                          <th className="px-5 py-3 text-left">Topic</th>
                          <th className="px-5 py-3 text-left">Keyword</th>
                          <th className="px-5 py-3 text-left">Cluster</th>
                          <th className="px-5 py-3 text-center">Pri</th>
                          <th className="px-5 py-3 text-center">Status</th>
                          <th className="px-5 py-3 text-left">Added</th>
                          <th className="px-5 py-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {topics.map((t) => (
                          <tr key={t.id} className={`hover:bg-gray-50/60 transition-colors ${t.status === "archived" ? "opacity-40" : ""}`}>
                            <td className="px-5 py-4 max-w-[240px]">
                              <p className="font-semibold text-gray-900 truncate text-sm" title={t.topic}>{t.topic}</p>
                              {t.audience && <p className="text-xs text-indigo-500 mt-0.5 truncate">{t.audience}</p>}
                              {t.notes && <p className="text-xs text-gray-400 mt-0.5 truncate">{t.notes}</p>}
                            </td>
                            <td className="px-5 py-4 text-xs text-gray-500">{t.focusKeyword || <span className="text-gray-300">—</span>}</td>
                            <td className="px-5 py-4 text-xs text-gray-500">{t.cluster || <span className="text-gray-300">—</span>}</td>
                            <td className="px-5 py-4 text-center text-xs font-bold text-gray-600">{t.priority}</td>
                            <td className="px-5 py-4 text-center">
                              <Select value={t.status} onChange={(e) => patchTopic(t.id, { status: e.target.value as TopicPlanStatus })}
                                className={`text-xs rounded-lg px-2 py-1 border-0 ring-1 ring-inset font-semibold ${TOPIC_STATUS[t.status].badge}`}>
                                {(["idea","planned","approved","queued","archived"] as TopicPlanStatus[]).map(s => (
                                  <option key={s} value={s}>{TOPIC_STATUS[s].label}</option>
                                ))}
                              </Select>
                            </td>
                            <td className="px-5 py-4 text-xs text-gray-400 whitespace-nowrap">{fmt(t.createdAt)}</td>
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
                <h1 className="text-xl font-bold text-gray-900">Link Manager</h1>
                <div className="flex items-center gap-3">
                  {wpSyncResult && (
                    <p className={`text-xs font-medium ${wpSyncResult.ok ? "text-emerald-600" : "text-red-500"}`}>{wpSyncResult.msg}</p>
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
                          <Label>Keywords <span className="text-gray-400 font-normal">(comma-separated)</span></Label>
                          <Input value={editingLink.keywords.join(", ")} onChange={(e) => setEditingLink({ ...editingLink, keywords: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
                        </div>
                        <div>
                          <Label>Anchor texts <span className="text-gray-400 font-normal">(comma-separated)</span></Label>
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
                          <Label>Keywords <span className="text-gray-400 font-normal">(comma-separated)</span></Label>
                          <Input value={lForm.keywords} onChange={(e) => setLForm({ ...lForm, keywords: e.target.value })} placeholder="vara, crypto licence, …" />
                        </div>
                        <div>
                          <Label>Anchor texts <span className="text-gray-400 font-normal">(comma-separated)</span></Label>
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
                        <tr className="bg-gray-50/80 text-[11px] font-bold text-gray-400 uppercase tracking-wide border-b border-gray-100">
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
                      <tbody className="divide-y divide-gray-50">
                        {links.map((l) => (
                          <tr key={l.id} className={`hover:bg-gray-50/60 transition-colors ${l.status === "inactive" ? "opacity-50" : ""}`}>
                            <td className="px-5 py-4 max-w-[140px]">
                              <p className="font-semibold text-gray-900 truncate text-xs">{l.title}</p>
                            </td>
                            <td className="px-5 py-4 max-w-[180px]">
                              <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline truncate block">{l.url}</a>
                            </td>
                            <td className="px-5 py-4">
                              <Badge className={l.type === "internal" ? "bg-blue-50 text-blue-700 ring-blue-600/20" : "bg-violet-50 text-violet-700 ring-violet-600/20"}>{l.type}</Badge>
                            </td>
                            <td className="px-5 py-4 text-xs text-gray-600 font-medium uppercase tracking-wide">
                              {l.language
                                ? <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded font-semibold">{l.language}</span>
                                : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-5 py-4 text-xs text-gray-500">{l.category || <span className="text-gray-300">—</span>}</td>
                            <td className="px-5 py-4 text-xs text-gray-500 max-w-[160px] truncate" title={l.keywords.join(", ")}>{l.keywords.join(", ") || <span className="text-gray-300">—</span>}</td>
                            <td className="px-5 py-4 text-center">
                              <button onClick={() => toggleLinkStatus(l.id, l.status)}
                                className={`text-xs font-semibold px-2.5 py-1 rounded-lg ring-1 ring-inset transition-all ${l.status === "active" ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 hover:bg-red-50 hover:text-red-600 hover:ring-red-600/20" : "bg-gray-100 text-gray-500 ring-gray-500/20 hover:bg-emerald-50 hover:text-emerald-700 hover:ring-emerald-600/20"}`}>
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
                <h1 className="text-xl font-bold text-gray-900">Performance</h1>
              </div>

              <Card>
                <div className="p-6 flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">Performance Sync</h2>
                    <p className="text-xs text-gray-500 mt-1">Pulls last 90 days from Google Search Console + GA4. Auto-runs every Monday 03:00 UTC.</p>
                    {syncResult && (
                      <p className={`mt-2.5 text-xs font-semibold ${syncResult.ok ? "text-emerald-600" : "text-red-500"}`}>{syncResult.msg}</p>
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
                    <StatCard label="High" value={high} color="text-emerald-600" />
                    <StatCard label="Medium" value={medium} color="text-amber-600" />
                    <StatCard label="Low" value={low} color="text-red-500" />
                    <StatCard label="Not indexed" value={unknown} color="text-gray-400" />
                    <StatCard label="Avg position" value={avgPos} />
                    <StatCard label="Avg CTR %" value={avgCtr} />
                    <StatCard label="Total clicks" value={totalClicks.toLocaleString()} color="text-indigo-600" />
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
                        <tr className="bg-gray-50/80 text-[11px] font-bold text-gray-400 uppercase tracking-wide border-b border-gray-100">
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
                      <tbody className="divide-y divide-gray-50">
                        {[...perfRecords]
                          .sort((a, b) => {
                            const o: Record<PerformanceClass, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
                            return (o[a.classification] - o[b.classification]) || (a.avgPosition - b.avgPosition);
                          })
                          .map((p) => (
                            <tr key={p.postId} className="hover:bg-gray-50/60 transition-colors">
                              <td className="px-5 py-4 max-w-[200px]">
                                <a href={p.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-gray-900 hover:text-indigo-600 truncate block text-sm">{p.topic}</a>
                                {p.cluster && <p className="text-xs text-gray-400 mt-0.5">{p.cluster}</p>}
                              </td>
                              <td className="px-5 py-4 text-center"><Badge className={PERF_STATUS[p.classification].badge}>{PERF_STATUS[p.classification].label}</Badge></td>
                              <td className="px-5 py-4 text-right text-xs text-gray-600 tabular-nums">{p.impressions.toLocaleString()}</td>
                              <td className="px-5 py-4 text-right text-xs font-semibold text-gray-900 tabular-nums">{p.clicks.toLocaleString()}</td>
                              <td className="px-5 py-4 text-right text-xs text-gray-600 tabular-nums">{p.avgPosition.toFixed(1)}</td>
                              <td className="px-5 py-4 text-right text-xs text-gray-600 tabular-nums">{p.ctr.toFixed(1)}%</td>
                              <td className="px-5 py-4 text-right text-xs text-gray-600 tabular-nums">{p.pageviews.toLocaleString()}</td>
                              <td className="px-5 py-4 text-right text-xs text-gray-600 tabular-nums">{Math.round(p.avgTimeOnPage)}s</td>
                              <td className="px-5 py-4 text-xs text-gray-400 whitespace-nowrap">{fmt(p.lastSyncedAt)}</td>
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
