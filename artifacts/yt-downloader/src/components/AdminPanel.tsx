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
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
};

type AdminOverview = {
  ts: number;
  health: {
    nodeEnv: string;
    uptimeSec: number;
    cpu?: { load1m: number; load5m: number; load15m: number; cores: number };
    memory?: {
      processRssMb: number;
      processHeapUsedMb: number;
      systemUsedPct: number;
    };
    disk?: { rootUsedPct: number | null };
  };
  traffic: HttpMetrics;
  alerts: Array<{ level: "info" | "warning" | "critical"; title: string; detail: string }>;
  queues: {
    youtube?: QueueSnapshot;
    subtitles?: QueueSnapshot;
    translator?: {
      configured: boolean;
      queueName: string | null;
      jobDefinition: string | null;
    };
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
    s3: {
      enabled: boolean;
      bucket: string | null;
      region: string;
      prefix: string;
      signedUrlTtlSec: number;
    };
    cleanupNamespaces: string[];
    signedUrlTtlSec: number;
  };
  tools: Array<{ key: string; label: string; status: string; detail: string }>;
  auth: {
    googleClientConfigured: boolean;
    persistence: string;
    approvedUserCount: number;
    approvedAdminCount: number;
    approvedUsers: string[];
    approvedAdmins: string[];
  };
};

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

