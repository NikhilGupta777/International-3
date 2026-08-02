export type DownloadPlatform = "youtube" | "instagram";

const YOUTUBE_HOST_RE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;
const INSTAGRAM_HOST_RE = /(^|\.)instagram\.com$/i;
const INSTAGRAM_VIDEO_PATH_RE = /^\/(?:p|reel|reels|tv|stories)\/[^/?#]+/i;

export function getDownloadPlatform(rawUrl: string): DownloadPlatform | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    if (YOUTUBE_HOST_RE.test(url.hostname)) return "youtube";
    if (
      INSTAGRAM_HOST_RE.test(url.hostname) &&
      INSTAGRAM_VIDEO_PATH_RE.test(url.pathname)
    ) {
      return "instagram";
    }
  } catch {
    // Invalid URLs are unsupported.
  }

  return null;
}

export function isSupportedDownloadUrl(rawUrl: string): boolean {
  return getDownloadPlatform(rawUrl) !== null;
}

export function isInstagramUrl(rawUrl: string): boolean {
  return getDownloadPlatform(rawUrl) === "instagram";
}

export function getDownloadPlatformArgs(rawUrl: string): string[] {
  const platform = getDownloadPlatform(rawUrl);
  if (!platform) return [];

  const origin =
    platform === "instagram"
      ? "https://www.instagram.com"
      : "https://www.youtube.com";

  return [
    "--add-headers",
    `Referer:${origin}/`,
    "--add-headers",
    `Origin:${origin}`,
  ];
}
