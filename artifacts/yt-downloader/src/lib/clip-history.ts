const HISTORY_KEY = "ytgrabber_clip_history";
const ACTIVE_KEY  = "ytgrabber_active_clip_jobs";
const MAX_ENTRIES = 30;

export interface ClipHistoryEntry {
  jobId: string;
  createdAt: number;
  label: string;       // "1:30 → 2:00"
  url: string;
  quality: string;
  filename: string;
  filesize: number | null;
  durationSecs: number;
}

export interface ActiveClipJob {
  jobId: string;
  label: string;
  url: string;
  quality: string;
  startSecs: number;
  endSecs: number;
  startedAt: number;
}

// ── History ───────────────────────────────────────────────────────────────────

export function loadClipHistory(): ClipHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ClipHistoryEntry[]) : [];
  } catch { return []; }
}

export function saveToClipHistory(entry: ClipHistoryEntry): void {
  try {
    const existing = loadClipHistory().filter((e) => e.jobId !== entry.jobId);
    const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
}

export function deleteFromClipHistory(jobId: string): ClipHistoryEntry[] {
  const updated = loadClipHistory().filter((e) => e.jobId !== jobId);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function clearClipHistory(): void {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
}

// ── Active jobs ───────────────────────────────────────────────────────────────

export function saveActiveClipJobs(jobs: ActiveClipJob[]): void {
  try {
    if (jobs.length === 0) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, JSON.stringify(jobs));
  } catch {}
}

export function loadActiveClipJobs(): ActiveClipJob[] {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ActiveClipJob[]) : [];
  } catch { return []; }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function formatClipRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatFilesize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
