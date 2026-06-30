export function safeGeminiDisplayName(
  input: string | null | undefined,
  fallback = "upload.bin",
): string {
  const fallbackName = fallback.trim() || "upload.bin";
  const raw = String(input ?? "").trim() || fallbackName;
  const normalized = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/_+/g, "_")
    .trim();

  return (normalized || fallbackName).slice(0, 120);
}
