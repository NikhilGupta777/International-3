const ACTIVE_KEY = "ytgrabber_active_download";

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — matches server file retention

export interface ActiveDownloadRecord {
  jobId: string;
  url: string;
  savedAt: number;
}

export function saveActiveDownload(record: ActiveDownloadRecord): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(record));
  } catch {}
}

export function loadActiveDownload(): ActiveDownloadRecord | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ActiveDownloadRecord;
    if (Date.now() - parsed.savedAt > TTL_MS) {
      clearActiveDownload();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearActiveDownload(): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}
