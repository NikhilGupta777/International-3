const HISTORY_KEY = "ytgrabber_music_history";
const MAX_ENTRIES = 30;

export interface MusicHistoryEntry {
  id: string;
  createdAt: number;
  label: string;       // "30s Clip — Madhav Madhav bhajan"
  audioUrl: string;    // S3 signed URL
  imageUrl?: string;   // cover art URL
  mimeType: string;    // "audio/mpeg"
  filename: string;
}

export function loadMusicHistory(): MusicHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MusicHistoryEntry[]) : [];
  } catch { return []; }
}

export function saveToMusicHistory(entry: MusicHistoryEntry): void {
  try {
    const existing = loadMusicHistory().filter((e) => e.id !== entry.id);
    const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
}

export function deleteFromMusicHistory(id: string): void {
  try {
    const updated = loadMusicHistory().filter((e) => e.id !== id);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  } catch {}
}

export function clearMusicHistory(): void {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
}
