// Local-device-only history for the Timestamps tab.
// Keeps up to 7 entries; auto-expires entries older than 3 days.

const HISTORY_KEY = "ytgrabber_timestamps_history";
const MAX_ENTRIES = 7;
const EXPIRE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export interface TimestampHistoryEntry {
  id: string;              // unique ID (jobId or uuid)
  createdAt: number;       // Date.now() when saved
  videoTitle: string;      // from the API result
  videoUrl: string;        // the YouTube URL the user submitted
  chapterCount: number;    // how many timestamps were generated
  videoDurationSecs: number;
}

function purgExpired(entries: TimestampHistoryEntry[]): TimestampHistoryEntry[] {
  const cutoff = Date.now() - EXPIRE_MS;
  return entries.filter((e) => e.createdAt > cutoff);
}

export function loadTimestampHistory(): TimestampHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return purgExpired(parsed as TimestampHistoryEntry[]);
  } catch {
    return [];
  }
}

export function saveToTimestampHistory(entry: TimestampHistoryEntry): void {
  try {
    const existing = loadTimestampHistory().filter((e) => e.id !== entry.id);
    const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
}

export function deleteFromTimestampHistory(id: string): TimestampHistoryEntry[] {
  const updated = loadTimestampHistory().filter((e) => e.id !== id);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
  return updated;
}

export function clearTimestampHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
}

export function formatTimestampRelativeTime(ts: number): string {
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
