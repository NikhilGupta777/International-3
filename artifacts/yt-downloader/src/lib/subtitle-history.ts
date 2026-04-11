const STORAGE_KEY = "ytgrabber_subtitle_history";
const MAX_ENTRIES = 30;

export interface SubtitleHistoryEntry {
  id: string;
  createdAt: number;
  mode: "url" | "file";
  url?: string;
  inputFilename?: string;
  srtFilename: string;
  language: string;
  translateTo: string;
  srt: string;
  originalSrt?: string;
  originalFilename?: string;
  entryCount: number;
}

export function loadHistory(): SubtitleHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SubtitleHistoryEntry[];
  } catch {
    return [];
  }
}

export function saveToHistory(entry: SubtitleHistoryEntry): void {
  try {
    const existing = loadHistory().filter((e) => e.id !== entry.id);
    const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // localStorage full or unavailable — silently skip
  }
}

export function deleteFromHistory(id: string): SubtitleHistoryEntry[] {
  const updated = loadHistory().filter((e) => e.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {}
  return updated;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

// ── Active job persistence ────────────────────────────────────────────────────
// Saves the currently-running job to localStorage so that if the user navigates
// away and comes back, the component can reconnect and resume polling.

const ACTIVE_JOB_KEY = "ytgrabber_active_srt_job";
const ACTIVE_JOB_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export interface ActiveJobRecord {
  jobId: string;
  mode: "url" | "file";
  url?: string;
  inputFilename?: string;
  language: string;
  translateTo: string;
  startedAt: number;
}

export function saveActiveJob(record: ActiveJobRecord): void {
  try { localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(record)); } catch {}
}

export function loadActiveJob(): ActiveJobRecord | null {
  try {
    const raw = localStorage.getItem(ACTIVE_JOB_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveJobRecord>;
    if (
      !parsed ||
      typeof parsed.jobId !== "string" ||
      (parsed.mode !== "url" && parsed.mode !== "file") ||
      typeof parsed.language !== "string" ||
      typeof parsed.translateTo !== "string" ||
      typeof parsed.startedAt !== "number"
    ) {
      localStorage.removeItem(ACTIVE_JOB_KEY);
      return null;
    }
    if (Date.now() - parsed.startedAt > ACTIVE_JOB_MAX_AGE_MS) {
      localStorage.removeItem(ACTIVE_JOB_KEY);
      return null;
    }
    return parsed as ActiveJobRecord;
  } catch {
    return null;
  }
}

export function clearActiveJob(): void {
  try { localStorage.removeItem(ACTIVE_JOB_KEY); } catch {}
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function formatRelativeTime(ts: number): string {
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
