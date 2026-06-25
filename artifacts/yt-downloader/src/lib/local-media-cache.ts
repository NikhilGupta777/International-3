// Session-scoped registry mapping a workspace asset path to the local File the
// user just picked. Lets the AI Video Studio editor play the REAL file instantly
// via a blob: URL (no upload wait, no server round-trip) while the upload to the
// server still happens in the background for the agent + final render.
//
// Cleared on full page reload — after that the editor falls back to streaming
// the uploaded copy from the server, so nothing breaks, it's just not "instant".

const fileMap = new Map<string, File>();
const urlMap = new Map<string, string>();
const MAX_ENTRIES = 24;

export function registerLocalMedia(path: string, file: File | undefined | null): void {
  if (!path || !file) return;
  // Revoke a stale object URL if this path is being re-registered.
  const old = urlMap.get(path);
  if (old) { try { URL.revokeObjectURL(old); } catch { /* */ } urlMap.delete(path); }
  fileMap.set(path, file);
  // Evict oldest to bound memory (File refs are cheap, object URLs less so).
  while (fileMap.size > MAX_ENTRIES) {
    const oldest = fileMap.keys().next().value;
    if (!oldest) break;
    fileMap.delete(oldest);
    const u = urlMap.get(oldest);
    if (u) { try { URL.revokeObjectURL(u); } catch { /* */ } urlMap.delete(oldest); }
  }
}

/** Returns a blob: URL for a locally-known asset, creating it lazily. Null if
 *  the file isn't in this session (e.g. after reload or a different device). */
export function getLocalMediaUrl(path: string): string | null {
  if (!path) return null;
  const existing = urlMap.get(path);
  if (existing) return existing;
  const file = fileMap.get(path);
  if (!file) return null;
  try { const url = URL.createObjectURL(file); urlMap.set(path, url); return url; }
  catch { return null; }
}

export function hasLocalMedia(path: string): boolean {
  return fileMap.has(path);
}
