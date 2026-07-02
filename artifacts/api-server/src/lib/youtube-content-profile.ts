// Same model as the Copilot's "Ultra" mode (highest thinking). Runs with
// includeThoughts + function tools, exactly like the Copilot's agentic loop.
export const CONTENT_MANAGER_MODEL =
  (process.env.CONTENT_MANAGER_MODEL ?? "").trim() || "gemma-4-31b-it";
export const CONTENT_PROFILE_MAX_VIDEOS = 50;
export const CONTENT_PROFILE_MAX_FULL_DESCRIPTIONS = 8;

export type ScrapedVideoInput = {
  id?: string;
  url?: string;
  title?: string;
  description?: string;
  tags?: string[];
  publishedAt?: string;
  durationSec?: number | null;
  viewCount?: number | null;
  likeCount?: number | null;
  commentCount?: number | null;
  thumbnailUrl?: string | null;
};

export type ChannelVideoProfile = {
  id: string;
  url: string;
  title: string;
  tags: string[];
  publishedAt: string | null;
  durationSec: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  thumbnailUrl: string | null;
  description?: never;
};

export type ChannelDescriptionProfile = {
  videoId: string;
  title: string;
  description: string;
};

export type ChannelAnalyticsSummary = {
  videoCount: number;
  averageViews: number | null;
  topTags: string[];
  highPerformingTopics: string[];
  bestObservedUploadWindows: string[];
  uploadCadence: string;
};

export type ScrapedChannelProfile = {
  channelName: string;
  channelInput: string;
  channelId?: string;
  channelUrl?: string;
  handle?: string;
  scrapedAt: number;
  source: "yt-dlp";
  recentVideos: ChannelVideoProfile[];
  recentDescriptions: ChannelDescriptionProfile[];
  analyticsSummary: ChannelAnalyticsSummary;
};

export function buildScrapedChannelProfile(params: {
  channelName: string;
  channelInput: string;
  channelId?: string;
  channelUrl?: string;
  handle?: string;
  videos: ScrapedVideoInput[];
  now?: number;
}): ScrapedChannelProfile {
  const recentVideos = params.videos
    .slice(0, CONTENT_PROFILE_MAX_VIDEOS)
    .map((item, index) => normalizeVideo(item, index))
    .filter((item) => item.title);

  const recentDescriptions = params.videos
    .slice(0, CONTENT_PROFILE_MAX_FULL_DESCRIPTIONS)
    .map((item, index) => ({
      videoId: cleanString(item.id) || `video-${index + 1}`,
      title: cleanString(item.title),
      description: cleanString(item.description),
    }))
    .filter((item) => item.description);

  return {
    channelName: cleanString(params.channelName) || "YouTube channel",
    channelInput: cleanString(params.channelInput),
    channelId: cleanString(params.channelId) || undefined,
    channelUrl: cleanString(params.channelUrl) || undefined,
    handle: cleanString(params.handle) || undefined,
    scrapedAt: params.now ?? Date.now(),
    source: "yt-dlp",
    recentVideos,
    recentDescriptions,
    analyticsSummary: buildAnalyticsSummary(recentVideos),
  };
}

export function buildContentManagerModelContext(params: {
  profile: ScrapedChannelProfile;
  topic: string;
}): string {
  const { profile } = params;
  const summaries = profile.recentVideos
    .map((video, index) => {
      const stats = [
        video.viewCount != null ? `views=${video.viewCount}` : "",
        video.likeCount != null ? `likes=${video.likeCount}` : "",
        video.commentCount != null ? `comments=${video.commentCount}` : "",
        video.durationSec != null ? `durationSec=${video.durationSec}` : "",
      ].filter(Boolean).join(", ");
      return `${index + 1}. ${video.title}
   url=${video.url || "unknown"}
   publishedAt=${video.publishedAt ?? "unknown"}
   tags=${video.tags.join(", ") || "none"}
   ${stats || "publicStats=unknown"}`;
    })
    .join("\n");

  const descriptions = profile.recentDescriptions
    .map((item, index) => `${index + 1}. ${item.title}\n${item.description}`)
    .join("\n\n");

  return `CHANNEL: ${profile.channelName}
USER TOPIC: ${params.topic}

PUBLIC ANALYTICS SUMMARY:
${JSON.stringify(profile.analyticsSummary, null, 2)}

RECENT 50 VIDEO SUMMARIES:
${summaries || "No saved video summaries."}

RECENT FULL DESCRIPTIONS (MAX 8):
${descriptions || "No saved full descriptions."}

TASK:
Analyze the saved channel data and the user's topic.
If the topic is time-sensitive (breaking news, a current event, "today"/"latest", a trending angle, or anything that needs facts you are not sure about), call the web_search tool BEFORE deciding on titles — otherwise skip it.
Write a short plain-language summary of your recommendation for the user, then call request_content_pack with: exactly 5 title options, 1 fully SEO-optimized description, comma-separated tags, the best upload time, and 1-3 must-do recommendations.
Use only public metrics saved above. Do not claim CTR, retention, impressions, subscriber demographics, or private YouTube Studio analytics unless those exact fields are present in the saved profile.`;
}

