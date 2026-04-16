"use client";

/**
 * app/admin/page.tsx
 * ─────────────────────────────────────────────────────────────
 * Admin dashboard — scheduler control, topic queue, run logs.
 * Authenticates via API_SECRET stored in localStorage.
 */

import { useState, useEffect, useCallback } from "react";

// ── Types (mirrored from lib/storage.ts) ──────────────────────

type QueueStatus = "queued" | "processing" | "completed" | "failed" | "paused";
type GenerationMode = "topic_only" | "source_assisted" | "improve_existing" | "notes_to_article";

interface QueueItem {
  id: string;
  topic: string;
  mode: GenerationMode;
  priority: number;
  status: QueueStatus;
  createdAt: string;
  completedAt: string | null;
  retryCount: number;
  lastError: string | null;
  wpPostId: number | null;
  wpEditUrl: string | null;
  qaScore: number | null;
  qaWarnings: string[];
}

interface QueueStats {
  total: number;
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  paused: number;
  completedToday: number;
}

interface SchedulerSettings {
  enabled: boolean;
  blogsPerDay: number;
  publishMode: "draft_only";
  maxRetries: number;
}

interface RunLog {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  topicsAttempted: number;
  topicsCompleted: number;
  topicsFailed: number;
  status: "running" | "completed" | "completed_with_errors" | "failed";
}

// ── Status colour helpers ──────────────────────────────────────

const STATUS_COLOURS: Record<QueueStatus, string> = {
  queued:     "bg-blue-100 text-blue-800",
  processing: "bg-yellow-100 text-yellow-800",
  completed:  "bg-green-100 text-green-800",
  failed:     "bg-red-100 text-red-800",
  paused:     "bg-gray-100 text-gray-600",
};

