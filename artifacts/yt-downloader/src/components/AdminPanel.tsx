import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity,
  AlertCircle,
  Archive,
  Bot,
  CheckCircle2,
  Clock,
  Cloud,
  Cpu,
  DollarSign,
  Download,
  Gauge,
  HardDrive,
  KeyRound,
  ListChecks,
  RefreshCw,
  Scissors,
  Settings,
  ShieldCheck,
  Sparkles,
  Subtitles,
  Trash2,
  UploadCloud,
  Users,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tone = "neutral" | "good" | "warn" | "bad";

type HttpMetrics = {
  uptimeSec: number;
  totals: {
    requests: number;
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
    avgDurationMs: number;
  };
  recent5m: {
    requests: number;
    status5xx: number;
    errorRatePct: number;
    avgDurationMs: number;
  };
};

type QueueSnapshot = {
  limits?: Record<string, number>;
  queue?: Record<string, number>;
  recentJobs?: AdminJob[];
};

type AdminJob = {
  jobId: string;
  type: string;
  user?: string;
  status: string;
  stage?: string;
  progressPct?: number | null;
  createdAt?: number | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  completedAt?: number | null;
  elapsedMs?: number | null;
  filename?: string | null;
  error?: string | null;
  outputAvailable?: boolean;
  lipSync?: boolean | null;
  translation?: boolean | null;
  targetLang?: string | null;
  runtime?: string | null;
  batchJobId?: string | null;
};