function normalizeVideo(item: ScrapedVideoInput, index: number): ChannelVideoProfile {
  const id = cleanString(item.id) || inferVideoId(item.url) || `video-${index + 1}`;
  return {
    id,
    url: cleanString(item.url),
    title: cleanString(item.title),
    tags: uniqueClean(item.tags ?? []).slice(0, 40),
    publishedAt: normalizeDate(item.publishedAt),
    durationSec: normalizeNumber(item.durationSec),
    viewCount: normalizeNumber(item.viewCount),
    likeCount: normalizeNumber(item.likeCount),
    commentCount: normalizeNumber(item.commentCount),
    thumbnailUrl: cleanString(item.thumbnailUrl) || null,
  };
}

function buildAnalyticsSummary(videos: ChannelVideoProfile[]): ChannelAnalyticsSummary {
  const viewCounts = videos.map((item) => item.viewCount).filter((n): n is number => typeof n === "number");
  const averageViews = viewCounts.length
    ? Math.round(viewCounts.reduce((sum, value) => sum + value, 0) / viewCounts.length)
    : null;
  const topTags = topItems(videos.flatMap((item) => item.tags), 20);
  const highPerformingTopics = deriveHighPerformingTopics(videos);
  const bestObservedUploadWindows = deriveUploadWindows(videos);
  return {
    videoCount: videos.length,
    averageViews,
    topTags,
    highPerformingTopics,
    bestObservedUploadWindows,
    uploadCadence: deriveUploadCadence(videos),
  };
}

function deriveHighPerformingTopics(videos: ChannelVideoProfile[]): string[] {
  const withViews = videos.filter((item) => typeof item.viewCount === "number");
  const source = (withViews.length ? withViews : videos)
    .slice()
    .sort((a, b) => (b.viewCount ?? 0) - (a.viewCount ?? 0))
    .slice(0, 10);
  const terms = new Map<string, number>();
  for (const video of source) {
    for (const token of [...video.tags, ...tokenizeTitle(video.title)]) {
      terms.set(token, (terms.get(token) ?? 0) + 1);
    }
  }
  return [...terms.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([term]) => titleCase(term));
}

function deriveUploadWindows(videos: ChannelVideoProfile[]): string[] {
  const buckets = new Map<string, { count: number; views: number }>();
  for (const video of videos) {
    if (!video.publishedAt) continue;
    const date = new Date(video.publishedAt);
    if (Number.isNaN(date.getTime())) continue;
    const weekday = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "Asia/Kolkata" });
    const hour = Number(date.toLocaleTimeString("en-US", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }).slice(0, 2));
    const bucketHour = Math.floor(hour / 2) * 2;
    const key = `${weekday} ${String(bucketHour).padStart(2, "0")}:00-${String(bucketHour + 2).padStart(2, "0")}:00 IST`;
    const current = buckets.get(key) ?? { count: 0, views: 0 };
    current.count += 1;
    current.views += video.viewCount ?? 0;
    buckets.set(key, current);
  }
  return [...buckets.entries()]
    .sort((a, b) => (b[1].views / b[1].count) - (a[1].views / a[1].count))
    .slice(0, 3)
    .map(([key]) => key);
}

function deriveUploadCadence(videos: ChannelVideoProfile[]): string {
  const dated = videos
    .map((item) => item.publishedAt ? new Date(item.publishedAt).getTime() : NaN)
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => b - a);
  if (dated.length < 2) return "Not enough public upload dates to estimate cadence.";
  const gaps = [];
  for (let i = 1; i < dated.length; i += 1) {
    gaps.push(Math.abs(dated[i - 1] - dated[i]) / (24 * 60 * 60 * 1000));
  }
  const averageGap = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (averageGap < 1.5) return "Multiple uploads per week, often daily.";
  if (averageGap < 4) return "Several uploads per week.";
  if (averageGap < 9) return "Roughly weekly uploads.";
  return `Uploads roughly every ${Math.round(averageGap)} days.`;
}

function topItems(items: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items.map((value) => value.trim().toLowerCase()).filter(Boolean)) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([item]) => item);
}

function tokenizeTitle(title: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "latest", "update", "news", "big", "full"]);
  return title
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097f]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length > 2 && !stop.has(item));
}

function uniqueClean(values: string[]): string[] {
  return [...new Set(values.map(cleanString).filter(Boolean))];
}

function cleanString(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeDate(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw) return null;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function inferVideoId(url: unknown): string {
  const raw = cleanString(url);
  const match = /(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/.exec(raw);
  return match?.[1] ?? "";
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
