"use client";

/**
 * app/admin/page.tsx — Admin dashboard
 * 5 sections: Dashboard · Queue · Topics · Links · Performance
 */

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
  runHour: number;
}
interface RunLog {
  runId: string; startedAt: string; completedAt: string | null;
  topicsAttempted: number; topicsCompleted: number; topicsFailed: number;
  status: "running" | "completed" | "completed_with_errors" | "failed";
}
interface LinkEntry {
  id: string; url: string; title: string; type: "internal" | "external";
  category: string; keywords: string[]; anchors: string[]; status: "active" | "inactive";
}
interface TopicPlan {
  id: string; topic: string; focusKeyword: string; cluster: string;
  intent: string; priority: number; status: TopicPlanStatus; notes: string;
  createdAt: string; queuedAt: string | null;
}
interface PostPerformance {
  postId: string; topic: string; url: string; focusKeyword: string; cluster: string;
  publishedDate: string; lastSyncedAt: string;
  impressions: number; clicks: number; avgPosition: number; ctr: number;
  pageviews: number; sessions: number; avgTimeOnPage: number; bounceRate: number;
  classification: PerformanceClass;
}

// ── Status maps ────────────────────────────────────────────────

const Q_STATUS: Record<QueueStatus, { dot: string; badge: string; label: string }> = {
  queued:     { dot: "bg-blue-400",   badge: "bg-blue-50 text-blue-700 ring-blue-200",   label: "Queued" },
  processing: { dot: "bg-amber-400 animate-pulse", badge: "bg-amber-50 text-amber-700 ring-amber-200", label: "Processing" },
  completed:  { dot: "bg-emerald-400", badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "Completed" },
  failed:     { dot: "bg-red-400",    badge: "bg-red-50 text-red-700 ring-red-200",     label: "Failed" },
  paused:     { dot: "bg-gray-300",   badge: "bg-gray-50 text-gray-600 ring-gray-200",  label: "Paused" },
};
const RUN_STATUS: Record<RunLog["status"], string> = {
  running:               "bg-amber-50 text-amber-700 ring-amber-200",
  completed:             "bg-emerald-50 text-emerald-700 ring-emerald-200",
  completed_with_errors: "bg-orange-50 text-orange-700 ring-orange-200",
  failed:                "bg-red-50 text-red-700 ring-red-200",
};
const TOPIC_STATUS: Record<TopicPlanStatus, string> = {
  idea:     "bg-gray-100 text-gray-600 ring-gray-200",
  planned:  "bg-blue-50 text-blue-700 ring-blue-200",
  approved: "bg-violet-50 text-violet-700 ring-violet-200",
  queued:   "bg-emerald-50 text-emerald-700 ring-emerald-200",
  archived: "bg-gray-50 text-gray-400 ring-gray-100",
};
const PERF_STATUS: Record<PerformanceClass, { badge: string; label: string }> = {
  high:    { badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "High" },
  medium:  { badge: "bg-amber-50 text-amber-700 ring-amber-200",       label: "Medium" },
  low:     { badge: "bg-red-50 text-red-700 ring-red-200",             label: "Low" },
  unknown: { badge: "bg-gray-100 text-gray-500 ring-gray-200",         label: "—" },
};

