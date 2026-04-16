"use client";

/**
 * app/admin/page.tsx
 * ─────────────────────────────────────────────────────────────
 * Admin dashboard — 5 tabs:
 *   Dashboard   : stats, scheduler settings, run log
 *   Queue       : topic queue management
 *   Topics      : topic planner (Step 11)
 *   Links       : link manager (Step 1.6)
 *   Performance : GSC + GA4 metrics per post (Step 12)
 */

import { useState, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

type QueueStatus = "queued" | "processing" | "completed" | "failed" | "paused";
type GenerationMode = "topic_only" | "source_assisted" | "improve_existing" | "notes_to_article";
type TopicPlanStatus = "idea" | "planned" | "approved" | "queued" | "archived";

interface QueueItem {
  id: string; topic: string; mode: GenerationMode; priority: number;
  status: QueueStatus; createdAt: string; completedAt: string | null;
  retryCount: number; lastError: string | null;
  wpPostId: number | null; wpEditUrl: string | null;
  qaScore: number | null; qaWarnings: string[];
}
interface QueueStats {
  total: number; queued: number; processing: number;
  completed: number; failed: number; paused: number; completedToday: number;
}
interface SchedulerSettings {
  enabled: boolean; blogsPerDay: number; publishMode: "draft_only";
  maxRetries: number; blockOnQaWarning: boolean; maxPerRun: number;
}
interface RunLog {
  runId: string; startedAt: string; completedAt: string | null;
  topicsAttempted: number; topicsCompleted: number; topicsFailed: number;
  status: "running" | "completed" | "completed_with_errors" | "failed";
}
interface LinkEntry {
  id: string; url: string; title: string;
  type: "internal" | "external"; category: string;
  keywords: string[]; anchors: string[]; status: "active" | "inactive";
}
interface TopicPlan {
  id: string; topic: string; focusKeyword: string;
  cluster: string; intent: string; priority: number;
  status: TopicPlanStatus; notes: string;
  createdAt: string; queuedAt: string | null;
}
type PerformanceClass = "high" | "medium" | "low" | "unknown";
interface PostPerformance {
  postId: string; topic: string; url: string;
  focusKeyword: string; cluster: string;
  publishedDate: string; lastSyncedAt: string;
  impressions: number; clicks: number; avgPosition: number; ctr: number;
  pageviews: number; sessions: number; avgTimeOnPage: number; bounceRate: number;
  classification: PerformanceClass;
}

// ── Helpers ────────────────────────────────────────────────────

const STATUS_COLOURS: Record<QueueStatus, string> = {
  queued: "bg-blue-100 text-blue-800", processing: "bg-yellow-100 text-yellow-800",
  completed: "bg-green-100 text-green-800", failed: "bg-red-100 text-red-800",
  paused: "bg-gray-100 text-gray-600",
};
const RUN_COLOURS: Record<RunLog["status"], string> = {
  running: "bg-yellow-100 text-yellow-800", completed: "bg-green-100 text-green-800",
  completed_with_errors: "bg-orange-100 text-orange-800", failed: "bg-red-100 text-red-800",
};
const TOPIC_STATUS_COLOURS: Record<TopicPlanStatus, string> = {
  idea: "bg-gray-100 text-gray-600", planned: "bg-blue-100 text-blue-700",
  approved: "bg-indigo-100 text-indigo-700", queued: "bg-green-100 text-green-700",
  archived: "bg-gray-50 text-gray-400",
};
const PERF_COLOURS: Record<PerformanceClass, string> = {
  high:    "bg-green-100 text-green-700",
  medium:  "bg-yellow-100 text-yellow-700",
  low:     "bg-red-100 text-red-700",
  unknown: "bg-gray-100 text-gray-500",
};

function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} onClick={onChange} disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-50 ${checked ? "bg-blue-600" : "bg-gray-300"}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────

type Tab = "dashboard" | "queue" | "topics" | "links" | "performance";

