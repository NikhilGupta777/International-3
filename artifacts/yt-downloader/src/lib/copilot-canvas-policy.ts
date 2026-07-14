const SRT_TIMING_LINE = /(?:^|\n)\s*(?:\d+\s*\n\s*)?\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}(?:\s|$)/m;

export function inferCanvasLanguage(language?: string, content?: string): string {
  const clean = String(language || "").trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, "");
  const sample = String(content || "").trim().slice(0, 4000);
  if (/^webvtt(?:\s|$)/i.test(sample)) return "vtt";
  if (SRT_TIMING_LINE.test(sample)) return "srt";
  if (clean) return clean;
  const lower = sample.toLowerCase();
  if (lower.includes("<!doctype html") || /<html[\s>]/i.test(sample)) return "html";
  if (/^\s*[{[]/.test(sample)) return "json";
  return "text";
}

export function shouldPromoteFencedBlockToCanvas(language: string, content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  const normalizedLanguage = inferCanvasLanguage(language, trimmed);
  if (normalizedLanguage === "srt" || normalizedLanguage === "vtt") {
    const cueCount = (trimmed.match(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g) || []).length;
    return cueCount > 5;
  }
  if (normalizedLanguage === "html" && /<!doctype html|<html[\s>]/i.test(trimmed)) return true;
  return trimmed.replace(/\r\n?/g, "\n").split("\n").length > 15;
}
