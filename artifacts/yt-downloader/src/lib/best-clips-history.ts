import type { BestClip } from "@/components/BestClips";

const HISTORY_KEY = "ytgrabber_bestclips_history";
const MAX_ENTRIES = 20;

export interface BestClipsHistoryEntry {
  id: string;
  createdAt: number;
  url: string;
  clipCount: number;
  hasTranscript: boolean;
  clips: BestClip[];
}

export function loadBestClipsHistory(): BestClipsHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BestClipsHistoryEntry[]) : [];
  } catch { return []; }
}

export function saveToBestClipsHistory(entry: BestClipsHistoryEntry): void {
  try {
    const existing = loadBestClipsHistory().filter((e) => e.id !== entry.id);
    const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
}

export function deleteFromBestClipsHistory(id: string): BestClipsHistoryEntry[] {
  const updated = loadBestClipsHistory().filter((e) => e.id !== id);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch {}
  return updated;
}

export function clearBestClipsHistory(): void {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
}
