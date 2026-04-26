const HISTORY_KEY = "ytgrabber_translator_history";
const ACTIVE_KEY = "ytgrabber_active_translator_jobs";
const MAX_ENTRIES = 30;

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
  return readArray<TranslatorHistoryEntry>(HISTORY_KEY);
}

export function saveTranslatorHistory(entry: TranslatorHistoryEntry): void {
  try {
    const existing = loadTranslatorHistory().filter((e) => e.jobId !== entry.jobId);
    localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...existing].slice(0, MAX_ENTRIES)));
  } catch {}
}

export function deleteTranslatorHistory(jobId: string): TranslatorHistoryEntry[] {
  const updated = loadTranslatorHistory().filter((e) => e.jobId !== jobId);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
  return updated;
}

export function clearTranslatorHistory(): void {
  try {
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
