// Pita Ji YouTube URL normalizer — accepts any youtu.be / shorts / live /
// embed / mobile share / watch URL and returns a canonical
// https://www.youtube.com/watch?v=<id> form. Any non-YouTube URL is returned
// unchanged.
//
// This mirrors the extractVideoId helper that already exists inside
// routes/youtube.ts and routes/subtitles.ts so behaviour is consistent across
// the app, but is exposed as a small reusable module instead of being
// duplicated again.

export function extractYoutubeVideoId(url: string): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (host.includes("youtube.com") || host === "m.youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      // /shorts/<id>, /live/<id>, /embed/<id>, /v/<id>
      if (parts.length >= 2 && /^(shorts|live|embed|v)$/i.test(parts[0])) {
        return parts[1] ?? null;
      }
    } else if (host.includes("youtu.be")) {
      const first = u.pathname.split("/").filter(Boolean)[0];
      return first ?? null;
    }
  } catch {
    // not a valid URL
  }
  // Last-resort: bare 11-char video id pasted alone.
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

export function isYoutubeUrl(url: string): boolean {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    return (
      host.includes("youtube.com") ||
      host.includes("youtu.be")
    );
  } catch {
    // bare id → still treated as YouTube
    return /^[A-Za-z0-9_-]{11}$/.test(trimmed);
  }
}

/**
 * Normalize ANY YouTube URL form (or bare id) to the canonical
 * `https://www.youtube.com/watch?v=<id>` form expected by yt-dlp and Gemini's
 * `fileData.fileUri`. Non-YouTube URLs are returned trimmed but unchanged.
 */
export function normalizeYoutubeUrl(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  if (!isYoutubeUrl(trimmed)) return trimmed;
  const id = extractYoutubeVideoId(trimmed);
  if (!id) return trimmed;
  return `https://www.youtube.com/watch?v=${id}`;
}