type AdminOverview = {
  ts: number;
  health: {
    nodeEnv: string;
    uptimeSec: number;
    cpu?: { load1m: number; load5m: number; load15m: number; cores: number };
    memory?: { processRssMb: number; processHeapUsedMb: number; systemUsedPct: number };
    disk?: { rootUsedPct: number | null };
  };
  traffic: HttpMetrics;
  alerts: Array<{ level: "info" | "warning" | "critical"; title: string; detail: string }>;
  queues: {
    youtube?: QueueSnapshot;
    subtitles?: QueueSnapshot;
    translator?: { configured: boolean; queueName: string | null; jobDefinition: string | null };
  };
  features: Record<string, boolean>;
  limits: Record<string, number>;
  cost: {
    monthlyBudgetUsd: number;
    currentMonthUsageUsd: number | null;
    gpuMaxRuntimeMinutes: number;
    gpuConcurrency: number;
    notes: string[];
  };
  storage: {
    s3: { enabled: boolean; bucket: string | null; region: string; prefix: string; signedUrlTtlSec: number };
    cleanupNamespaces: string[];
    signedUrlTtlSec: number;
    cleanupHistory?: Array<{
      ts: number; namespace: string; maxAgeHours: number;
      deletedCount: number; bytesFreed: number; scannedCount: number;
      ok: boolean; error?: string;
    }>;
  };
  tools: Array<{ key: string; label: string; status: string; detail: string }>;
  auth: {
    googleClientConfigured: boolean;
    persistence: string;
    approvedUserCount: number;
    approvedAdminCount: number;
    apiAccessCount: number;
    approvedUsers: string[];
    approvedAdmins: string[];
    apiAccessEmails: string[];
  };
  runtime?: {
    features: {
      translatorEnabled?: boolean;
      translatorLipSyncEnabled?: boolean;
      superAgentEnabled?: boolean;
    };
    permissions: {
      translatorAllowedEmails?: string[];
      translatorLipSyncAllowedEmails?: string[];
      superAgentAllowedEmails?: string[];
    };
  };
  jobs?: {
    active: AdminJob[];
    recent: AdminJob[];
    analytics: Record<string, { total: number; active: number; completed: number; failed: number }>;
  };
  userMessages?: {
    emailSubmissionCount: number;
    emailSubmissions: Array<{
      email: string;
      name: string;
      loginMethod: "password" | "google" | "unknown";
      loginEmail: string;
      role: "admin" | "user";
      source: "settings-email-notice";
      userAgent: string;
      submittedAt: number;
      updatedAt: number;
    }>;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" ? `${value}%` : "-";
}

function formatMb(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(value >= 100 ? 0 : 1)} MB` : "-";
}

function toneForTool(status: string): Tone {
  if (["ready", "enabled"].includes(status)) return "good";
  if (status.startsWith("needs")) return "warn";
  if (status === "disabled") return "neutral";
  return "neutral";
}

function formatRelativeMs(value: number | null | undefined): string {
  if (value == null || value < 0) return "-";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTime(value: number | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytesAdmin(value: number | null | undefined): string {
  if (!value) return "0 B";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Stat({
  icon, label, value, tone = "neutral", detail,
}: {
  icon: React.ReactNode; label: string; value: React.ReactNode;
  tone?: Tone; detail?: React.ReactNode;
}) {
  return (
    <div className={cn("admin-stat", `admin-stat--${tone}`)}>
      <span className="admin-stat-icon">{icon}</span>
      <span className="admin-stat-label">{label}</span>
      <strong className="admin-stat-value">{value}</strong>
      {detail ? <span className="admin-stat-detail">{detail}</span> : null}
    </div>
  );
}

/** Section — uses data-section-tab attribute so CSS can show/hide without nth-of-type */
function Section({
  icon, title, children, wide = false, tab,
}: {
  icon: React.ReactNode; title: string; children: React.ReactNode;
  wide?: boolean; tab: string;
}) {
  return (
    <section
      className={cn("admin-section", wide && "admin-section--wide")}
      data-section-tab={tab}
    >
      <div className="admin-section-title">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

function FlagList({ flags }: { flags: Record<string, boolean> }) {
  return (
    <div className="admin-flag-grid">
      {Object.entries(flags).map(([key, value]) => (
        <div key={key} className={cn("admin-flag", value && "admin-flag--on")}>
          <span>{key}</span>
          <strong>{value ? "on" : "off"}</strong>
        </div>
      ))}
    </div>
  );
}

function ToggleRow({
  label, detail, enabled, busy, onToggle,
}: {
  label: string; detail: string; enabled: boolean; busy: boolean; onToggle: () => void;
}) {
  return (
    <div className="admin-toggle-row">
      <div>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className={cn("admin-toggle-btn", enabled && "admin-toggle-on")}
      >
        {enabled ? "Enabled" : "Disabled"}
      </button>
    </div>
  );
}

function ToolGrid({ tools }: { tools: AdminOverview["tools"] }) {
  return (
    <div className="admin-tool-grid">
      {tools.map((tool) => (
        <div key={tool.key} className={cn("admin-tool", `admin-tool--${toneForTool(tool.status)}`)}>
          <div>
            <strong>{tool.label}</strong>
            <span>{tool.detail}</span>
          </div>
          <em>{tool.status}</em>
        </div>
      ))}
    </div>
  );
}

function JobsTable({ jobs }: { jobs: AdminJob[] }) {
  if (jobs.length === 0) {
    return <div className="admin-empty">No jobs found in the current window</div>;
  }
  return (
    <div className="admin-job-table">
      {jobs.map((job) => (
        <div key={`${job.type}-${job.jobId}`} className="admin-job-row">
          <div>
            <strong>{job.type}</strong>
            <span title={job.jobId}>{job.jobId}</span>
          </div>
          <div>
            <strong>{job.status}</strong>
            <span title={job.stage || "-"}>{job.stage || "-"}</span>
          </div>
          <div>
            <strong>{job.progressPct ?? "-"}{job.progressPct != null ? "%" : ""}</strong>
            <span>{formatRelativeMs(job.elapsedMs)}</span>
          </div>
          <div>
            <strong title={job.user || "unknown"}>{job.user || "unknown"}</strong>
            <span>{formatTime(job.startedAt ?? job.createdAt)}</span>
          </div>
          {job.error ? <p className="admin-job-error" title={job.error}>{job.error}</p> : null}
        </div>
      ))}
    </div>
  );
}

/** Email pill list with per-item remove loading */
function EmailPillList({
  items, onRemove, removingSet,
}: {
  items: Array<{ email: string; badge: string }>;
  onRemove: (email: string) => void;
  removingSet: Set<string>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="admin-email-list">
      {items.map((item) => (
        <span
          key={item.email}
          className={cn("admin-email-pill", removingSet.has(item.email) && "admin-email-pill--removing")}
          title={`${item.badge}: ${item.email}`}
        >
          <strong>{item.badge}</strong>
          <span className="admin-email-pill-text">{item.email}</span>
          <button
            type="button"
            onClick={() => onRemove(item.email)}
            disabled={removingSet.has(item.email)}
            aria-label={`Remove ${item.email}`}
            className="admin-pill-remove"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Inline result/feedback message */
function ResultMsg({ msg, isError = false }: { msg: string; isError?: boolean }) {
  if (!msg) return null;
  return (
    <div className={cn("admin-result-msg", isError ? "admin-result-msg--error" : "admin-result-msg--ok")}>
      {isError ? <XCircle className="w-3.5 h-3.5 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
      {msg}
    </div>
  );
}

/** Loading skeleton for initial load */
function AdminSkeleton() {
  return (
    <section className="admin-panel">
      <div className="admin-skeleton-header" />
      <div className="admin-skeleton-tabs" />
      <div className="admin-skeleton-grid">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="admin-skeleton-card" />
        ))}
      </div>
    </section>
  );
}

// ── Main AdminPanel component ─────────────────────────────────────────────────

export function AdminPanel() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<"overview" | "jobs" | "access" | "messages" | "storage" | "tools">("overview");

  // ── Data state ─────────────────────────────────────────────────────────────
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState("");

  // ── Access tab form state ──────────────────────────────────────────────────
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [savingEmail, setSavingEmail] = useState(false);
  const [removingEmails, setRemovingEmails] = useState<Set<string>>(new Set());
  const [accessMsg, setAccessMsg] = useState({ text: "", error: false });
  const [apiAccessEmail, setApiAccessEmail] = useState("");
  const [savingApiAccess, setSavingApiAccess] = useState(false);
  const [removingApiAccess, setRemovingApiAccess] = useState<Set<string>>(new Set());
  const [apiAccessMsg, setApiAccessMsg] = useState({ text: "", error: false });

  // ── Tools tab permission form state ───────────────────────────────────────
  const [lipSyncEmail, setLipSyncEmail] = useState("");
  const [translationEmail, setTranslationEmail] = useState("");
  const [superAgentEmail, setSuperAgentEmail] = useState("");
  const [savingPermission, setSavingPermission] = useState(false);
  const [removingPerms, setRemovingPerms] = useState<Set<string>>(new Set());
  const [toolsMsg, setToolsMsg] = useState({ text: "", error: false });
  const [savingRuntime, setSavingRuntime] = useState(false);

  // ── Jobs tab form state ────────────────────────────────────────────────────
  const [cancelJobId, setCancelJobId] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState({ text: "", error: false });

  // ── Storage tab form state ─────────────────────────────────────────────────
  const [cleanupNamespace, setCleanupNamespace] = useState("youtube/clips");
  const [cleanupHours, setCleanupHours] = useState("24");
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState({ text: "", error: false });

  // ── Derived data ──────────────────────────────────────────────────────────
  const approvedEmails = useMemo(
    () => [
      ...(overview?.auth.approvedAdmins ?? []).map((value) => ({ email: value, badge: "admin" })),
      ...(overview?.auth.approvedUsers ?? []).map((value) => ({ email: value, badge: "user" })),
    ],
    [overview],
  );
  const developerAccessEmails = useMemo(
    () => (overview?.auth.apiAccessEmails ?? []).map((value) => ({ email: value, badge: "api" })),
    [overview],
  );

  const youtubeQueue = overview?.queues.youtube?.queue ?? {};
  const youtubeLimits = overview?.queues.youtube?.limits ?? {};
  const subtitleQueue = overview?.queues.subtitles?.queue ?? {};
  const subtitleLimits = overview?.queues.subtitles?.limits ?? {};
  const activeClipSlots = youtubeQueue.activeClipJobSlotsUsed ?? 0;
  const maxClipSlots = youtubeLimits.maxConcurrentClipJobs ?? overview?.limits.maxConcurrentClipJobs ?? 0;
  const activeSubtitleSlots = subtitleQueue.activeSubtitleJobSlotsUsed ?? 0;
  const maxSubtitleSlots = subtitleLimits.maxConcurrentSubtitleJobs ?? overview?.limits.maxConcurrentSubtitleJobs ?? 0;
  const totalQueued = (youtubeQueue.queuedClipJobs ?? 0) + (subtitleQueue.queuedSubtitleJobs ?? 0);
  const activeJobs =
    (youtubeQueue.activeClipJobs ?? 0) +
    (youtubeQueue.activeDownloads ?? 0) +
    (subtitleQueue.activeJobs ?? 0);
  const budgetUsedPct =
    overview?.cost.currentMonthUsageUsd && overview.cost.monthlyBudgetUsd
      ? Math.round((overview.cost.currentMonthUsageUsd / overview.cost.monthlyBudgetUsd) * 100)
      : null;
  const lipSyncEnabled = Boolean(overview?.runtime?.features.translatorLipSyncEnabled);
  const translationEnabled = overview?.runtime?.features.translatorEnabled !== false;
  const superAgentEnabled = overview?.runtime?.features.superAgentEnabled !== false;
  const lipSyncAllowedEmails = overview?.runtime?.permissions.translatorLipSyncAllowedEmails ?? [];
  const translationAllowedEmails = overview?.runtime?.permissions.translatorAllowedEmails ?? [];
  const superAgentAllowedEmails = overview?.runtime?.permissions.superAgentAllowedEmails ?? [];
  const isPersisted = overview?.auth.persistence === "dynamodb";

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadOverview = async () => {
    setLoading(true);
    setGlobalError("");
    try {
      const res = await fetch(`${base}/api/admin/overview`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Admin API returned ${res.status}`);
      }
      setOverview((await res.json()) as AdminOverview);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Could not load admin overview");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => void loadOverview(), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // ── Access: save approved email ──────────────────────────────────────────
  const saveApprovedEmail = async (event: FormEvent) => {
    event.preventDefault();
    setSavingEmail(true);
    setAccessMsg({ text: "", error: false });
    try {
      const res = await fetch(`${base}/api/admin/approved-emails`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not save approved email");
      setEmail("");
      setAccessMsg({ text: `${data.email} approved as ${data.role}`, error: false });
      await loadOverview();
    } catch (err) {
      setAccessMsg({ text: err instanceof Error ? err.message : "Could not save approved email", error: true });
    } finally {
      setSavingEmail(false);
    }
  };

  // ── Access: remove approved email (per-item loading) ─────────────────────
  const removeEmail = async (value: string) => {
    setRemovingEmails((prev) => new Set([...prev, value]));
    setAccessMsg({ text: "", error: false });
    try {
      const res = await fetch(`${base}/api/admin/approved-emails/${encodeURIComponent(value)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not remove approved email");
      }
      setAccessMsg({ text: `${value} removed`, error: false });
      await loadOverview();
    } catch (err) {
      setAccessMsg({ text: err instanceof Error ? err.message : "Could not remove email", error: true });
    } finally {
      setRemovingEmails((prev) => { const next = new Set(prev); next.delete(value); return next; });
    }
  };

  // ── Tools: toggle runtime feature flag ────────────────────────────────────
  const saveApiAccessEmail = async (event: FormEvent) => {
    event.preventDefault();
    const value = apiAccessEmail.trim();
    if (!value) return;
    setSavingApiAccess(true);
    setApiAccessMsg({ text: "", error: false });
    try {
      const res = await fetch(`${base}/api/admin/api-access`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not grant Developer access");
      setApiAccessEmail("");
      setApiAccessMsg({ text: `${data.email} can now use Developer/API keys`, error: false });
      await loadOverview();
    } catch (err) {
      setApiAccessMsg({ text: err instanceof Error ? err.message : "Could not grant Developer access", error: true });
    } finally {
      setSavingApiAccess(false);
    }
  };

  const removeApiAccessEmail = async (value: string) => {
    setRemovingApiAccess((prev) => new Set([...prev, value]));
    setApiAccessMsg({ text: "", error: false });
    try {
      const res = await fetch(`${base}/api/admin/api-access/${encodeURIComponent(value)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not revoke Developer access");
      }
      setApiAccessMsg({ text: `${value} Developer/API access revoked`, error: false });
      await loadOverview();
    } catch (err) {
      setApiAccessMsg({ text: err instanceof Error ? err.message : "Could not revoke Developer access", error: true });
    } finally {
      setRemovingApiAccess((prev) => { const next = new Set(prev); next.delete(value); return next; });
    }
  };

  const setRuntimeFeatureFlag = async (key: string, enabled: boolean) => {
    setSavingRuntime(true);
    setToolsMsg({ text: "", error: false });
    try {
      const res = await fetch(`${base}/api/admin/features`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not update feature");
      }
      setToolsMsg({ text: `${key} ${enabled ? "enabled" : "disabled"}`, error: false });
      await loadOverview();
    } catch (err) {
      setToolsMsg({ text: err instanceof Error ? err.message : "Could not update feature", error: true });
    } finally {
      setSavingRuntime(false);
    }
  };

  // ── Tools: add permission email ───────────────────────────────────────────
  const savePermissionEmail = async (
    event: FormEvent,
    feature: "translator" | "super-agent" | "lipsync",
    value: string,
    clear: () => void,
  ) => {
    event.preventDefault();
    setSavingPermission(true);
    setToolsMsg({ text: "", error: false });
    try {
      const res = await fetch(`${base}/api/admin/permissions/${feature}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, allowed: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Could not save permission");
      clear();
      setToolsMsg({ text: `${value} added to ${feature}`, error: false });
      await loadOverview();
    } catch (err) {
      setToolsMsg({ text: err instanceof Error ? err.message : "Could not save permission", error: true });
    } finally {
      setSavingPermission(false);
    }
  };

  // ── Tools: remove permission email (per-item loading) ────────────────────
  const removePermissionEmail = async (
    feature: "translator" | "super-agent" | "lipsync",
    value: string,
  ) => {
    const key = `${feature}:${value}`;
    setRemovingPerms((prev) => new Set([...prev, key]));
    setToolsMsg({ text: "", error: false });
    try {
      const res = await fetch(
        `${base}/api/admin/permissions/${feature}/${encodeURIComponent(value)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not remove permission");
      }
      setToolsMsg({ text: `${value} removed from ${feature}`, error: false });
      await loadOverview();
    } catch (err) {
      setToolsMsg({ text: err instanceof Error ? err.message : "Could not remove permission", error: true });
    } finally {
      setRemovingPerms((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  // ── Jobs: cancel youtube job ──────────────────────────────────────────────
  const cancelYoutubeJob = async (event: FormEvent) => {
    event.preventDefault();
    if (!cancelJobId.trim()) return;
    setCancelBusy(true);
    setCancelMsg({ text: "", error: false });
    try {
      const res = await fetch(
        `${base}/api/admin/jobs/youtube/${encodeURIComponent(cancelJobId.trim())}/cancel`,
        { method: "POST", credentials: "include" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not cancel job");
      setCancelMsg({ text: data.ok ? `Cancelled — status: ${data.status}` : `Not cancelled: ${data.status}`, error: false });
      setCancelJobId("");
      await loadOverview();
    } catch (err) {
      setCancelMsg({ text: err instanceof Error ? err.message : "Could not cancel job", error: true });
    } finally {
      setCancelBusy(false);
    }
  };

  // ── Storage: run S3 cleanup ───────────────────────────────────────────────
  const runS3Cleanup = async (event: FormEvent) => {
    event.preventDefault();
    setCleanupBusy(true);
    setCleanupMsg({ text: "", error: false });
    try {
      const res = await fetch(`${base}/api/admin/maintenance/s3-cleanup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: cleanupNamespace, maxAgeHours: Number(cleanupHours) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Cleanup failed");
      setCleanupMsg({
        text: `Scanned ${data.scannedCount ?? 0}, removed ${data.deletedCount ?? data.deleted ?? 0} object(s), freed ${formatBytesAdmin(data.bytesFreed ?? 0)} from "${data.namespace}"`,
        error: false,
      });
      await loadOverview();
    } catch (err) {
      setCleanupMsg({ text: err instanceof Error ? err.message : "Cleanup failed", error: true });
    } finally {
      setCleanupBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading && !overview) return <AdminSkeleton />;

  return (
    <section className="admin-panel">
      {/* Header */}
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">Admin</p>
          <h1>Operations control panel</h1>
          <p className="admin-subtitle">
            Live app health, users, jobs, costs, storage, tools, and runtime guardrails.
          </p>
        </div>
        <button
          type="button"
          className="admin-refresh"
          onClick={() => void loadOverview()}
          disabled={loading}
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          Refresh
        </button>
      </header>

      {/* Global error */}
      {globalError ? (
        <div className="admin-alert admin-alert--critical">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {globalError}
        </div>
      ) : null}

      {/* Persistence warning */}
      {!isPersisted && overview ? (
        <div className="admin-alert admin-alert--warn">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>
            <strong>Allowlist is runtime-only.</strong> Approved emails will be lost on server restart/Lambda cold start.
            Set <code>ACCESS_TABLE</code> env var to a DynamoDB table to enable persistent storage.
          </span>
        </div>
      ) : null}

      {/* Tabs */}
      <nav className="admin-tabs" aria-label="Admin sections">
        {(["overview", "jobs", "access", "messages", "storage", "tools"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={tab === key ? "is-active" : ""}
            aria-current={tab === key ? "page" : undefined}
            onClick={() => setTab(key)}
          >
            {{ overview: "Overview", jobs: "Live Jobs", access: "Access", messages: "User Messages", storage: "Storage", tools: "Tools" }[key]}
          </button>
        ))}
      </nav>

      {/* KPI cards — always visible */}
      <div className="admin-kpis">
        <Stat
          icon={<Gauge className="w-4 h-4" />}
          label="API health"
          value={overview?.traffic.recent5m.errorRatePct ? `${overview.traffic.recent5m.errorRatePct}% errors` : "OK"}
          detail={`${overview?.traffic.recent5m.requests ?? 0} requests in 5m`}
          tone={overview && overview.traffic.recent5m.errorRatePct > 5 ? "bad" : "good"}
        />
        <Stat
          icon={<ListChecks className="w-4 h-4" />}
          label="Active jobs"
          value={activeJobs}
          detail={`${totalQueued} queued`}
          tone={totalQueued > 0 ? "warn" : "neutral"}
        />
        <Stat
          icon={<DollarSign className="w-4 h-4" />}
          label="Monthly budget"
          value={`$${overview?.cost.monthlyBudgetUsd ?? 20}`}
          detail={budgetUsedPct === null ? "billing not connected" : `${budgetUsedPct}% used`}
          tone={budgetUsedPct !== null && budgetUsedPct > 80 ? "warn" : "neutral"}
        />
        <Stat
          icon={<ShieldCheck className="w-4 h-4" />}
          label="Google access"
          value={overview?.features.googleAuthEnabled ? "Enabled" : "Disabled"}
          detail={`${overview?.auth.approvedAdminCount ?? 0} admins, ${overview?.auth.approvedUserCount ?? 0} users`}
          tone={overview?.features.googleAuthEnabled ? "good" : "neutral"}
        />
      </div>

      {/* Grid — sections tagged with data-section-tab for CSS show/hide */}
      <div className={cn("admin-grid", `admin-grid--${tab}`)}>

        {/* ── OVERVIEW tab sections ─────────────────────────────────────── */}
        <Section icon={<Activity className="w-4 h-4" />} title="Health" tab="overview">
          <div className="admin-stats">
            <Stat icon={<Clock className="w-4 h-4" />} label="Uptime" value={`${overview?.health.uptimeSec ?? 0}s`} />
            <Stat icon={<Activity className="w-4 h-4" />} label="Environment" value={overview?.health.nodeEnv ?? "-"} />
            <Stat
              icon={<Cpu className="w-4 h-4" />}
              label="CPU load"
              value={overview?.health.cpu ? overview.health.cpu.load1m : "-"}
              detail={overview?.health.cpu ? `${overview.health.cpu.cores} cores` : undefined}
            />
            <Stat
              icon={<HardDrive className="w-4 h-4" />}
              label="Disk used"
              value={formatPercent(overview?.health.disk?.rootUsedPct)}
              tone={(overview?.health.disk?.rootUsedPct ?? 0) > 85 ? "warn" : "neutral"}
            />
            <Stat
              icon={<Gauge className="w-4 h-4" />}
              label="Memory RSS"
              value={formatMb(overview?.health.memory?.processRssMb)}
              detail={`system ${formatPercent(overview?.health.memory?.systemUsedPct)}`}
            />
            <Stat icon={<Gauge className="w-4 h-4" />} label="Heap used" value={formatMb(overview?.health.memory?.processHeapUsedMb)} />
          </div>
        </Section>

        <Section icon={<AlertCircle className="w-4 h-4" />} title="Alerts" tab="overview">
          <div className="admin-alert-list">
            {(overview?.alerts.length ?? 0) === 0 ? (
              <div className="admin-empty">
                <CheckCircle2 className="w-4 h-4" />
                No active alerts
              </div>
            ) : (
              overview?.alerts.map((alert) => (
                <div
                  key={`${alert.title}-${alert.detail}`}
                  className={cn("admin-alert-item", `admin-alert-item--${alert.level}`)}
                >
                  <strong>{alert.title}</strong>
                  <span>{alert.detail}</span>
                </div>
              ))
            )}
          </div>
        </Section>

        <Section icon={<DollarSign className="w-4 h-4" />} title="Cost guardrails" tab="overview">
          <div className="admin-stats">
            <Stat icon={<DollarSign className="w-4 h-4" />} label="Budget" value={`$${overview?.cost.monthlyBudgetUsd ?? 20}`} />
            <Stat
              icon={<DollarSign className="w-4 h-4" />}
              label="Usage"
              value={overview?.cost.currentMonthUsageUsd == null ? "not connected" : `$${overview.cost.currentMonthUsageUsd}`}
            />
            <Stat icon={<Clock className="w-4 h-4" />} label="GPU timeout" value={`${overview?.cost.gpuMaxRuntimeMinutes ?? 30}m`} />
            <Stat icon={<Activity className="w-4 h-4" />} label="GPU concurrency" value={overview?.cost.gpuConcurrency ?? 1} />
            <Stat icon={<Archive className="w-4 h-4" />} label="ECR keep" value={`${overview?.limits.ecrKeepTaggedImages ?? 3} images`} />
            <Stat icon={<Scissors className="w-4 h-4" />} label="Lambda clip max" value={`${overview?.limits.lambdaClipMaxDurationSeconds ?? 480}s`} />
          </div>
          <ul className="admin-note-list">
            {(overview?.cost.notes ?? []).map((note) => <li key={note}>{note}</li>)}
          </ul>
        </Section>

        <Section icon={<Activity className="w-4 h-4" />} title="Traffic" tab="overview">
          <div className="admin-stats">
            <Stat icon={<Activity className="w-4 h-4" />} label="Total requests" value={overview?.traffic.totals.requests ?? 0} />
            <Stat icon={<Gauge className="w-4 h-4" />} label="Avg latency" value={`${overview?.traffic.totals.avgDurationMs ?? 0}ms`} />
            <Stat icon={<Activity className="w-4 h-4" />} label="5m requests" value={overview?.traffic.recent5m.requests ?? 0} />
            <Stat icon={<AlertCircle className="w-4 h-4" />} label="5m 5xx" value={overview?.traffic.recent5m.status5xx ?? 0} />
            <Stat icon={<CheckCircle2 className="w-4 h-4" />} label="2xx" value={overview?.traffic.totals.status2xx ?? 0} tone="good" />
            <Stat icon={<XCircle className="w-4 h-4" />} label="4xx / 5xx" value={`${overview?.traffic.totals.status4xx ?? 0} / ${overview?.traffic.totals.status5xx ?? 0}`} />
          </div>
        </Section>

        {/* ── JOBS tab sections ─────────────────────────────────────────── */}
        <Section icon={<ListChecks className="w-4 h-4" />} title="Live global jobs" wide tab="jobs">
          <div className="admin-window-grid">
            {(["30m", "1h", "24h"] as const).map((key) => {
              const bucket = overview?.jobs?.analytics?.[key];
              return (
                <div key={key} className="admin-window-card">
                  <strong>{key}</strong>
                  <span>{bucket?.total ?? 0} total</span>
                  <em>{bucket?.active ?? 0} active / {bucket?.completed ?? 0} done / {bucket?.failed ?? 0} failed</em>
                </div>
              );
            })}
          </div>
          <JobsTable jobs={overview?.jobs?.active ?? []} />
          <div className="admin-section-title admin-section-title--sub">Recent activity</div>
          <JobsTable jobs={(overview?.jobs?.recent ?? []).slice(0, 20)} />
        </Section>

        <Section icon={<ListChecks className="w-4 h-4" />} title="Jobs and queues" tab="jobs">
          <div className="admin-stats">
            <Stat icon={<Scissors className="w-4 h-4" />} label="Clip slots" value={`${activeClipSlots}/${maxClipSlots}`} />
            <Stat icon={<Scissors className="w-4 h-4" />} label="Queued clips" value={youtubeQueue.queuedClipJobs ?? 0} />
            <Stat icon={<Subtitles className="w-4 h-4" />} label="Subtitle slots" value={`${activeSubtitleSlots}/${maxSubtitleSlots}`} />
            <Stat icon={<Subtitles className="w-4 h-4" />} label="Queued subtitles" value={subtitleQueue.queuedSubtitleJobs ?? 0} />
            <Stat icon={<Download className="w-4 h-4" />} label="Downloads" value={youtubeQueue.activeDownloads ?? 0} />
            <Stat icon={<Archive className="w-4 h-4" />} label="Tracked jobs" value={(youtubeQueue.totalTrackedJobs ?? 0) + (subtitleQueue.totalTrackedJobs ?? 0)} />
          </div>
          <form className="admin-action-row" onSubmit={cancelYoutubeJob}>
            <input
              value={cancelJobId}
              onChange={(event) => setCancelJobId(event.target.value)}
              placeholder="YouTube queue job ID"
              aria-label="YouTube queue job ID"
            />
            <button type="submit" disabled={cancelBusy || !cancelJobId.trim()}>
              Cancel job
            </button>
          </form>
          <ResultMsg msg={cancelMsg.text} isError={cancelMsg.error} />
        </Section>

        {/* ── ACCESS tab sections ───────────────────────────────────────── */}
        <Section icon={<ShieldCheck className="w-4 h-4" />} title="Access control" wide tab="access">
          <div className="admin-stats">
            <Stat icon={<Users className="w-4 h-4" />} label="Approved users" value={overview?.auth.approvedUserCount ?? 0} />
            <Stat icon={<ShieldCheck className="w-4 h-4" />} label="Approved admins" value={overview?.auth.approvedAdminCount ?? 0} />
            <Stat icon={<KeyRound className="w-4 h-4" />} label="Developer access" value={overview?.auth.apiAccessCount ?? 0} />
            <Stat
              icon={<KeyRound className="w-4 h-4" />}
              label="Google client"
              value={overview?.auth.googleClientConfigured ? "configured" : "missing"}
              tone={overview?.auth.googleClientConfigured ? "good" : "warn"}
            />
            <Stat
              icon={<Archive className="w-4 h-4" />}
              label="Persistence"
              value={overview?.auth.persistence ?? "runtime"}
              tone={isPersisted ? "good" : "warn"}
            />
          </div>

          <form className="admin-email-form" onSubmit={saveApprovedEmail}>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="approved@gmail.com"
              type="email"
              aria-label="Approved email address"
              required
            />
            <select
              value={role}
              aria-label="Approved email role"
              onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit" disabled={savingEmail || !email.trim()}>
              {savingEmail ? "Saving…" : "Approve"}
            </button>
          </form>

          <ResultMsg msg={accessMsg.text} isError={accessMsg.error} />

          <EmailPillList
            items={approvedEmails}
            onRemove={(v) => void removeEmail(v)}
            removingSet={removingEmails}
          />

          <div className="admin-perm-group">
            <div className="admin-perm-group-label">Developer/API access</div>
            <form className="admin-email-form admin-email-form--2col" onSubmit={saveApiAccessEmail}>
              <input
                value={apiAccessEmail}
                onChange={(event) => setApiAccessEmail(event.target.value)}
                placeholder="developer@gmail.com"
                type="email"
                aria-label="Developer API access email"
                required
              />
              <button type="submit" disabled={savingApiAccess || !apiAccessEmail.trim()}>
                {savingApiAccess ? "Saving..." : "Grant API access"}
              </button>
            </form>
            <ResultMsg msg={apiAccessMsg.text} isError={apiAccessMsg.error} />
            <EmailPillList
              items={developerAccessEmails}
              onRemove={(v) => void removeApiAccessEmail(v)}
              removingSet={removingApiAccess}
            />
          </div>

          <p className="admin-note">
            {isPersisted
              ? "✓ Allowlist is persisted to DynamoDB and survives Lambda restarts."
              : "⚠ Runtime-only. Set ACCESS_TABLE env var to persist to DynamoDB."}
          </p>
        </Section>

        {/* ── STORAGE tab sections ──────────────────────────────────────── */}
        <Section icon={<Users className="w-4 h-4" />} title="Submitted future-login emails" wide tab="messages">
          <div className="admin-window-grid">
            <div className="admin-window-card">
              <strong>Total</strong>
              <span>{overview?.userMessages?.emailSubmissionCount ?? 0} emails</span>
              <em>Collected from the settings notice</em>
            </div>
          </div>
          <div className="admin-email-submission-table">
            {(overview?.userMessages?.emailSubmissions ?? []).length === 0 ? (
              <div className="admin-empty">No submitted emails yet</div>
            ) : (
              overview?.userMessages?.emailSubmissions.map((item) => (
                <div key={item.email} className="admin-email-submission-row">
                  <div>
                    <strong>{item.email}</strong>
                    <span>{item.name || "No name submitted"}</span>
                  </div>
                  <div>
                    <strong>{item.loginMethod}</strong>
                    <span>{item.loginEmail || "password login"}</span>
                  </div>
                  <div>
                    <strong>{item.submittedAt ? new Date(item.submittedAt).toLocaleString() : "-"}</strong>
                    <span>{item.role}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Section>

        <Section icon={<Cloud className="w-4 h-4" />} title="Storage and cleanup" wide tab="storage">
          <div className="admin-stats">
            <Stat
              icon={<Cloud className="w-4 h-4" />}
              label="S3"
              value={overview?.storage.s3.enabled ? "enabled" : "disabled"}
              tone={overview?.storage.s3.enabled ? "good" : "warn"}
            />
            <Stat icon={<Archive className="w-4 h-4" />} label="Bucket" value={overview?.storage.s3.bucket ?? "-"} />
            <Stat icon={<UploadCloud className="w-4 h-4" />} label="Prefix" value={overview?.storage.s3.prefix ?? "-"} />
            <Stat icon={<Clock className="w-4 h-4" />} label="Signed URL TTL" value={`${overview?.storage.signedUrlTtlSec ?? 7200}s`} />
          </div>
          <form className="admin-action-row" onSubmit={runS3Cleanup}>
            <select
              value={cleanupNamespace}
              aria-label="Cleanup namespace"
              onChange={(event) => setCleanupNamespace(event.target.value)}
            >
              {(overview?.storage.cleanupNamespaces ?? ["youtube/clips"]).map((namespace) => (
                <option key={namespace} value={namespace}>{namespace}</option>
              ))}
            </select>
            <input
              value={cleanupHours}
              onChange={(event) => setCleanupHours(event.target.value)}
              type="number"
              min="1"
              placeholder="Age hours"
              aria-label="Cleanup maximum age in hours"
            />
            <button type="submit" disabled={cleanupBusy || !overview?.storage.s3.enabled}>
              <Trash2 className="w-3.5 h-3.5" />
              Clean old files
            </button>
          </form>
          <ResultMsg msg={cleanupMsg.text} isError={cleanupMsg.error} />
          <div className="admin-cleanup-history">
            {(overview?.storage.cleanupHistory ?? []).slice(0, 5).map((item) => (
              <div key={`${item.ts}-${item.namespace}`}>
                <strong>{item.ok ? "Cleanup complete" : "Cleanup failed"}</strong>
                <span>{item.namespace} — scanned {item.scannedCount}, removed {item.deletedCount}, freed {formatBytesAdmin(item.bytesFreed)} — {formatTime(item.ts)}</span>
                {item.error ? <em>{item.error}</em> : null}
              </div>
            ))}
          </div>
        </Section>

        {/* ── TOOLS tab sections ────────────────────────────────────────── */}
        <Section icon={<Bot className="w-4 h-4" />} title="Tool readiness" wide tab="tools">
          <ToolGrid tools={overview?.tools ?? []} />
        </Section>

        <Section icon={<Settings className="w-4 h-4" />} title="Runtime feature flags" wide tab="tools">
          <ToggleRow
            label="Translation tab"
            detail="Global translator access gate. If allowed-users list is non-empty, only those users can access it."
            enabled={translationEnabled}
            busy={savingRuntime}
            onToggle={() => void setRuntimeFeatureFlag("translatorEnabled", !translationEnabled)}
          />
          <ToggleRow
            label="Translator lip sync"
            detail="Global gate. Users must also be listed in lip sync permissions below."
            enabled={lipSyncEnabled}
            busy={savingRuntime}
            onToggle={() => void setRuntimeFeatureFlag("translatorLipSyncEnabled", !lipSyncEnabled)}
          />
          <ToggleRow
            label="Super Agent"
            detail="Global agent access gate. If allowed-users list is non-empty, only those users can access it."
            enabled={superAgentEnabled}
            busy={savingRuntime}
            onToggle={() => void setRuntimeFeatureFlag("superAgentEnabled", !superAgentEnabled)}
          />
          <FlagList flags={overview?.features ?? {}} />
          {toolsMsg.text ? <ResultMsg msg={toolsMsg.text} isError={toolsMsg.error} /> : null}
        </Section>

        <Section icon={<ShieldCheck className="w-4 h-4" />} title="Feature permissions" wide tab="tools">
          {/* Translation */}
          <div className="admin-perm-group">
            <div className="admin-perm-group-label">Translation — allowed users</div>
            <form className="admin-email-form admin-email-form--2col" onSubmit={(e) => void savePermissionEmail(e, "translator", translationEmail, () => setTranslationEmail(""))}>
              <input
                value={translationEmail}
                onChange={(event) => setTranslationEmail(event.target.value)}
                placeholder="user@gmail.com"
                type="email"
                aria-label="Translation allowed user email"
                required
              />
              <button type="submit" disabled={savingPermission || !translationEmail.trim()}>
                {savingPermission ? "Saving…" : "Allow"}
              </button>
            </form>
            <EmailPillList
              items={translationAllowedEmails.map((e) => ({ email: e, badge: "translation" }))}
              onRemove={(v) => void removePermissionEmail("translator", v)}
              removingSet={new Set([...removingPerms].filter((k) => k.startsWith("translator:")).map((k) => k.slice("translator:".length)))}
            />
          </div>

          {/* Lip sync */}
          <div className="admin-perm-group">
            <div className="admin-perm-group-label">Lip sync — allowed users</div>
            <form className="admin-email-form admin-email-form--2col" onSubmit={(e) => void savePermissionEmail(e, "lipsync", lipSyncEmail, () => setLipSyncEmail(""))}>
              <input
                value={lipSyncEmail}
                onChange={(event) => setLipSyncEmail(event.target.value)}
                placeholder="user@gmail.com"
                type="email"
                aria-label="Lip sync allowed user email"
                required
              />
              <button type="submit" disabled={savingPermission || !lipSyncEmail.trim()}>
                {savingPermission ? "Saving…" : "Allow"}
              </button>
            </form>
            <EmailPillList
              items={lipSyncAllowedEmails.map((e) => ({ email: e, badge: "lipsync" }))}
              onRemove={(v) => void removePermissionEmail("lipsync", v)}
              removingSet={new Set([...removingPerms].filter((k) => k.startsWith("lipsync:")).map((k) => k.slice("lipsync:".length)))}
            />
          </div>

          {/* Super Agent */}
          <div className="admin-perm-group">
            <div className="admin-perm-group-label">Super Agent — allowed users</div>
            <form className="admin-email-form admin-email-form--2col" onSubmit={(e) => void savePermissionEmail(e, "super-agent", superAgentEmail, () => setSuperAgentEmail(""))}>
              <input
                value={superAgentEmail}
                onChange={(event) => setSuperAgentEmail(event.target.value)}
                placeholder="user@gmail.com"
                type="email"
                aria-label="Super Agent allowed user email"
                required
              />
              <button type="submit" disabled={savingPermission || !superAgentEmail.trim()}>
                {savingPermission ? "Saving…" : "Allow"}
              </button>
            </form>
            <EmailPillList
              items={superAgentAllowedEmails.map((e) => ({ email: e, badge: "agent" }))}
              onRemove={(v) => void removePermissionEmail("super-agent", v)}
              removingSet={new Set([...removingPerms].filter((k) => k.startsWith("super-agent:")).map((k) => k.slice("super-agent:".length)))}
            />
          </div>

          <ResultMsg msg={toolsMsg.text} isError={toolsMsg.error} />
          <p className="admin-note">Runtime permission changes apply immediately but reset on Lambda cold starts/redeploys unless also set in env vars.</p>
        </Section>

        <Section icon={<Sparkles className="w-4 h-4" />} title="Current capabilities" tab="tools">
          <div className="admin-capability-list">
            <span>Super Agent tool routing</span>
            <span>Fast YouTube download cards</span>
            <span>Lambda clip cutting threshold</span>
            <span>Lambda subtitle threshold</span>
            <span>GPU translator queue</span>
            <span>Large file sharing</span>
            <span>Google allow-list sign-in</span>
            <span>Runtime admin access management</span>
          </div>
        </Section>

      </div>
    </section>
  );
}