function Stat({
  icon,
  label,
  value,
  tone = "neutral",
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  detail?: React.ReactNode;
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

function Section({
  icon,
  title,
  children,
  wide = false,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={cn("admin-section", wide && "admin-section--wide")}>
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

export function AdminPanel() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [savingEmail, setSavingEmail] = useState(false);
  const [cancelJobId, setCancelJobId] = useState("");
  const [cancelResult, setCancelResult] = useState("");
  const [cleanupNamespace, setCleanupNamespace] = useState("youtube/clips");
  const [cleanupHours, setCleanupHours] = useState("24");
  const [actionBusy, setActionBusy] = useState(false);

  const approvedEmails = useMemo(
    () => [
      ...(overview?.auth.approvedAdmins ?? []).map((value) => ({ email: value, role: "admin" as const })),
      ...(overview?.auth.approvedUsers ?? []).map((value) => ({ email: value, role: "user" as const })),
    ],
    [overview],
  );

  const loadOverview = async () => {
    setLoading(true);
    setError("");
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
      setError(err instanceof Error ? err.message : "Could not load admin overview");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => void loadOverview(), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const saveApprovedEmail = async (event: FormEvent) => {
    event.preventDefault();
    setSavingEmail(true);
    setError("");
    try {
      const res = await fetch(`${base}/api/admin/approved-emails`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not save approved email");
      }
      setEmail("");
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save approved email");
    } finally {
      setSavingEmail(false);
    }
  };

  const removeEmail = async (value: string) => {
    setSavingEmail(true);
    setError("");
    try {
      const res = await fetch(`${base}/api/admin/approved-emails/${encodeURIComponent(value)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not remove approved email");
      }
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove approved email");
    } finally {
      setSavingEmail(false);
    }
  };

  const cancelYoutubeJob = async (event: FormEvent) => {
    event.preventDefault();
    if (!cancelJobId.trim()) return;
    setActionBusy(true);
    setCancelResult("");
    try {
      const res = await fetch(`${base}/api/admin/jobs/youtube/${encodeURIComponent(cancelJobId.trim())}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not cancel job");
      setCancelResult(data.ok ? `Cancelled/status: ${data.status}` : `Not cancelled: ${data.status}`);
      await loadOverview();
    } catch (err) {
      setCancelResult(err instanceof Error ? err.message : "Could not cancel job");
    } finally {
      setActionBusy(false);
    }
  };

  const cleanupS3 = async (event: FormEvent) => {
    event.preventDefault();
    setActionBusy(true);
    setCancelResult("");
    try {
      const res = await fetch(`${base}/api/admin/maintenance/s3-cleanup`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: cleanupNamespace, maxAgeHours: Number(cleanupHours) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Cleanup failed");
      setCancelResult(`S3 cleanup removed ${data.deleted ?? 0} object(s) from ${data.namespace}`);
      await loadOverview();
    } catch (err) {
      setCancelResult(err instanceof Error ? err.message : "Cleanup failed");
    } finally {
      setActionBusy(false);
    }
  };

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

  return (
    <section className="admin-panel">
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

      {error ? (
        <div className="admin-alert admin-alert--critical">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      ) : null}

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

      <div className="admin-grid">
        <Section icon={<Activity className="w-4 h-4" />} title="Health">
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
            <Stat
              icon={<Gauge className="w-4 h-4" />}
              label="Heap used"
              value={formatMb(overview?.health.memory?.processHeapUsedMb)}
            />
          </div>
        </Section>

        <Section icon={<ListChecks className="w-4 h-4" />} title="Jobs and queues">
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
            />
            <button type="submit" disabled={actionBusy || !cancelJobId.trim()}>
              Cancel job
            </button>
          </form>
        </Section>

        <Section icon={<AlertCircle className="w-4 h-4" />} title="Alerts">
          <div className="admin-alert-list">
            {(overview?.alerts.length ?? 0) === 0 ? (
              <div className="admin-empty">
                <CheckCircle2 className="w-4 h-4" />
                No active alerts
              </div>
            ) : (
              overview?.alerts.map((alert) => (
                <div key={`${alert.title}-${alert.detail}`} className={cn("admin-alert-item", `admin-alert-item--${alert.level}`)}>
                  <strong>{alert.title}</strong>
                  <span>{alert.detail}</span>
                </div>
              ))
            )}
          </div>
        </Section>

        <Section icon={<ShieldCheck className="w-4 h-4" />} title="Access control">
          <div className="admin-stats">
            <Stat icon={<Users className="w-4 h-4" />} label="Approved users" value={overview?.auth.approvedUserCount ?? 0} />
            <Stat icon={<ShieldCheck className="w-4 h-4" />} label="Approved admins" value={overview?.auth.approvedAdminCount ?? 0} />
            <Stat
              icon={<KeyRound className="w-4 h-4" />}
              label="Google client"
              value={overview?.auth.googleClientConfigured ? "configured" : "missing"}
              tone={overview?.auth.googleClientConfigured ? "good" : "warn"}
            />
            <Stat icon={<Archive className="w-4 h-4" />} label="Persistence" value={overview?.auth.persistence ?? "runtime"} />
          </div>
          <form className="admin-email-form" onSubmit={saveApprovedEmail}>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="approved@gmail.com"
              type="email"
            />
            <select value={role} onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit" disabled={savingEmail || !email.trim()}>
              {savingEmail ? "Saving" : "Approve"}
            </button>
          </form>
          <div className="admin-email-list">
            {approvedEmails.map((item) => (
              <span key={item.email}>
                <strong>{item.role}</strong>
                {item.email}
                <button type="button" onClick={() => void removeEmail(item.email)} aria-label={`Remove ${item.email}`}>
                  x
                </button>
              </span>
            ))}
          </div>
          <p className="admin-note">Runtime approvals are for testing. Production should move this list to DynamoDB before many users use Google login.</p>
        </Section>

        <Section icon={<DollarSign className="w-4 h-4" />} title="Cost guardrails">
          <div className="admin-stats">
            <Stat icon={<DollarSign className="w-4 h-4" />} label="Budget" value={`$${overview?.cost.monthlyBudgetUsd ?? 20}`} />
            <Stat
              icon={<DollarSign className="w-4 h-4" />}
              label="Usage"
              value={overview?.cost.currentMonthUsageUsd === null || overview?.cost.currentMonthUsageUsd === undefined ? "not connected" : `$${overview.cost.currentMonthUsageUsd}`}
            />
            <Stat icon={<Clock className="w-4 h-4" />} label="GPU timeout" value={`${overview?.cost.gpuMaxRuntimeMinutes ?? 30}m`} />
            <Stat icon={<Activity className="w-4 h-4" />} label="GPU concurrency" value={overview?.cost.gpuConcurrency ?? 1} />
            <Stat icon={<Archive className="w-4 h-4" />} label="ECR keep" value={`${overview?.limits.ecrKeepTaggedImages ?? 3} images`} />
            <Stat icon={<Scissors className="w-4 h-4" />} label="Lambda clip max" value={`${overview?.limits.lambdaClipMaxDurationSeconds ?? 480}s`} />
          </div>
          <ul className="admin-note-list">
            {(overview?.cost.notes ?? []).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Section>

        <Section icon={<Cloud className="w-4 h-4" />} title="Storage and cleanup">
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
          <form className="admin-action-row" onSubmit={cleanupS3}>
            <select value={cleanupNamespace} onChange={(event) => setCleanupNamespace(event.target.value)}>
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
            />
            <button type="submit" disabled={actionBusy || !overview?.storage.s3.enabled}>
              <Trash2 className="w-3.5 h-3.5" />
              Clean old files
            </button>
          </form>
        </Section>

        <Section icon={<Bot className="w-4 h-4" />} title="Tool readiness" wide>
          <ToolGrid tools={overview?.tools ?? []} />
        </Section>

        <Section icon={<Settings className="w-4 h-4" />} title="Runtime feature flags" wide>
          <FlagList flags={overview?.features ?? {}} />
        </Section>

        <Section icon={<Activity className="w-4 h-4" />} title="Traffic">
          <div className="admin-stats">
            <Stat icon={<Activity className="w-4 h-4" />} label="Total requests" value={overview?.traffic.totals.requests ?? 0} />
            <Stat icon={<Gauge className="w-4 h-4" />} label="Avg latency" value={`${overview?.traffic.totals.avgDurationMs ?? 0}ms`} />
            <Stat icon={<Activity className="w-4 h-4" />} label="5m requests" value={overview?.traffic.recent5m.requests ?? 0} />
            <Stat icon={<AlertCircle className="w-4 h-4" />} label="5m 5xx" value={overview?.traffic.recent5m.status5xx ?? 0} />
            <Stat icon={<CheckCircle2 className="w-4 h-4" />} label="2xx" value={overview?.traffic.totals.status2xx ?? 0} tone="good" />
            <Stat icon={<XCircle className="w-4 h-4" />} label="4xx / 5xx" value={`${overview?.traffic.totals.status4xx ?? 0} / ${overview?.traffic.totals.status5xx ?? 0}`} />
          </div>
        </Section>

        <Section icon={<Sparkles className="w-4 h-4" />} title="Current capabilities">
          <div className="admin-capability-list">
            <span>Super Agent tool routing</span>
            <span>Fast YouTube download cards</span>
            <span>Lambda clip cutting threshold</span>
            <span>Lambda subtitle threshold</span>
            <span>GPU translator queue</span>
            <span>Large file sharing</span>
            <span>Google allow-list sign-in foundation</span>
            <span>Runtime admin access management</span>
          </div>
        </Section>
      </div>

      {cancelResult ? <div className="admin-action-result">{cancelResult}</div> : null}
    </section>
  );
}
