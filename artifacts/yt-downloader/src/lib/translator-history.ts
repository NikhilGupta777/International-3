const HISTORY_KEY = "ytgrabber_translator_history";
const ACTIVE_KEY = "ytgrabber_active_translator_jobs";
const DELETED_KEY = "ytgrabber_deleted_translator_jobs";
const MAX_ENTRIES = 30;
const MAX_DELETED = 200;

export interface TranslatorHistoryEntry {
  jobId: string;
  createdAt: number;
  updatedAt?: number;
  filename: string;
  targetLang: string;
  targetLangCode?: string;
  sourceLang?: string;
  progress: number;
  videoUrl?: string;
  shareUrl?: string;
  srtUrl?: string;
  transcriptUrl?: string;
  segmentCount?: number;
}

export interface ActiveTranslatorJob {
  jobId: string;
  filename: string;
  targetLang: string;
  targetLangCode?: string;
  sourceLang?: string;
  startedAt: number;
  progress: number;
  step: string;
  status: string;
}

function readArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function loadTranslatorHistory(): TranslatorHistoryEntry[] {
  const deleted = new Set(loadDeletedTranslatorJobs());
  return readArray<TranslatorHistoryEntry>(HISTORY_KEY).filter((entry) => !deleted.has(entry.jobId));
}

export function loadDeletedTranslatorJobs(): string[] {
  return readArray<string>(DELETED_KEY).filter((id) => typeof id === "string" && id.length > 0);
}

export function isTranslatorHistoryDeleted(jobId: string): boolean {
  return loadDeletedTranslatorJobs().includes(jobId);
}

function rememberDeletedTranslatorJob(jobId: string): void {
  if (!jobId) return;
  try {
    const existing = loadDeletedTranslatorJobs().filter((id) => id !== jobId);
    localStorage.setItem(DELETED_KEY, JSON.stringify([jobId, ...existing].slice(0, MAX_DELETED)));
  } catch {}
}

export function saveTranslatorHistory(entry: TranslatorHistoryEntry): void {
  if (isTranslatorHistoryDeleted(entry.jobId)) return;
  try {
    const existing = loadTranslatorHistory().filter((e) => e.jobId !== entry.jobId);
    localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...existing].slice(0, MAX_ENTRIES)));
  } catch {}
}

export function deleteTranslatorHistory(jobId: string): TranslatorHistoryEntry[] {
  rememberDeletedTranslatorJob(jobId);
  const updated = loadTranslatorHistory().filter((e) => e.jobId !== jobId);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
  return updated;
}

export function clearTranslatorHistory(): void {
  try {
    for (const entry of loadTranslatorHistory()) rememberDeletedTranslatorJob(entry.jobId);
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
}

export function loadActiveTranslatorJobs(): ActiveTranslatorJob[] {
  return readArray<ActiveTranslatorJob>(ACTIVE_KEY);
}

export function saveActiveTranslatorJobs(jobs: ActiveTranslatorJob[]): void {
  try {
    if (jobs.length === 0) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, JSON.stringify(jobs));
  } catch {}
}

export function upsertActiveTranslatorJob(job: ActiveTranslatorJob): void {
  const existing = loadActiveTranslatorJobs().filter((e) => e.jobId !== job.jobId);
  saveActiveTranslatorJobs([job, ...existing].slice(0, MAX_ENTRIES));
}

export function removeActiveTranslatorJob(jobId: string): void {
  saveActiveTranslatorJobs(loadActiveTranslatorJobs().filter((e) => e.jobId !== jobId));
}
