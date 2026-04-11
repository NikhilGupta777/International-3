const ACTIVE_KEY = "ytgrabber_active_download";
const COMPLETED_KEY = "ytgrabber_completed_downloads";
const MAX_COMPLETED = 20;

const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — matches server file retention

// ── Active download (in-progress) ────────────────────────────────────────────

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
    const parsed = JSON.parse(raw) as Partial<ActiveDownloadRecord>;
    if (
      !parsed ||
      typeof parsed.jobId !== "string" ||
      typeof parsed.url !== "string" ||
      typeof parsed.savedAt !== "number"
    ) {
      clearActiveDownload();
      return null;
    }
    if (Date.now() - parsed.savedAt > TTL_MS) {
      clearActiveDownload();
      return null;
    }
    return parsed as ActiveDownloadRecord;
  } catch {
    return null;
  }
}

export function clearActiveDownload(): void {
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {}
}

// ── Completed downloads (history) ────────────────────────────────────────────

export interface CompletedDownloadRecord {
  jobId: string;
  url: string;
  filename: string;
  filesize: number | null;
  createdAt: number;
}

export function saveCompletedDownload(record: CompletedDownloadRecord): void {
  try {
    const existing = loadCompletedDownloads().filter((e) => e.jobId !== record.jobId);
    const updated = [record, ...existing].slice(0, MAX_COMPLETED);
    localStorage.setItem(COMPLETED_KEY, JSON.stringify(updated));
  } catch {}
}

export function loadCompletedDownloads(): CompletedDownloadRecord[] {
  try {
    const raw = localStorage.getItem(COMPLETED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CompletedDownloadRecord[]) : [];
  } catch {
    return [];
  }
}

export function deleteCompletedDownload(jobId: string): void {
  try {
    const updated = loadCompletedDownloads().filter((e) => e.jobId !== jobId);
    if (updated.length === 0) {
      localStorage.removeItem(COMPLETED_KEY);
    } else {
      localStorage.setItem(COMPLETED_KEY, JSON.stringify(updated));
    }
  } catch {}
}

export function clearCompletedDownloads(): void {
  try {
    localStorage.removeItem(COMPLETED_KEY);
  } catch {}
}

export function isDownloadExpired(record: CompletedDownloadRecord): boolean {
  return Date.now() - record.createdAt > TTL_MS;
}