const RUN_COLOURS: Record<RunLog["status"], string> = {
  running:                "bg-yellow-100 text-yellow-800",
  completed:              "bg-green-100 text-green-800",
  completed_with_errors:  "bg-orange-100 text-orange-800",
  failed:                 "bg-red-100 text-red-800",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// ── Main component ─────────────────────────────────────────────

export default function AdminPage() {
  const [secret, setSecret]         = useState("");
  const [authed, setAuthed]         = useState(false);
  const [authError, setAuthError]   = useState("");

  // data
  const [items, setItems]           = useState<QueueItem[]>([]);
  const [stats, setStats]           = useState<QueueStats | null>(null);
  const [settings, setSettings]     = useState<SchedulerSettings | null>(null);
  const [runs, setRuns]             = useState<RunLog[]>([]);
  const [loading, setLoading]       = useState(false);

  // add-item form
  const [newTopic, setNewTopic]     = useState("");
  const [newMode, setNewMode]       = useState<GenerationMode>("topic_only");
  const [newPriority, setNewPriority] = useState(3);
  const [adding, setAdding]         = useState(false);

  // settings form
  const [savingSettings, setSavingSettings] = useState(false);

  // ── Persist secret in sessionStorage ────────────────────────
  useEffect(() => {
    const saved = sessionStorage.getItem("admin_secret");
    if (saved) { setSecret(saved); setAuthed(true); }
  }, []);

  // ── Data fetching ────────────────────────────────────────────
  const fetchAll = useCallback(async (s: string) => {
    setLoading(true);
    try {
      const [qRes, schRes] = await Promise.all([
        fetch(`/api/queue?secret=${encodeURIComponent(s)}`),
        fetch(`/api/scheduler?secret=${encodeURIComponent(s)}`),
      ]);

      if (qRes.status === 401 || schRes.status === 401) {
        setAuthError("Invalid secret — check your API_SECRET env var.");
        setAuthed(false);
        return;
      }

      const qData   = await qRes.json();
      const schData = await schRes.json();

      setItems(qData.items ?? []);
      setStats(qData.stats ?? null);
      setSettings(schData.settings ?? null);
      setRuns(schData.recentRuns ?? []);
      setAuthError("");
    } catch {
      setAuthError("Network error — could not reach the API.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleLogin = () => {
    if (!secret.trim()) return;
    sessionStorage.setItem("admin_secret", secret);
    setAuthed(true);
    fetchAll(secret);
  };

  useEffect(() => {
    if (authed && secret) fetchAll(secret);
  }, [authed, secret, fetchAll]);

  // ── Queue actions ────────────────────────────────────────────
  async function addItem() {
    if (!newTopic.trim()) return;
    setAdding(true);
    try {
      await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": secret },
        body: JSON.stringify({ topic: newTopic.trim(), mode: newMode, priority: newPriority }),
      });
      setNewTopic("");
      setNewPriority(3);
      await fetchAll(secret);
    } finally {
      setAdding(false);
    }
  }

  async function patchItem(id: string, updates: Partial<QueueItem>) {
    await fetch("/api/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id, ...updates }),
    });
    await fetchAll(secret);
  }

  async function deleteItem(id: string) {
    if (!confirm("Remove this item from the queue?")) return;
    await fetch("/api/queue", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-api-secret": secret },
      body: JSON.stringify({ id }),
    });
    await fetchAll(secret);
  }

  // ── Scheduler actions ────────────────────────────────────────
  async function saveSchedulerSettings(patch: Partial<SchedulerSettings>) {
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
    } finally {
      setSavingSettings(false);
    }
  }

  // ── Auth screen ──────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-sm bg-white rounded-xl shadow p-8 space-y-5">
          <h1 className="text-2xl font-bold text-gray-900">Admin Login</h1>
          <p className="text-sm text-gray-500">Enter your <code className="bg-gray-100 px-1 rounded">API_SECRET</code> to continue.</p>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            placeholder="API secret"
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {authError && <p className="text-sm text-red-600">{authError}</p>}
          <button
            onClick={handleLogin}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 rounded-lg transition"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────
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
          <button
            onClick={() => fetchAll(secret)}
            className="text-sm text-blue-600 hover:underline"
          >
            Refresh
          </button>
          <button
            onClick={() => { sessionStorage.removeItem("admin_secret"); setAuthed(false); setSecret(""); }}
            className="text-sm text-gray-400 hover:text-gray-600"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">

        {/* ── Stats ── */}
        {stats && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Queue Stats</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
              {[
                { label: "Total",      value: stats.total },
                { label: "Queued",     value: stats.queued },
                { label: "Processing", value: stats.processing },
                { label: "Completed",  value: stats.completed },
                { label: "Failed",     value: stats.failed },
                { label: "Paused",     value: stats.paused },
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

        {/* ── Scheduler Settings ── */}
        {settings && (
          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-5">Scheduler</h2>
            <div className="flex flex-wrap items-center gap-8">

              {/* Enable toggle */}
              <label className="flex items-center gap-3 cursor-pointer">
                <button
                  role="switch"
                  aria-checked={settings.enabled}
                  onClick={() => saveSchedulerSettings({ enabled: !settings.enabled })}
                  disabled={savingSettings}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                    settings.enabled ? "bg-blue-600" : "bg-gray-300"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      settings.enabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className="text-sm font-medium text-gray-700">
                  {settings.enabled ? "Scheduler ON" : "Scheduler OFF"}
                </span>
              </label>

              {/* Blogs per day */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-700 font-medium">Blogs / day</label>
                <select
                  value={settings.blogsPerDay}
                  onChange={(e) => saveSchedulerSettings({ blogsPerDay: Number(e.target.value) })}
                  disabled={savingSettings}
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {[1,2,3,4,5,6,7,8,9,10].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              {/* Max retries */}
              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-700 font-medium">Max retries</label>
                <select
                  value={settings.maxRetries}
                  onChange={(e) => saveSchedulerSettings({ maxRetries: Number(e.target.value) })}
                  disabled={savingSettings}
                  className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {[0,1,2,3,4,5].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              <p className="text-xs text-gray-400">Runs at 08:00, 11:00, 14:00, 17:00 &amp; 20:00 UTC</p>
            </div>
          </section>
        )}

        {/* ── Add to queue ── */}
        <section className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-5">Add Topic</h2>
          <div className="flex flex-wrap gap-3">
            <input
              type="text"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
              placeholder="Topic title…"
              className="flex-1 min-w-[220px] border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={newMode}
              onChange={(e) => setNewMode(e.target.value as GenerationMode)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="topic_only">Topic only</option>
              <option value="source_assisted">Source assisted</option>
              <option value="improve_existing">Improve existing</option>
              <option value="notes_to_article">Notes to article</option>
            </select>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600">Priority</label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(Number(e.target.value))}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {[1,2,3,4,5].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <button
              onClick={addItem}
              disabled={adding || !newTopic.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded-lg transition"
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
        </section>

        {/* ── Queue table ── */}
        <section className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Queue</h2>
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
                    <th className="px-4 py-3 text-center">Priority</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 text-left">Added</th>
                    <th className="px-4 py-3 text-left">Completed</th>
                    <th className="px-4 py-3 text-center">QA</th>
                    <th className="px-4 py-3 text-center">WP</th>
                    <th className="px-4 py-3 text-center">Retries</th>
                    <th className="px-4 py-3 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                      {/* Topic */}
                      <td className="px-4 py-3 max-w-[220px]">
                        <p className="font-medium text-gray-900 truncate" title={item.topic}>{item.topic}</p>
                        {item.lastError && (
                          <p className="text-xs text-red-500 mt-0.5 truncate" title={item.lastError}>{item.lastError}</p>
                        )}
                      </td>

                      {/* Mode */}
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {item.mode.replace(/_/g, " ")}
                      </td>

                      {/* Priority */}
                      <td className="px-4 py-3 text-center">
                        <select
                          value={item.priority}
                          onChange={(e) => patchItem(item.id, { priority: Number(e.target.value) })}
                          disabled={item.status === "completed" || item.status === "processing"}
                          className="border border-gray-200 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-40"
                        >
                          {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[item.status]}`}>
                          {item.status}
                        </span>
                      </td>

                      {/* Added */}
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">{fmtDate(item.createdAt)}</td>

                      {/* Completed */}
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">{fmtDate(item.completedAt)}</td>

                      {/* QA score */}
                      <td className="px-4 py-3 text-center">
                        {item.qaScore != null ? (
                          <span className={`text-xs font-semibold ${item.qaScore >= 80 ? "text-green-600" : item.qaScore >= 60 ? "text-yellow-600" : "text-red-600"}`}>
                            {item.qaScore}
                          </span>
                        ) : "—"}
                      </td>

                      {/* WP link */}
                      <td className="px-4 py-3 text-center">
                        {item.wpEditUrl ? (
                          <a href={item.wpEditUrl} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline text-xs">
                            #{item.wpPostId}
                          </a>
                        ) : "—"}
                      </td>

                      {/* Retry count */}
                      <td className="px-4 py-3 text-center text-xs text-gray-500">{item.retryCount}</td>

                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex justify-center gap-2">
                          {item.status === "paused" && (
                            <button
                              onClick={() => patchItem(item.id, { status: "queued" })}
                              className="text-xs text-blue-600 hover:underline"
                            >
                              Resume
                            </button>
                          )}
                          {item.status === "queued" && (
                            <button
                              onClick={() => patchItem(item.id, { status: "paused" })}
                              className="text-xs text-yellow-600 hover:underline"
                            >
                              Pause
                            </button>
                          )}
                          {item.status === "failed" && (
                            <button
                              onClick={() => patchItem(item.id, { status: "queued", retryCount: 0, lastError: null } as Partial<QueueItem>)}
                              className="text-xs text-green-600 hover:underline"
                            >
                              Retry
                            </button>
                          )}
                          {item.status !== "processing" && (
                            <button
                              onClick={() => deleteItem(item.id)}
                              className="text-xs text-red-500 hover:underline"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Run log ── */}
        {runs.length > 0 && (
          <section className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Recent Runs</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-3 text-left">Run ID</th>
                    <th className="px-4 py-3 text-left">Started</th>
                    <th className="px-4 py-3 text-left">Completed</th>
                    <th className="px-4 py-3 text-center">Attempted</th>
                    <th className="px-4 py-3 text-center">Completed</th>
                    <th className="px-4 py-3 text-center">Failed</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {[...runs].reverse().map((r) => (
                    <tr key={r.runId} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.runId}</td>
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.startedAt)}</td>
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(r.completedAt)}</td>
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
      </main>
    </div>
  );
}