// ── Shared small components ────────────────────────────────────

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
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 ${checked ? "bg-indigo-600" : "bg-gray-200"}`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
    </button>
  );
}

function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props}
      className={`block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${className}`} />
  );
}

function Select({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select {...props}
      className={`block rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 ${className}`}>
      {children}
    </select>
  );
}

function Btn({ variant = "primary", size = "md", className = "", disabled, children, onClick }:
  { variant?: "primary"|"secondary"|"danger"|"ghost"; size?: "sm"|"md"; className?: string; disabled?: boolean; children: React.ReactNode; onClick?: () => void }) {
  const base = "inline-flex items-center justify-center font-medium rounded-lg transition focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed";
  const sizes = { sm: "px-3 py-1.5 text-xs gap-1.5", md: "px-4 py-2 text-sm gap-2" };
  const variants = {
    primary:   "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500",
    secondary: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:ring-gray-400",
    danger:    "bg-white text-red-600 border border-red-200 hover:bg-red-50 focus:ring-red-400",
    ghost:     "text-gray-500 hover:text-gray-700 hover:bg-gray-100 focus:ring-gray-400",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      {action}
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-3 text-gray-300">{icon}</div>
      <p className="text-sm font-medium text-gray-600">{title}</p>
      <p className="mt-1 text-xs text-gray-400 max-w-xs">{body}</p>
    </div>
  );
}

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-indigo-500" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Nav icons ──────────────────────────────────────────────────
const Icons = {
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
  arrowRight:<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>,
};

// ── Main component ─────────────────────────────────────────────

type Tab = "dashboard" | "queue" | "topics" | "links" | "performance";

export default function AdminPage() {
  const [secret, setSecret]   = useState("");
  const [authed, setAuthed]   = useState(false);
  const [authError, setAuthError] = useState("");
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

  const [topics, setTopics]       = useState<TopicPlan[]>([]);
  const [tForm, setTForm]         = useState({ topic: "", focusKeyword: "", cluster: "", intent: "informational", priority: 3, notes: "" });
  const [addingTopic, setAddingTopic] = useState(false);
  const [confirmTopicId, setConfirmTopicId] = useState<string | null>(null);

  const [links, setLinks]         = useState<LinkEntry[]>([]);
  const [lForm, setLForm]         = useState({ url: "", title: "", type: "internal" as "internal"|"external", category: "", keywords: "", anchors: "", status: "active" as "active"|"inactive" });
  const [addingLink, setAddingLink] = useState(false);
  const [editingLink, setEditingLink] = useState<LinkEntry | null>(null);
  const [confirmLinkId, setConfirmLinkId] = useState<string | null>(null);

  const [perfRecords, setPerfRecords] = useState<PostPerformance[]>([]);
  const [syncing, setSyncing]     = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [toast, setToast]         = useState<{ msg: string; ok: boolean } | null>(null);

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }

  // ── Auth ───────────────────────────────────────────────────────
  useEffect(() => {
    const saved = sessionStorage.getItem("admin_secret");
    if (saved) { setSecret(saved); setAuthed(true); }
  }, []);

  // ── Fetch ──────────────────────────────────────────────────────
  const fetchDashboard = useCallback(async (s: string) => {
    const [qRes, schRes] = await Promise.all([
      fetch(`/api/queue?secret=${encodeURIComponent(s)}`),
      fetch(`/api/scheduler?secret=${encodeURIComponent(s)}`),
    ]);
    if (qRes.status === 401) { setAuthError("Invalid secret."); setAuthed(false); return; }
    const qData   = await qRes.json();
    const schData = await schRes.json();
    setItems(qData.items ?? []);
    setStats(qData.stats ?? null);
    setSettings(schData.settings ?? null);
    setRuns(schData.recentRuns ?? []);
  }, []);

  const fetchTopics = useCallback(async (s: string) => {
    const res  = await fetch(`/api/topics?secret=${encodeURIComponent(s)}`);
    const data = await res.json();
    setTopics(data.topics ?? []);
  }, []);

  const fetchLinks = useCallback(async (s: string) => {
    const res  = await fetch(`/api/links?secret=${encodeURIComponent(s)}`);
    const data = await res.json();
    setLinks(data.links ?? []);
  }, []);

  const fetchPerformance = useCallback(async (s: string) => {
    const res  = await fetch(`/api/performance?secret=${encodeURIComponent(s)}`);
    const data = await res.json();
    setPerfRecords(data.records ?? []);
  }, []);

  const fetchAll = useCallback(async (s: string) => {
    setLoading(true);
    try { await Promise.all([fetchDashboard(s), fetchTopics(s), fetchLinks(s), fetchPerformance(s)]); }
    finally { setLoading(false); }
  }, [fetchDashboard, fetchTopics, fetchLinks, fetchPerformance]);

  const handleLogin = () => {
    if (!secret.trim()) return;
    sessionStorage.setItem("admin_secret", secret);
    setAuthed(true);
    fetchAll(secret);
  };

  useEffect(() => { if (authed && secret) fetchAll(secret); }, [authed, secret, fetchAll]);

  // ── Queue actions ──────────────────────────────────────────────
  async function addQueueItem() {
    if (!newTopic.trim() || !newAudience.trim()) return;
    setAdding(true);
    try {
      await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({
          topic: newTopic.trim(),
          mode: newMode,
          priority: newPriority,
          audience: newAudience.trim() || undefined,
          primary_country: newPrimaryCountry.trim() || undefined,
          secondary_countries: newSecondaryCountries.trim() || undefined,
          priority_service: newPriorityService.trim() || undefined,
          language: newLanguage.trim() || undefined,
        }),
      });
      setNewTopic(""); setNewPriority(3);
      setNewAudience(""); setNewPrimaryCountry(""); setNewSecondaryCountries("");
      setNewPriorityService(""); setNewLanguage("");
      await fetchDashboard(secret);
      showToast("Topic added to queue");
    } finally { setAdding(false); }
  }

  async function patchQueue(id: string, updates: Partial<QueueItem>) {
    await fetch("/api/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id, ...updates }),
    });
    await fetchDashboard(secret);
  }

  async function deleteQueueItem(id: string) {
    await fetch("/api/queue", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id }),
    });
    setConfirmDeleteId(null);
    await fetchDashboard(secret);
    showToast("Item removed");
  }

  // ── Scheduler ──────────────────────────────────────────────────
  async function saveScheduler(patch: Partial<SchedulerSettings>) {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const res  = await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({ ...settings, ...patch }),
      });
      const data = await res.json();
      setSettings(data.settings);
    } finally { setSavingSettings(false); }
  }

  // ── Topics ─────────────────────────────────────────────────────
  async function addTopic() {
    if (!tForm.topic.trim()) return;
    setAddingTopic(true);
    try {
      await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify(tForm),
      });
      setTForm({ topic: "", focusKeyword: "", cluster: "", intent: "informational", priority: 3, notes: "" });
      await fetchTopics(secret);
      showToast("Topic plan created");
    } finally { setAddingTopic(false); }
  }

  async function patchTopic(id: string, updates: Partial<TopicPlan> & { action?: string }) {
    await fetch("/api/topics", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id, ...updates }),
    });
    await Promise.all([fetchTopics(secret), fetchDashboard(secret)]);
    if (updates.action === "push_to_queue") showToast("Topic pushed to generation queue");
  }

  async function deleteTopic(id: string) {
    await fetch("/api/topics", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id }),
    });
    setConfirmTopicId(null);
    await fetchTopics(secret);
    showToast("Topic deleted");
  }

  // ── Links ──────────────────────────────────────────────────────
  async function addLink() {
    if (!lForm.url.trim() || !lForm.title.trim()) return;
    setAddingLink(true);
    try {
      await fetch("/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({
          ...lForm,
          keywords: lForm.keywords.split(",").map((s) => s.trim()).filter(Boolean),
          anchors:  lForm.anchors.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setLForm({ url: "", title: "", type: "internal", category: "", keywords: "", anchors: "", status: "active" });
      await fetchLinks(secret);
      showToast("Link added");
    } finally { setAddingLink(false); }
  }

  async function saveEditLink() {
    if (!editingLink) return;
    await fetch("/api/links", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify(editingLink),
    });
    setEditingLink(null);
    await fetchLinks(secret);
    showToast("Link updated");
  }

  async function toggleLinkStatus(id: string, current: "active" | "inactive") {
    await fetch("/api/links", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id, status: current === "active" ? "inactive" : "active" }),
    });
    await fetchLinks(secret);
  }

  async function deleteLink(id: string) {
    await fetch("/api/links", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id }),
    });
    setConfirmLinkId(null);
    await fetchLinks(secret);
    showToast("Link deleted");
  }

  // ── Performance ────────────────────────────────────────────────
  async function syncPerformance(action: "sync_all" | "sync_post", postId?: string) {
    setSyncing(true); setSyncResult(null);
    try {
      const res  = await fetch("/api/performance", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({ action, postId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncResult({ ok: false, msg: data.error });
      } else if (action === "sync_all") {
        const r = data.result;
        setSyncResult({ ok: true, msg: `${r.synced} posts synced${r.errors.length ? `, ${r.errors.length} errors` : ""}` });
      } else {
        setSyncResult({ ok: true, msg: `Synced — ${data.record?.classification} (${data.record?.impressions?.toLocaleString()} impressions)` });
      }
      await fetchPerformance(secret);
    } finally { setSyncing(false); }
  }

  // ── Login screen ───────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-600 text-white mb-4">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Blog Scheduler</h1>
            <p className="text-sm text-gray-500 mt-1">Aston.ae internal tool</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 p-8 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">API Secret</label>
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()} placeholder="Enter your API_SECRET" autoFocus />
            </div>
            {authError && (
              <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 ring-1 ring-red-200">
                <svg className="w-3.5 h-3.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
                {authError}
              </div>
            )}
            <Btn variant="primary" className="w-full" onClick={handleLogin}>Sign in</Btn>
          </div>
        </div>
      </div>
    );
  }

  // ── App shell ──────────────────────────────────────────────────
  const navItems: { id: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: "dashboard",   label: "Dashboard",   icon: Icons.dashboard },
    { id: "queue",       label: "Queue",       icon: Icons.queue,  badge: stats?.queued },
    { id: "topics",      label: "Topics",      icon: Icons.topics, badge: topics.filter(x => x.status !== "archived").length || undefined },
    { id: "links",       label: "Links",       icon: Icons.links,  badge: links.filter(x => x.status === "active").length || undefined },
    { id: "performance", label: "Performance", icon: Icons.perf,   badge: perfRecords.length || undefined },
  ];

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* ── Sidebar ── */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 flex flex-col">
        {/* Brand */}
        <div className="px-4 py-5 border-b border-gray-700/50">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">Blog Scheduler</p>
              <p className="text-[10px] text-gray-400">Aston.ae</p>
            </div>
          </div>
        </div>

        {/* Scheduler status pill */}
        {settings && (
          <div className="px-4 py-3 border-b border-gray-700/50">
            <button onClick={() => saveScheduler({ enabled: !settings.enabled })} disabled={savingSettings}
              className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-xs font-medium transition ${settings.enabled ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20" : "bg-gray-700/50 text-gray-400 hover:bg-gray-700"}`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${settings.enabled ? "bg-emerald-400 animate-pulse" : "bg-gray-500"}`} />
              <span className="flex-1 text-left">
                <span className="block font-semibold">{settings.enabled ? "Scheduler active" : "Scheduler paused"}</span>
                <span className="block text-[10px] opacity-70 mt-0.5">
                  {settings.enabled
                    ? "Runs daily at 08:00 UTC"
                    : "Click to enable"}
                </span>
              </span>
            </button>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {navItems.map((item) => (
            <button key={item.id} onClick={() => setTab(item.id)}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${tab === item.id ? "bg-indigo-600 text-white" : "text-gray-400 hover:bg-gray-700/60 hover:text-white"}`}>
              {item.icon}
              <span className="flex-1 text-left">{item.label}</span>
              {item.badge !== undefined && item.badge > 0 && (
                <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 leading-none ${tab === item.id ? "bg-white/20 text-white" : "bg-gray-700 text-gray-300"}`}>
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Bottom actions */}
        <div className="px-3 py-3 border-t border-gray-700/50 space-y-0.5">
          <button onClick={() => fetchAll(secret)} disabled={loading}
            className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-gray-700/60 hover:text-white transition disabled:opacity-50">
            {loading ? <Spinner /> : Icons.refresh}
            <span>{loading ? "Loading…" : "Refresh"}</span>
          </button>
          <button onClick={() => { sessionStorage.removeItem("admin_secret"); setAuthed(false); setSecret(""); }}
            className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-gray-700/60 hover:text-white transition">
            {Icons.signout}
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="flex-1 overflow-auto">
        {/* Toast */}
        {toast && (
          <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ring-1 transition-all ${toast.ok ? "bg-white text-gray-800 ring-gray-200" : "bg-red-50 text-red-700 ring-red-200"}`}>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${toast.ok ? "bg-emerald-400" : "bg-red-400"}`} />
            {toast.msg}
          </div>
        )}

        <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">

          {/* ══ DASHBOARD ═══════════════════════════════════════ */}
          {tab === "dashboard" && (
            <>
              <SectionHeader title="Dashboard" />

              {/* Stats row */}
              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">
                  {[
                    { label: "All time posts",  value: stats.total,          color: "text-gray-900",    sub: "in queue" },
                    { label: "Waiting",          value: stats.queued,         color: "text-blue-600",    sub: "to generate" },
                    { label: "Generating",       value: stats.processing,     color: "text-amber-600",   sub: "right now" },
                    { label: "Published",        value: stats.completed,      color: "text-emerald-600", sub: "all time" },
                    { label: "Failed",           value: stats.failed,         color: "text-red-500",     sub: "need attention" },
                    { label: "Paused",           value: stats.paused,         color: "text-gray-500",    sub: "on hold" },
                    { label: "Done today",       value: stats.completedToday, color: "text-indigo-600",  sub: "this run" },
                  ].map((s) => (
                    <div key={s.label} className="bg-white rounded-xl ring-1 ring-gray-200 p-4 text-center">
                      <p className={`text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
                      <p className="text-xs font-medium text-gray-600 mt-1">{s.label}</p>
                      <p className="text-[10px] text-gray-400">{s.sub}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Scheduler settings */}
              {settings && (
                <div className="bg-white rounded-xl ring-1 ring-gray-200 p-6">
                  <div className="flex items-center justify-between mb-5">
                    <h2 className="text-base font-semibold text-gray-900">Scheduler Settings</h2>
                    {savingSettings && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Spinner /> Saving…</div>}
                  </div>

                  {/* Status banner */}
                  <div className={`flex items-center justify-between rounded-xl px-4 py-3.5 mb-6 ${settings.enabled ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-gray-50 ring-1 ring-gray-200"}`}>
                    <div>
                      <p className={`text-sm font-semibold ${settings.enabled ? "text-emerald-700" : "text-gray-600"}`}>
                        {settings.enabled ? "Scheduler is active" : "Scheduler is paused"}
                      </p>
                      <p className={`text-xs mt-0.5 ${settings.enabled ? "text-emerald-600" : "text-gray-400"}`}>
                        {settings.enabled
                          ? "Generates posts daily at 08:00 UTC"
                          : "Enable to start generating posts automatically"}
                      </p>
                    </div>
                    <Toggle checked={settings.enabled} onChange={() => saveScheduler({ enabled: !settings.enabled })} disabled={savingSettings} />
                  </div>

                  {/* Daily schedule */}
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Daily Schedule</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                    <div className="rounded-lg bg-gray-50 px-4 py-3">
                      <p className="text-xs font-medium text-gray-500 mb-1">Run time</p>
                      <p className="text-sm font-semibold text-gray-800">08:00 UTC</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">Fixed — set in vercel.json</p>
                    </div>
                    <div className="rounded-lg bg-gray-50 px-4 py-3">
                      <p className="text-xs font-medium text-gray-500 mb-2">Posts per day</p>
                      <Select value={settings.blogsPerDay} onChange={(e) => saveScheduler({ blogsPerDay: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                        {[1,2,3,4,5,6,7,8,9,10].map(n => <option key={n} value={n}>{n} {n === 1 ? "post" : "posts"}</option>)}
                      </Select>
                    </div>
                    <div className="rounded-lg bg-gray-50 px-4 py-3">
                      <p className="text-xs font-medium text-gray-500 mb-2">Posts per run</p>
                      <Select value={settings.maxPerRun} onChange={(e) => saveScheduler({ maxPerRun: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                        {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} {n === 1 ? "post" : "posts"}</option>)}
                      </Select>
                    </div>
                  </div>

                  {/* Quality controls */}
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Quality Controls</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-3">
                      <div>
                        <p className="text-sm font-medium text-gray-700">Block on QA warning</p>
                        <p className="text-xs text-gray-400 mt-0.5">Only publish posts that pass all checks</p>
                      </div>
                      <Toggle checked={settings.blockOnQaWarning} onChange={() => saveScheduler({ blockOnQaWarning: !settings.blockOnQaWarning })} disabled={savingSettings} />
                    </div>
                    <div className="rounded-lg bg-gray-50 px-4 py-3">
                      <p className="text-xs font-medium text-gray-500 mb-2">Auto-retries on failure</p>
                      <Select value={settings.maxRetries} onChange={(e) => saveScheduler({ maxRetries: Number(e.target.value) })} disabled={savingSettings} className="w-full">
                        {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n === 0 ? "No retries" : `${n} ${n === 1 ? "retry" : "retries"}`}</option>)}
                      </Select>
                    </div>
                  </div>
                </div>
              )}

              {/* Run log */}
              {runs.length > 0 && (
                <div className="bg-white rounded-xl ring-1 ring-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-100">
                    <h2 className="text-base font-semibold text-gray-900">Recent Runs</h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/80 text-xs font-medium text-gray-500 uppercase tracking-wide">
                        <tr>
                          {["Run ID","Started","Completed","Tried","Done","Failed","Status"].map(h => (
                            <th key={h} className={`px-4 py-3 ${h === "Tried"||h === "Done"||h === "Failed"||h === "Status" ? "text-center" : "text-left"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {[...runs].reverse().map((r) => (
                          <tr key={r.runId} className="hover:bg-gray-50/60">
                            <td className="px-4 py-3 font-mono text-xs text-gray-400">{r.runId.slice(4, 22)}</td>
                            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(r.startedAt)}</td>
                            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(r.completedAt)}</td>
                            <td className="px-4 py-3 text-center text-sm">{r.topicsAttempted}</td>
                            <td className="px-4 py-3 text-center text-sm font-medium text-emerald-600">{r.topicsCompleted}</td>
                            <td className="px-4 py-3 text-center text-sm font-medium text-red-500">{r.topicsFailed}</td>
                            <td className="px-4 py-3 text-center"><Badge className={RUN_STATUS[r.status]}>{r.status.replace(/_/g, " ")}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ══ QUEUE ════════════════════════════════════════════ */}
          {tab === "queue" && (
            <>
              {/* Add form */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 p-6">
                <SectionHeader title="Add to Queue" />
                <p className="text-xs text-gray-400 -mt-2 mb-4">Topics added here will be picked up automatically by the scheduler, or you can process them manually.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Topic title <span className="text-red-500">*</span></label>
                    <Input value={newTopic} onChange={(e) => setNewTopic(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addQueueItem()}
                      placeholder="e.g. How to open a company in DIFC" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Target audience <span className="text-red-500">*</span></label>
                    <Input required value={newAudience} onChange={(e) => setNewAudience(e.target.value)} placeholder="e.g. founders, investors, crypto companies" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[auto_auto_auto] gap-3 items-end mb-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Mode</label>
                    <Select value={newMode} onChange={(e) => setNewMode(e.target.value as GenerationMode)}>
                      <option value="topic_only">Topic only</option>
                      <option value="source_assisted">Source assisted</option>
                      <option value="improve_existing">Improve existing</option>
                      <option value="notes_to_article">Notes to article</option>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Priority</label>
                    <Select value={newPriority} onChange={(e) => setNewPriority(Number(e.target.value))} className="w-24">
                      <option value={5}>5 — High</option>
                      <option value={4}>4</option>
                      <option value={3}>3 — Normal</option>
                      <option value={2}>2</option>
                      <option value={1}>1 — Low</option>
                    </Select>
                  </div>
                  <Btn variant="primary" onClick={addQueueItem} disabled={adding || !newTopic.trim() || !newAudience.trim()}>
                    {adding ? <><Spinner /> Adding…</> : <>{Icons.plus} Add to queue</>}
                  </Btn>
                </div>

                {/* Strategy engine optional inputs */}
                <div className="mt-1">
                  <button
                    type="button"
                    onClick={() => setShowStrategyInputs((v) => !v)}
                    className="text-xs text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
                  >
                    <svg className={`w-3 h-3 transition-transform ${showStrategyInputs ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                    Additional strategy inputs (optional)
                  </button>
                  {showStrategyInputs && (
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4 bg-indigo-50/60 rounded-lg ring-1 ring-indigo-100">
                      <p className="col-span-full text-xs text-gray-500 -mb-1">These optional fields shape jurisdiction focus, service emphasis, and output language. Leave blank to let the strategy engine infer from the topic.</p>
                      <div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Primary country</label>
                        <Input value={newPrimaryCountry} onChange={(e) => setNewPrimaryCountry(e.target.value)} placeholder="e.g. UAE" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Secondary countries</label>
                        <Input value={newSecondaryCountries} onChange={(e) => setNewSecondaryCountries(e.target.value)} placeholder="e.g. UK, Germany" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Priority service</label>
                        <Input value={newPriorityService} onChange={(e) => setNewPriorityService(e.target.value)} placeholder="e.g. VARA licensing" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">Language</label>
                        <Input value={newLanguage} onChange={(e) => setNewLanguage(e.target.value)} placeholder="e.g. German (leave blank for British English)" />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Table */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">Generation Queue</h2>
                    <p className="text-xs text-gray-400 mt-0.5">{items.length} items · {items.filter(i => i.status === "queued").length} waiting</p>
                  </div>
                </div>
                {items.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>} title="Queue is empty" body="Add a topic above to get started. The scheduler will process items automatically when enabled." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/80 text-xs font-medium text-gray-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-4 py-3 text-left">Topic</th>
                          <th className="px-4 py-3 text-left">Mode</th>
                          <th className="px-4 py-3 text-center">Priority</th>
                          <th className="px-4 py-3 text-center">Status</th>
                          <th className="px-4 py-3 text-left">Added</th>
                          <th className="px-4 py-3 text-center">QA Score</th>
                          <th className="px-4 py-3 text-center">WordPress Post</th>
                          <th className="px-4 py-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {items.map((item) => (
                          <tr key={item.id} className="hover:bg-gray-50/60 group">
                            <td className="px-4 py-3 max-w-[240px]">
                              <p className="font-medium text-gray-900 truncate" title={item.topic}>{item.topic}</p>
                              {item.lastError && (
                                <p className="text-xs text-red-500 mt-0.5 truncate" title={item.lastError}>
                                  <span className="font-medium">Error:</span> {item.lastError}
                                </p>
                              )}
                              {item.status === "completed" && item.completedAt && (
                                <p className="text-xs text-gray-400 mt-0.5">Done {fmt(item.completedAt)}</p>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap capitalize">{item.mode.replace(/_/g, " ")}</td>
                            <td className="px-4 py-3 text-center">
                              <Select value={item.priority} onChange={(e) => patchQueue(item.id, { priority: Number(e.target.value) })}
                                disabled={item.status === "completed" || item.status === "processing"} className="w-14 disabled:opacity-40 text-center">
                                {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                              </Select>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className="inline-flex items-center gap-1.5">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${Q_STATUS[item.status].dot}`} />
                                <Badge className={Q_STATUS[item.status].badge}>{Q_STATUS[item.status].label}</Badge>
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmt(item.createdAt)}</td>
                            <td className="px-4 py-3 text-center">
                              {item.qaScore != null ? (
                                <span className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${item.qaScore >= 80 ? "text-emerald-600" : item.qaScore >= 60 ? "text-amber-600" : "text-red-500"}`}>
                                  {item.qaScore}<span className="font-normal text-gray-300">/100</span>
                                </span>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3 text-center">
                              {item.wpEditUrl ? (
                                <div className="flex items-center justify-center gap-2">
                                  <a href={item.wpEditUrl} target="_blank" rel="noopener noreferrer"
                                    className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline font-medium">
                                    Edit in WP
                                  </a>
                                  {item.wpPostUrl && (
                                    <a href={item.wpPostUrl} target="_blank" rel="noopener noreferrer"
                                      className="text-xs text-gray-400 hover:text-gray-600 hover:underline">
                                      Preview
                                    </a>
                                  )}
                                </div>
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-center gap-1">
                                {item.status === "paused"  && <Btn variant="ghost" size="sm" onClick={() => patchQueue(item.id, { status: "queued" })}>Resume</Btn>}
                                {item.status === "queued"  && <Btn variant="ghost" size="sm" onClick={() => patchQueue(item.id, { status: "paused" })}>Pause</Btn>}
                                {item.status === "failed"  && <Btn variant="ghost" size="sm" onClick={() => patchQueue(item.id, { status: "queued", retryCount: 0, lastError: null } as Partial<QueueItem>)}>Retry</Btn>}
                                {item.status !== "processing" && (
                                  confirmDeleteId === item.id ? (
                                    <span className="flex items-center gap-1">
                                      <Btn variant="danger" size="sm" onClick={() => deleteQueueItem(item.id)}>Confirm delete</Btn>
                                      <Btn variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Btn>
                                    </span>
                                  ) : (
                                    <Btn variant="ghost" size="sm" onClick={() => setConfirmDeleteId(item.id)}>{Icons.trash}</Btn>
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
              </div>
            </>
          )}

          {/* ══ TOPICS ═══════════════════════════════════════════ */}
          {tab === "topics" && (
            <>
              {/* Add form */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 p-6">
                <SectionHeader title="Add Topic Plan" />
                <p className="text-xs text-gray-400 -mt-2 mb-4">Plan your content here. Set a topic to <strong className="text-gray-600">Approved</strong> then click <strong className="text-gray-600">Queue</strong> to send it for generation.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Topic title <span className="text-red-400">*</span></label>
                    <Input value={tForm.topic} onChange={(e) => setTForm({ ...tForm, topic: e.target.value })} placeholder="e.g. How to get a VARA licence in Dubai" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Focus keyword</label>
                    <Input value={tForm.focusKeyword} onChange={(e) => setTForm({ ...tForm, focusKeyword: e.target.value })} placeholder="e.g. vara licence dubai" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Cluster</label>
                    <Input value={tForm.cluster} onChange={(e) => setTForm({ ...tForm, cluster: e.target.value })} placeholder="e.g. crypto-vara" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Intent</label>
                    <Select value={tForm.intent} onChange={(e) => setTForm({ ...tForm, intent: e.target.value })} className="w-full">
                      <option value="informational">Informational</option>
                      <option value="commercial">Commercial</option>
                      <option value="navigational">Navigational</option>
                      <option value="transactional">Transactional</option>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Priority</label>
                    <Select value={tForm.priority} onChange={(e) => setTForm({ ...tForm, priority: Number(e.target.value) })} className="w-full">
                      {[1,2,3,4,5].map(n => <option key={n} value={n}>Priority {n}</option>)}
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                    <Input value={tForm.notes} onChange={(e) => setTForm({ ...tForm, notes: e.target.value })} placeholder="Optional notes…" />
                  </div>
                </div>
                <div className="mt-4">
                  <Btn variant="primary" onClick={addTopic} disabled={addingTopic || !tForm.topic.trim()}>
                    {addingTopic ? <><Spinner /> Adding…</> : <>{Icons.plus} Add topic</>}
                  </Btn>
                </div>
              </div>

              {/* Table */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h2 className="text-base font-semibold text-gray-900">Topic Plans <span className="ml-1.5 text-sm font-normal text-gray-400">({topics.length})</span></h2>
                </div>
                {topics.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>} title="No topics yet" body="Add topic ideas above. Approve them, then push to the generation queue when ready." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/80 text-xs font-medium text-gray-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-4 py-3 text-left">Topic</th>
                          <th className="px-4 py-3 text-left">Keyword</th>
                          <th className="px-4 py-3 text-left">Cluster</th>
                          <th className="px-4 py-3 text-center">Pri</th>
                          <th className="px-4 py-3 text-center">Status</th>
                          <th className="px-4 py-3 text-left">Added</th>
                          <th className="px-4 py-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {topics.map((t) => (
                          <tr key={t.id} className={`hover:bg-gray-50/60 ${t.status === "archived" ? "opacity-40" : ""}`}>
                            <td className="px-4 py-3 max-w-[220px]">
                              <p className="font-medium text-gray-900 truncate" title={t.topic}>{t.topic}</p>
                              {t.notes && <p className="text-xs text-gray-400 mt-0.5 truncate">{t.notes}</p>}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500">{t.focusKeyword || <span className="text-gray-300">—</span>}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{t.cluster || <span className="text-gray-300">—</span>}</td>
                            <td className="px-4 py-3 text-center text-xs text-gray-500">{t.priority}</td>
                            <td className="px-4 py-3 text-center">
                              <Select value={t.status} onChange={(e) => patchTopic(t.id, { status: e.target.value as TopicPlanStatus })}
                                className={`text-xs rounded-full px-2 py-0.5 border-0 ring-1 ring-inset font-medium ${TOPIC_STATUS[t.status]}`}>
                                {(["idea","planned","approved","queued","archived"] as TopicPlanStatus[]).map(s => (
                                  <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
                                ))}
                              </Select>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmt(t.createdAt)}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-center gap-1">
                                {t.status === "approved" && (
                                  <Btn variant="primary" size="sm" onClick={() => patchTopic(t.id, { action: "push_to_queue" } as Partial<TopicPlan> & { action: string })}>
                                    {Icons.arrowRight} Queue
                                  </Btn>
                                )}
                                {confirmTopicId === t.id ? (
                                  <>
                                    <Btn variant="danger" size="sm" onClick={() => deleteTopic(t.id)}>Confirm</Btn>
                                    <Btn variant="ghost" size="sm" onClick={() => setConfirmTopicId(null)}>Cancel</Btn>
                                  </>
                                ) : (
                                  <Btn variant="ghost" size="sm" onClick={() => setConfirmTopicId(t.id)}>{Icons.trash}</Btn>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ══ LINKS ════════════════════════════════════════════ */}
          {tab === "links" && (
            <>
              {/* Add / Edit form */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 p-6">
                {editingLink ? (
                  <>
                    <SectionHeader title="Edit Link"
                      action={<Btn variant="ghost" size="sm" onClick={() => setEditingLink(null)}>Cancel</Btn>} />
                    <p className="text-xs text-gray-400 -mt-2 mb-4">Update the link details below. Keywords and anchors are used to match this link to relevant generated posts.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-gray-600 mb-1">URL <span className="text-red-400">*</span></label>
                        <Input value={editingLink.url} onChange={(e) => setEditingLink({ ...editingLink, url: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Title <span className="text-red-400">*</span></label>
                        <Input value={editingLink.title} onChange={(e) => setEditingLink({ ...editingLink, title: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                        <Input value={editingLink.category} onChange={(e) => setEditingLink({ ...editingLink, category: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Keywords <span className="text-gray-400">(comma-separated)</span></label>
                        <Input value={editingLink.keywords.join(", ")} onChange={(e) => setEditingLink({ ...editingLink, keywords: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Anchor texts <span className="text-gray-400">(comma-separated)</span></label>
                        <Input value={editingLink.anchors.join(", ")} onChange={(e) => setEditingLink({ ...editingLink, anchors: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
                        <Select value={editingLink.type} onChange={(e) => setEditingLink({ ...editingLink, type: e.target.value as "internal"|"external" })} className="w-full">
                          <option value="internal">Internal</option>
                          <option value="external">External</option>
                        </Select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                        <Select value={editingLink.status} onChange={(e) => setEditingLink({ ...editingLink, status: e.target.value as "active"|"inactive" })} className="w-full">
                          <option value="active">Active</option>
                          <option value="inactive">Inactive</option>
                        </Select>
                      </div>
                    </div>
                    <div className="mt-4">
                      <Btn variant="primary" onClick={saveEditLink}>Save changes</Btn>
                    </div>
                  </>
                ) : (
                  <>
                    <SectionHeader title="Add Link" />
                    <p className="text-xs text-gray-400 -mt-2 mb-4">Links are automatically inserted into generated posts based on keyword matching. Add internal Aston pages and trusted external sources here.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="sm:col-span-2">
                        <label className="block text-xs font-medium text-gray-600 mb-1">URL <span className="text-red-400">*</span></label>
                        <Input value={lForm.url} onChange={(e) => setLForm({ ...lForm, url: e.target.value })} placeholder="https://aston.ae/…" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Title <span className="text-red-400">*</span></label>
                        <Input value={lForm.title} onChange={(e) => setLForm({ ...lForm, title: e.target.value })} placeholder="Page title" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                        <Input value={lForm.category} onChange={(e) => setLForm({ ...lForm, category: e.target.value })} placeholder="e.g. company-formation" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Keywords <span className="text-gray-400">(comma-separated)</span></label>
                        <Input value={lForm.keywords} onChange={(e) => setLForm({ ...lForm, keywords: e.target.value })} placeholder="vara, crypto licence, …" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Anchor texts <span className="text-gray-400">(comma-separated)</span></label>
                        <Input value={lForm.anchors} onChange={(e) => setLForm({ ...lForm, anchors: e.target.value })} placeholder="VARA licence, crypto licence in Dubai" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
                        <Select value={lForm.type} onChange={(e) => setLForm({ ...lForm, type: e.target.value as "internal"|"external" })} className="w-full">
                          <option value="internal">Internal</option>
                          <option value="external">External</option>
                        </Select>
                      </div>
                    </div>
                    <div className="mt-4">
                      <Btn variant="primary" onClick={addLink} disabled={addingLink || !lForm.url.trim() || !lForm.title.trim()}>
                        {addingLink ? <><Spinner /> Adding…</> : <>{Icons.plus} Add link</>}
                      </Btn>
                    </div>
                  </>
                )}
              </div>

              {/* Table */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                  <h2 className="text-base font-semibold text-gray-900">
                    Links <span className="ml-1.5 text-sm font-normal text-gray-400">{links.filter(l => l.status === "active").length} active / {links.length} total</span>
                  </h2>
                </div>
                {links.length === 0 ? (
                  <EmptyState icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>} title="No links yet" body="Links are seeded from data/links.json on first use. Add new ones above." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/80 text-xs font-medium text-gray-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-4 py-3 text-left">Title</th>
                          <th className="px-4 py-3 text-left">URL</th>
                          <th className="px-4 py-3 text-left">Type</th>
                          <th className="px-4 py-3 text-left">Category</th>
                          <th className="px-4 py-3 text-left">Keywords</th>
                          <th className="px-4 py-3 text-left">Anchors</th>
                          <th className="px-4 py-3 text-center">Status</th>
                          <th className="px-4 py-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {links.map((l) => (
                          <tr key={l.id} className={`hover:bg-gray-50/60 ${l.status === "inactive" ? "opacity-50" : ""}`}>
                            <td className="px-4 py-3 max-w-[140px]">
                              <p className="font-medium text-gray-900 truncate text-xs" title={l.title}>{l.title}</p>
                            </td>
                            <td className="px-4 py-3 max-w-[180px]">
                              <a href={l.url} target="_blank" rel="noopener noreferrer"
                                className="text-xs text-indigo-600 hover:underline truncate block" title={l.url}>{l.url}</a>
                            </td>
                            <td className="px-4 py-3">
                              <Badge className={l.type === "internal" ? "bg-blue-50 text-blue-700 ring-blue-200" : "bg-violet-50 text-violet-700 ring-violet-200"}>
                                {l.type}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500">{l.category}</td>
                            <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate" title={l.keywords.join(", ")}>{l.keywords.join(", ")}</td>
                            <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate" title={l.anchors.join(", ")}>{l.anchors.join(", ")}</td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => toggleLinkStatus(l.id, l.status)}
                                className={`text-xs font-medium px-2 py-0.5 rounded-full ring-1 ring-inset transition ${l.status === "active" ? "bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-red-50 hover:text-red-600 hover:ring-red-200" : "bg-gray-50 text-gray-500 ring-gray-200 hover:bg-emerald-50 hover:text-emerald-700 hover:ring-emerald-200"}`}>
                                {l.status}
                              </button>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-center gap-1">
                                <Btn variant="ghost" size="sm" onClick={() => setEditingLink(l)}>{Icons.edit}</Btn>
                                {confirmLinkId === l.id ? (
                                  <>
                                    <Btn variant="danger" size="sm" onClick={() => deleteLink(l.id)}>Confirm</Btn>
                                    <Btn variant="ghost" size="sm" onClick={() => setConfirmLinkId(null)}>Cancel</Btn>
                                  </>
                                ) : (
                                  <Btn variant="ghost" size="sm" onClick={() => setConfirmLinkId(l.id)}>{Icons.trash}</Btn>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ══ PERFORMANCE ══════════════════════════════════════ */}
          {tab === "performance" && (
            <>
              {/* Sync bar */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">Performance Sync</h2>
                    <p className="text-xs text-gray-400 mt-1">Pulls last 90 days from Google Search Console + GA4. Auto-runs every Monday 03:00 UTC.</p>
                    {syncResult && (
                      <p className={`mt-2 text-xs font-medium ${syncResult.ok ? "text-emerald-600" : "text-red-500"}`}>{syncResult.msg}</p>
                    )}
                  </div>
                  <Btn variant="primary" onClick={() => syncPerformance("sync_all")} disabled={syncing}>
                    {syncing ? <><Spinner /> Syncing…</> : "Sync all posts"}
                  </Btn>
                </div>
              </div>

              {/* Summary cards */}
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
                  <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">
                    {[
                      { label: "High",        value: high,        color: "text-emerald-600" },
                      { label: "Medium",      value: medium,      color: "text-amber-600" },
                      { label: "Low",         value: low,         color: "text-red-500" },
                      { label: "Not indexed", value: unknown,     color: "text-gray-400" },
                      { label: "Avg position",value: avgPos,      color: "text-gray-900" },
                      { label: "Avg CTR %",   value: avgCtr,      color: "text-gray-900" },
                      { label: "Total clicks",value: totalClicks.toLocaleString(), color: "text-indigo-600" },
                    ].map(s => (
                      <div key={s.label} className="bg-white rounded-xl ring-1 ring-gray-200 p-4 text-center">
                        <p className={`text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
                        <p className="text-xs text-gray-500 mt-1">{s.label}</p>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Posts table */}
              <div className="bg-white rounded-xl ring-1 ring-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h2 className="text-base font-semibold text-gray-900">Posts <span className="ml-1.5 text-sm font-normal text-gray-400">({perfRecords.length})</span></h2>
                </div>
                {perfRecords.length === 0 ? (
                  <EmptyState
                    icon={<svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth={1} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>}
                    title="No performance data yet"
                    body="Click 'Sync all posts' to pull data from Google Search Console. Make sure GSC credentials are set in Vercel env vars." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50/80 text-xs font-medium text-gray-500 uppercase tracking-wide">
                        <tr>
                          <th className="px-4 py-3 text-left">Topic</th>
                          <th className="px-4 py-3 text-center">Class</th>
                          <th className="px-4 py-3 text-right">Impressions</th>
                          <th className="px-4 py-3 text-right">Clicks</th>
                          <th className="px-4 py-3 text-right">Avg pos</th>
                          <th className="px-4 py-3 text-right">CTR</th>
                          <th className="px-4 py-3 text-right">Pageviews</th>
                          <th className="px-4 py-3 text-right">Avg time</th>
                          <th className="px-4 py-3 text-left">Synced</th>
                          <th className="px-4 py-3 text-center">Sync</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {[...perfRecords]
                          .sort((a, b) => {
                            const o: Record<PerformanceClass, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
                            return (o[a.classification] - o[b.classification]) || (a.avgPosition - b.avgPosition);
                          })
                          .map((p) => (
                            <tr key={p.postId} className="hover:bg-gray-50/60">
                              <td className="px-4 py-3 max-w-[200px]">
                                <a href={p.url} target="_blank" rel="noopener noreferrer"
                                  className="font-medium text-gray-900 hover:text-indigo-600 truncate block text-sm" title={p.topic}>{p.topic}</a>
                                {p.cluster && <p className="text-xs text-gray-400">{p.cluster}</p>}
                              </td>
                              <td className="px-4 py-3 text-center">
                                <Badge className={PERF_STATUS[p.classification].badge}>{PERF_STATUS[p.classification].label}</Badge>
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-sm">{p.impressions.toLocaleString()}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-sm font-semibold text-indigo-600">{p.clicks.toLocaleString()}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-sm">{p.avgPosition > 0 ? p.avgPosition.toFixed(1) : <span className="text-gray-300">—</span>}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-sm">{p.ctr > 0 ? p.ctr.toFixed(1) + "%" : <span className="text-gray-300">—</span>}</td>
                              <td className="px-4 py-3 text-right tabular-nums text-xs text-gray-500">{p.pageviews > 0 ? p.pageviews.toLocaleString() : <span className="text-gray-300">—</span>}</td>
                              <td className="px-4 py-3 text-right text-xs text-gray-500">{p.avgTimeOnPage > 0 ? `${Math.floor(p.avgTimeOnPage / 60)}m ${Math.round(p.avgTimeOnPage % 60)}s` : <span className="text-gray-300">—</span>}</td>
                              <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmt(p.lastSyncedAt)}</td>
                              <td className="px-4 py-3 text-center">
                                <Btn variant="ghost" size="sm" onClick={() => syncPerformance("sync_post", p.postId)} disabled={syncing}>
                                  {Icons.refresh}
                                </Btn>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

        </div>
      </main>
    </div>
  );
}