export default function AdminPage() {
  const [secret, setSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState("");
  const [tab, setTab] = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(false);

  // Dashboard data
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [settings, setSettings] = useState<SchedulerSettings | null>(null);
  const [runs, setRuns] = useState<RunLog[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);

  // Queue data
  const [items, setItems] = useState<QueueItem[]>([]);
  const [newTopic, setNewTopic] = useState("");
  const [newMode, setNewMode] = useState<GenerationMode>("topic_only");
  const [newPriority, setNewPriority] = useState(3);
  const [adding, setAdding] = useState(false);

  // Topics data
  const [topics, setTopics] = useState<TopicPlan[]>([]);
  const [tForm, setTForm] = useState({ topic: "", focusKeyword: "", cluster: "", intent: "informational", priority: 3, notes: "" });
  const [addingTopic, setAddingTopic] = useState(false);

  // Links data
  const [links, setLinks] = useState<LinkEntry[]>([]);
  const [lForm, setLForm] = useState({ url: "", title: "", type: "internal" as "internal" | "external", category: "", keywords: "", anchors: "", status: "active" as "active" | "inactive" });
  const [addingLink, setAddingLink] = useState(false);
  const [editingLink, setEditingLink] = useState<LinkEntry | null>(null);

  // Performance data
  const [perfRecords, setPerfRecords] = useState<PostPerformance[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

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
    const qData = await qRes.json();
    const schData = await schRes.json();
    setItems(qData.items ?? []);
    setStats(qData.stats ?? null);
    setSettings(schData.settings ?? null);
    setRuns(schData.recentRuns ?? []);
  }, []);

  const fetchTopics = useCallback(async (s: string) => {
    const res = await fetch(`/api/topics?secret=${encodeURIComponent(s)}`);
    const data = await res.json();
    setTopics(data.topics ?? []);
  }, []);

  const fetchLinks = useCallback(async (s: string) => {
    const res = await fetch(`/api/links?secret=${encodeURIComponent(s)}`);
    const data = await res.json();
    setLinks(data.links ?? []);
  }, []);

  const fetchPerformance = useCallback(async (s: string) => {
    const res = await fetch(`/api/performance?secret=${encodeURIComponent(s)}`);
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
    if (!newTopic.trim()) return;
    setAdding(true);
    try {
      await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({ topic: newTopic.trim(), mode: newMode, priority: newPriority }),
      });
      setNewTopic(""); setNewPriority(3);
      await fetchDashboard(secret);
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
    if (!confirm("Remove this item?")) return;
    await fetch("/api/queue", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id }),
    });
    await fetchDashboard(secret);
  }

  // ── Scheduler actions ──────────────────────────────────────────
  async function saveScheduler(patch: Partial<SchedulerSettings>) {
    if (!settings) return;
    setSavingSettings(true);
    try {
      const res = await fetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({ ...settings, ...patch }),
      });
      const data = await res.json();
      setSettings(data.settings);
    } finally { setSavingSettings(false); }
  }

  // ── Topic actions ──────────────────────────────────────────────
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
    } finally { setAddingTopic(false); }
  }

  async function patchTopic(id: string, updates: Partial<TopicPlan> & { action?: string }) {
    await fetch("/api/topics", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id, ...updates }),
    });
    await Promise.all([fetchTopics(secret), fetchDashboard(secret)]);
  }

  async function deleteTopic(id: string) {
    if (!confirm("Delete this topic?")) return;
    await fetch("/api/topics", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id }),
    });
    await fetchTopics(secret);
  }

  // ── Link actions ───────────────────────────────────────────────
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
          anchors: lForm.anchors.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setLForm({ url: "", title: "", type: "internal", category: "", keywords: "", anchors: "", status: "active" });
      await fetchLinks(secret);
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
    if (!confirm("Delete this link?")) return;
    await fetch("/api/links", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id }),
    });
    await fetchLinks(secret);
  }

  // ── Performance actions ────────────────────────────────────────
  async function syncPerformance(action: "sync_all" | "sync_post", postId?: string) {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/performance", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({ action, postId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncResult(`Error: ${data.error}`);
      } else if (action === "sync_all") {
        const r = data.result;
        setSyncResult(`Synced ${r.synced} posts, ${r.skipped} skipped${r.errors.length ? `, ${r.errors.length} errors` : ""}.`);
      } else {
        setSyncResult(`Post synced: ${data.record?.classification ?? "unknown"} (${data.record?.impressions ?? 0} impressions)`);
      }
      await fetchPerformance(secret);
    } finally {
      setSyncing(false);
    }
  }

  // ── Auth screen ────────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-sm bg-white rounded-xl shadow p-8 space-y-5">
          <h1 className="text-2xl font-bold text-gray-900">Admin Login</h1>
          <p className="text-sm text-gray-500">Enter your <code className="bg-gray-100 px-1 rounded">API_SECRET</code> to continue.</p>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()} placeholder="API secret"
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          {authError && <p className="text-sm text-red-600">{authError}</p>}
          <button onClick={handleLogin}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 rounded-lg transition">
            Sign in
          </button>
        </div>
      </div>
    );
  }

  // ── Dashboard ──────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Blog Scheduler</h1>
          <p className="text-xs text-gray-400 mt-0.5">Aston.ae internal tool</p>
        </div>
        <div className="flex items-center gap-3">
          {loading && <span className="text-xs text-gray-400">Loading…</span>}
          <button onClick={() => fetchAll(secret)} className="text-sm text-blue-600 hover:underline">Refresh</button>
          <button onClick={() => { sessionStorage.removeItem("admin_secret"); setAuthed(false); setSecret(""); }}
            className="text-sm text-gray-400 hover:text-gray-600">Sign out</button>
        </div>
      </header>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 px-6">
        <nav className="flex gap-0 -mb-px">
          {(["dashboard", "queue", "topics", "links", "performance"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-3 text-sm font-medium border-b-2 capitalize transition ${tab === t ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              {t}
              {t === "queue" && stats ? <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">{stats.queued}</span> : null}
              {t === "topics" ? <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">{topics.filter(x => x.status !== "archived").length}</span> : null}
              {t === "links" ? <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">{links.filter(x => x.status === "active").length}</span> : null}
              {t === "performance" ? <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">{perfRecords.length}</span> : null}
            </button>
          ))}
        </nav>
      </div>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">

        {/* ══ DASHBOARD TAB ══════════════════════════════════════ */}
        {tab === "dashboard" && (
          <>
            {/* Stats */}
            {stats && (
              <section>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Queue Stats</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                  {[
                    { label: "Total", value: stats.total },
                    { label: "Queued", value: stats.queued },
                    { label: "Processing", value: stats.processing },
                    { label: "Completed", value: stats.completed },
                    { label: "Failed", value: stats.failed },
                    { label: "Paused", value: stats.paused },
                    { label: "Done today", value: stats.completedToday },
                  ].map((s) => (
                    <div key={s.label} className="bg-white rounded-lg shadow-sm p-4 text-center">
                      <p className="text-2xl font-bold text-gray-900">{s.value}</p>
                      <p className="text-xs text-gray-500 mt-1">{s.label}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Scheduler settings */}
            {settings && (
              <section className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-5">Scheduler</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-5">

                  <label className="flex items-center gap-3 cursor-pointer">
                    <Toggle checked={settings.enabled} onChange={() => saveScheduler({ enabled: !settings.enabled })} disabled={savingSettings} />
                    <span className="text-sm font-medium text-gray-700">{settings.enabled ? "Scheduler ON" : "Scheduler OFF"}</span>
                  </label>

                  <label className="flex items-center gap-3 cursor-pointer">
                    <Toggle checked={settings.blockOnQaWarning} onChange={() => saveScheduler({ blockOnQaWarning: !settings.blockOnQaWarning })} disabled={savingSettings} />
                    <span className="text-sm text-gray-700">Block on QA warning</span>
                  </label>

                  <div className="flex items-center gap-3">
                    <label className="text-sm text-gray-700 whitespace-nowrap">Blogs / day</label>
                    <select value={settings.blogsPerDay} onChange={(e) => saveScheduler({ blogsPerDay: Number(e.target.value) })} disabled={savingSettings}
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {[1,2,3,4,5,6,7,8,9,10].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="text-sm text-gray-700 whitespace-nowrap">Max per run</label>
                    <select value={settings.maxPerRun} onChange={(e) => saveScheduler({ maxPerRun: Number(e.target.value) })} disabled={savingSettings}
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>

                  <div className="flex items-center gap-3">
                    <label className="text-sm text-gray-700 whitespace-nowrap">Max retries</label>
                    <select value={settings.maxRetries} onChange={(e) => saveScheduler({ maxRetries: Number(e.target.value) })} disabled={savingSettings}
                      className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {[0,1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>

                  <p className="text-xs text-gray-400 self-center">Runs 08:00 · 11:00 · 14:00 · 17:00 · 20:00 UTC</p>
                </div>
              </section>
            )}

            {/* Run log */}
            {runs.length > 0 && (
              <section className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Recent Runs</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-4 py-3 text-left">Run ID</th>
                        <th className="px-4 py-3 text-left">Started</th>
                        <th className="px-4 py-3 text-left">Completed</th>
                        <th className="px-4 py-3 text-center">Tried</th>
                        <th className="px-4 py-3 text-center">Done</th>
                        <th className="px-4 py-3 text-center">Failed</th>
                        <th className="px-4 py-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {[...runs].reverse().map((r) => (
                        <tr key={r.runId} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.runId}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(r.startedAt)}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(r.completedAt)}</td>
                          <td className="px-4 py-3 text-center">{r.topicsAttempted}</td>
                          <td className="px-4 py-3 text-center text-green-600 font-medium">{r.topicsCompleted}</td>
                          <td className="px-4 py-3 text-center text-red-500 font-medium">{r.topicsFailed}</td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${RUN_COLOURS[r.status]}`}>
                              {r.status.replace(/_/g, " ")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}

        {/* ══ QUEUE TAB ══════════════════════════════════════════ */}
        {tab === "queue" && (
          <>
            {/* Add form */}
            <section className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">Add Topic to Queue</h2>
              <div className="flex flex-wrap gap-3">
                <input type="text" value={newTopic} onChange={(e) => setNewTopic(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addQueueItem()} placeholder="Topic title…"
                  className="flex-1 min-w-[220px] border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <select value={newMode} onChange={(e) => setNewMode(e.target.value as GenerationMode)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="topic_only">Topic only</option>
                  <option value="source_assisted">Source assisted</option>
                  <option value="improve_existing">Improve existing</option>
                  <option value="notes_to_article">Notes to article</option>
                </select>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-600">Priority</label>
                  <select value={newPriority} onChange={(e) => setNewPriority(Number(e.target.value))}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <button onClick={addQueueItem} disabled={adding || !newTopic.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition">
                  {adding ? "Adding…" : "Add"}
                </button>
              </div>
            </section>

            {/* Queue table */}
            <section className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Queue ({items.length})</h2>
              </div>
              {items.length === 0 ? (
                <p className="text-sm text-gray-400 px-6 py-8 text-center">Queue is empty.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-4 py-3 text-left">Topic</th>
                        <th className="px-4 py-3 text-left">Mode</th>
                        <th className="px-4 py-3 text-center">Pri</th>
                        <th className="px-4 py-3 text-center">Status</th>
                        <th className="px-4 py-3 text-left">Added</th>
                        <th className="px-4 py-3 text-left">Done</th>
                        <th className="px-4 py-3 text-center">QA</th>
                        <th className="px-4 py-3 text-center">WP</th>
                        <th className="px-4 py-3 text-center">Retries</th>
                        <th className="px-4 py-3 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {items.map((item) => (
                        <tr key={item.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 max-w-[200px]">
                            <p className="font-medium text-gray-900 truncate" title={item.topic}>{item.topic}</p>
                            {item.lastError && <p className="text-xs text-red-500 mt-0.5 truncate" title={item.lastError}>{item.lastError}</p>}
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{item.mode.replace(/_/g, " ")}</td>
                          <td className="px-4 py-3 text-center">
                            <select value={item.priority} onChange={(e) => patchQueue(item.id, { priority: Number(e.target.value) })}
                              disabled={item.status === "completed" || item.status === "processing"}
                              className="border border-gray-200 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-40">
                              {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}
                            </select>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[item.status]}`}>{item.status}</span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(item.createdAt)}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(item.completedAt)}</td>
                          <td className="px-4 py-3 text-center">
                            {item.qaScore != null
                              ? <span className={`text-xs font-semibold ${item.qaScore >= 80 ? "text-green-600" : item.qaScore >= 60 ? "text-yellow-600" : "text-red-600"}`}>{item.qaScore}</span>
                              : "—"}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {item.wpEditUrl
                              ? <a href={item.wpEditUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline text-xs">#{item.wpPostId}</a>
                              : "—"}
                          </td>
                          <td className="px-4 py-3 text-center text-xs text-gray-500">{item.retryCount}</td>
                          <td className="px-4 py-3">
                            <div className="flex justify-center gap-2">
                              {item.status === "paused" && <button onClick={() => patchQueue(item.id, { status: "queued" })} className="text-xs text-blue-600 hover:underline">Resume</button>}
                              {item.status === "queued" && <button onClick={() => patchQueue(item.id, { status: "paused" })} className="text-xs text-yellow-600 hover:underline">Pause</button>}
                              {item.status === "failed" && <button onClick={() => patchQueue(item.id, { status: "queued", retryCount: 0, lastError: null } as Partial<QueueItem>)} className="text-xs text-green-600 hover:underline">Retry</button>}
                              {item.status !== "processing" && <button onClick={() => deleteQueueItem(item.id)} className="text-xs text-red-500 hover:underline">Delete</button>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* ══ TOPICS TAB ═════════════════════════════════════════ */}
        {tab === "topics" && (
          <>
            {/* Add form */}
            <section className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">Add Topic Plan</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input value={tForm.topic} onChange={(e) => setTForm({ ...tForm, topic: e.target.value })} placeholder="Topic title *"
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <input value={tForm.focusKeyword} onChange={(e) => setTForm({ ...tForm, focusKeyword: e.target.value })} placeholder="Focus keyword"
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <input value={tForm.cluster} onChange={(e) => setTForm({ ...tForm, cluster: e.target.value })} placeholder="Cluster (e.g. crypto-vara)"
                  className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <div className="flex gap-3">
                  <select value={tForm.intent} onChange={(e) => setTForm({ ...tForm, intent: e.target.value })}
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="informational">Informational</option>
                    <option value="commercial">Commercial</option>
                    <option value="navigational">Navigational</option>
                    <option value="transactional">Transactional</option>
                  </select>
                  <select value={tForm.priority} onChange={(e) => setTForm({ ...tForm, priority: Number(e.target.value) })}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {[1,2,3,4,5].map((n) => <option key={n} value={n}>P{n}</option>)}
                  </select>
                </div>
                <input value={tForm.notes} onChange={(e) => setTForm({ ...tForm, notes: e.target.value })} placeholder="Notes (optional)"
                  className="sm:col-span-2 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <button onClick={addTopic} disabled={addingTopic || !tForm.topic.trim()}
                className="mt-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition">
                {addingTopic ? "Adding…" : "Add topic"}
              </button>
            </section>

            {/* Topics table */}
            <section className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Topic Plans ({topics.length})</h2>
              </div>
              {topics.length === 0 ? (
                <p className="text-sm text-gray-400 px-6 py-8 text-center">No topics yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-4 py-3 text-left">Topic</th>
                        <th className="px-4 py-3 text-left">Keyword</th>
                        <th className="px-4 py-3 text-left">Cluster</th>
                        <th className="px-4 py-3 text-left">Intent</th>
                        <th className="px-4 py-3 text-center">Pri</th>
                        <th className="px-4 py-3 text-center">Status</th>
                        <th className="px-4 py-3 text-left">Added</th>
                        <th className="px-4 py-3 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {topics.map((t) => (
                        <tr key={t.id} className={`hover:bg-gray-50 ${t.status === "archived" ? "opacity-40" : ""}`}>
                          <td className="px-4 py-3 max-w-[200px]">
                            <p className="font-medium text-gray-900 truncate" title={t.topic}>{t.topic}</p>
                            {t.notes && <p className="text-xs text-gray-400 truncate mt-0.5">{t.notes}</p>}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{t.focusKeyword || "—"}</td>
                          <td className="px-4 py-3 text-xs text-gray-500">{t.cluster || "—"}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 capitalize">{t.intent}</td>
                          <td className="px-4 py-3 text-center text-xs">{t.priority}</td>
                          <td className="px-4 py-3 text-center">
                            <select value={t.status} onChange={(e) => patchTopic(t.id, { status: e.target.value as TopicPlanStatus })}
                              className={`text-xs rounded-full px-2 py-0.5 border-0 font-medium focus:ring-1 focus:ring-blue-400 ${TOPIC_STATUS_COLOURS[t.status]}`}>
                              {(["idea","planned","approved","queued","archived"] as TopicPlanStatus[]).map((s) => (
                                <option key={s} value={s}>{s}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(t.createdAt)}</td>
                          <td className="px-4 py-3">
                            <div className="flex justify-center gap-2">
                              {t.status === "approved" && (
                                <button onClick={() => patchTopic(t.id, { action: "push_to_queue" } as Partial<TopicPlan> & { action: string })}
                                  className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded hover:bg-blue-700">
                                  → Queue
                                </button>
                              )}
                              <button onClick={() => deleteTopic(t.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* ══ LINKS TAB ══════════════════════════════════════════ */}
        {tab === "links" && (
          <>
            {/* Add / Edit form */}
            {editingLink ? (
              <section className="bg-white rounded-xl shadow-sm p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Edit Link</h2>
                  <button onClick={() => setEditingLink(null)} className="text-sm text-gray-400 hover:text-gray-600">Cancel</button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input value={editingLink.url} onChange={(e) => setEditingLink({ ...editingLink, url: e.target.value })} placeholder="URL *"
                    className="sm:col-span-2 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={editingLink.title} onChange={(e) => setEditingLink({ ...editingLink, title: e.target.value })} placeholder="Title *"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={editingLink.category} onChange={(e) => setEditingLink({ ...editingLink, category: e.target.value })} placeholder="Category"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={editingLink.keywords.join(", ")} onChange={(e) => setEditingLink({ ...editingLink, keywords: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} placeholder="Keywords (comma-separated)"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={editingLink.anchors.join(", ")} onChange={(e) => setEditingLink({ ...editingLink, anchors: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} placeholder="Anchors (comma-separated)"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="flex gap-3">
                    <select value={editingLink.type} onChange={(e) => setEditingLink({ ...editingLink, type: e.target.value as "internal" | "external" })}
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="internal">Internal</option>
                      <option value="external">External</option>
                    </select>
                    <select value={editingLink.status} onChange={(e) => setEditingLink({ ...editingLink, status: e.target.value as "active" | "inactive" })}
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>
                <button onClick={saveEditLink} className="mt-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-5 py-2 rounded-lg transition">
                  Save changes
                </button>
              </section>
            ) : (
              <section className="bg-white rounded-xl shadow-sm p-6">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">Add Link</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input value={lForm.url} onChange={(e) => setLForm({ ...lForm, url: e.target.value })} placeholder="URL *"
                    className="sm:col-span-2 border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={lForm.title} onChange={(e) => setLForm({ ...lForm, title: e.target.value })} placeholder="Title *"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={lForm.category} onChange={(e) => setLForm({ ...lForm, category: e.target.value })} placeholder="Category"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={lForm.keywords} onChange={(e) => setLForm({ ...lForm, keywords: e.target.value })} placeholder="Keywords (comma-separated)"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input value={lForm.anchors} onChange={(e) => setLForm({ ...lForm, anchors: e.target.value })} placeholder="Anchor texts (comma-separated)"
                    className="border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <div className="flex gap-3">
                    <select value={lForm.type} onChange={(e) => setLForm({ ...lForm, type: e.target.value as "internal" | "external" })}
                      className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                      <option value="internal">Internal</option>
                      <option value="external">External</option>
                    </select>
                  </div>
                </div>
                <button onClick={addLink} disabled={addingLink || !lForm.url.trim() || !lForm.title.trim()}
                  className="mt-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition">
                  {addingLink ? "Adding…" : "Add link"}
                </button>
              </section>
            )}

            {/* Links table */}
            <section className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Links — {links.filter(l => l.status === "active").length} active / {links.length} total
                </h2>
              </div>
              {links.length === 0 ? (
                <p className="text-sm text-gray-400 px-6 py-8 text-center">No links yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
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
                        <tr key={l.id} className={`hover:bg-gray-50 ${l.status === "inactive" ? "opacity-50" : ""}`}>
                          <td className="px-4 py-3 font-medium text-gray-900 max-w-[160px] truncate" title={l.title}>{l.title}</td>
                          <td className="px-4 py-3 max-w-[180px]">
                            <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline text-xs truncate block" title={l.url}>{l.url}</a>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${l.type === "internal" ? "bg-blue-50 text-blue-700" : "bg-purple-50 text-purple-700"}`}>
                              {l.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{l.category}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate" title={l.keywords.join(", ")}>{l.keywords.join(", ")}</td>
                          <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px] truncate" title={l.anchors.join(", ")}>{l.anchors.join(", ")}</td>
                          <td className="px-4 py-3 text-center">
                            <button onClick={() => toggleLinkStatus(l.id, l.status)}
                              className={`text-xs px-2 py-0.5 rounded-full font-medium transition ${l.status === "active" ? "bg-green-100 text-green-700 hover:bg-red-100 hover:text-red-700" : "bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700"}`}>
                              {l.status}
                            </button>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-center gap-2">
                              <button onClick={() => setEditingLink(l)} className="text-xs text-blue-600 hover:underline">Edit</button>
                              <button onClick={() => deleteLink(l.id)} className="text-xs text-red-500 hover:underline">Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {/* ══ PERFORMANCE TAB ════════════════════════════════════ */}
        {tab === "performance" && (
          <>
            {/* Sync controls */}
            <section className="bg-white rounded-xl shadow-sm p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Performance Sync</h2>
                  <p className="text-xs text-gray-400 mt-1">Fetches last 90 days from Google Search Console + GA4 (if configured). Auto-syncs every Monday 03:00 UTC.</p>
                </div>
                <div className="flex items-center gap-3">
                  {syncResult && <p className={`text-sm ${syncResult.startsWith("Error") ? "text-red-500" : "text-green-600"}`}>{syncResult}</p>}
                  <button onClick={() => syncPerformance("sync_all")} disabled={syncing}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition">
                    {syncing ? "Syncing…" : "Sync all posts"}
                  </button>
                </div>
              </div>
            </section>

            {/* Summary cards */}
            {perfRecords.length > 0 && (() => {
              const high   = perfRecords.filter(p => p.classification === "high").length;
              const medium = perfRecords.filter(p => p.classification === "medium").length;
              const low    = perfRecords.filter(p => p.classification === "low").length;
              const unknown = perfRecords.filter(p => p.classification === "unknown").length;
              const tracked = perfRecords.filter(p => p.impressions > 0);
              const avgPos = tracked.length ? (tracked.reduce((s, p) => s + p.avgPosition, 0) / tracked.length).toFixed(1) : "—";
              const avgCtr = tracked.length ? (tracked.reduce((s, p) => s + p.ctr, 0) / tracked.length).toFixed(1) : "—";
              const totalClicks = perfRecords.reduce((s, p) => s + p.clicks, 0);
              return (
                <section>
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Overview</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                    {[
                      { label: "High performers",   value: high,   colour: "text-green-600" },
                      { label: "Medium performers",  value: medium, colour: "text-yellow-600" },
                      { label: "Low performers",     value: low,    colour: "text-red-500" },
                      { label: "Not indexed yet",    value: unknown, colour: "text-gray-400" },
                      { label: "Avg position",       value: avgPos, colour: "text-gray-700" },
                      { label: "Avg CTR %",          value: avgCtr, colour: "text-gray-700" },
                      { label: "Total clicks (90d)", value: totalClicks, colour: "text-blue-600" },
                    ].map((s) => (
                      <div key={s.label} className="bg-white rounded-lg shadow-sm p-4 text-center">
                        <p className={`text-2xl font-bold ${s.colour}`}>{s.value}</p>
                        <p className="text-xs text-gray-500 mt-1">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })()}

            {/* Posts table */}
            <section className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Posts ({perfRecords.length})</h2>
              </div>
              {perfRecords.length === 0 ? (
                <p className="text-sm text-gray-400 px-6 py-8 text-center">
                  No performance data yet. Click &ldquo;Sync all posts&rdquo; to pull data from Google Search Console.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                      <tr>
                        <th className="px-4 py-3 text-left">Topic</th>
                        <th className="px-4 py-3 text-center">Class</th>
                        <th className="px-4 py-3 text-right">Impressions</th>
                        <th className="px-4 py-3 text-right">Clicks</th>
                        <th className="px-4 py-3 text-right">Avg pos</th>
                        <th className="px-4 py-3 text-right">CTR %</th>
                        <th className="px-4 py-3 text-right">Pageviews</th>
                        <th className="px-4 py-3 text-right">Avg time</th>
                        <th className="px-4 py-3 text-left">Synced</th>
                        <th className="px-4 py-3 text-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {[...perfRecords]
                        .sort((a, b) => {
                          const order: Record<PerformanceClass, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
                          return (order[a.classification] - order[b.classification]) || (a.avgPosition - b.avgPosition);
                        })
                        .map((p) => (
                          <tr key={p.postId} className="hover:bg-gray-50">
                            <td className="px-4 py-3 max-w-[200px]">
                              <a href={p.url} target="_blank" rel="noopener noreferrer"
                                className="font-medium text-gray-900 hover:text-blue-600 truncate block" title={p.topic}>
                                {p.topic}
                              </a>
                              {p.cluster && <p className="text-xs text-gray-400">{p.cluster}</p>}
                            </td>
                            <td className="px-4 py-3 text-center">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${PERF_COLOURS[p.classification]}`}>
                                {p.classification}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right text-sm">{p.impressions.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right text-sm font-medium text-blue-600">{p.clicks.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right text-sm">{p.avgPosition > 0 ? p.avgPosition.toFixed(1) : "—"}</td>
                            <td className="px-4 py-3 text-right text-sm">{p.ctr > 0 ? p.ctr.toFixed(1) + "%" : "—"}</td>
                            <td className="px-4 py-3 text-right text-xs text-gray-500">{p.pageviews > 0 ? p.pageviews.toLocaleString() : "—"}</td>
                            <td className="px-4 py-3 text-right text-xs text-gray-500">
                              {p.avgTimeOnPage > 0 ? `${Math.floor(p.avgTimeOnPage / 60)}m ${Math.round(p.avgTimeOnPage % 60)}s` : "—"}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmt(p.lastSyncedAt)}</td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => syncPerformance("sync_post", p.postId)} disabled={syncing}
                                className="text-xs text-blue-600 hover:underline disabled:opacity-40">
                                Sync
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

      </main>
    </div>
  );
}
