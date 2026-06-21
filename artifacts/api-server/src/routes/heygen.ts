import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import { existsSync, mkdirSync } from "fs";
import { readFile, rm } from "fs/promises";
import { join, extname, basename } from "path";
import { tmpdir } from "os";
import { isIP } from "net";
import { createGeminiClient, isGeminiConfigured, isVertexGeminiEnabled } from "../lib/gemini-client";
import { isS3StorageEnabled, uploadBufferToS3, getS3SignedDownloadUrl, readBufferFromS3, putBufferAtKey } from "../lib/s3-storage";

const router = Router();

const HEYGEN_BASE_URL = "https://api.heygen.com/v3";
const HEYGEN_API_KEY = (process.env.HEYGEN_API_KEY ?? "").trim();
// HeyGen's POST /v3/assets endpoint rejects anything over 32 MB with a 400,
// so we never allow an upload larger than that regardless of configuration.
const HEYGEN_ASSET_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_UPLOAD_MAX_BYTES = process.env.NODE_ENV === "production"
  ? 5 * 1024 * 1024            // prod: AWS Lambda request payload limit (~6 MB)
  : HEYGEN_ASSET_MAX_BYTES;    // dev: allow up to HeyGen's own 32 MB ceiling
const HEYGEN_UPLOAD_MAX_BYTES = Math.min(
  HEYGEN_ASSET_MAX_BYTES,
  Math.max(
    1,
    Number(process.env.HEYGEN_UPLOAD_MAX_BYTES ?? String(DEFAULT_UPLOAD_MAX_BYTES)) || DEFAULT_UPLOAD_MAX_BYTES,
  ),
);
// Cap subtitle uploads independently — SRT/VTT files are tiny text files.
const HEYGEN_SRT_MAX_BYTES = 5 * 1024 * 1024;
const HEYGEN_SRT_MODEL = process.env.HEYGEN_SRT_MODEL || process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-flash";
const HEYGEN_REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Math.min(120_000, Number(process.env.HEYGEN_REQUEST_TIMEOUT_MS ?? "60000") || 60_000),
);
const GEMINI_SRT_PROCESSING_TIMEOUT_MS = Math.max(
  30_000,
  Math.min(600_000, Number(process.env.HEYGEN_SRT_PROCESSING_TIMEOUT_MS ?? "180000") || 180_000),
);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,180}$/;
// Broad media set accepted for Gemini SRT transcription (Gemini handles many
// container formats, so we stay permissive on the transcription path).
const ALLOWED_FILE_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
]);
// Strict subset that HeyGen's /v3/assets endpoint actually accepts. Per the
// docs the asset endpoint supports png, jpeg, mp4, webm, mp3, wav, pdf — we
// only expose the audio/video formats relevant to video translation here.
const HEYGEN_ASSET_EXTENSIONS = new Set([".mp4", ".webm", ".mp3", ".wav"]);
const HEYGEN_ASSET_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
]);
const HEYGEN_ASSET_SUPPORTED_LABEL = "MP4, WebM, MP3, or WAV";

const uploadDir = join(tmpdir(), "videomaking-heygen-uploads");
mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname || "") || ".bin";
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: HEYGEN_UPLOAD_MAX_BYTES },
});

function runUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: `File is too large for this server path. Maximum is ${Math.floor(HEYGEN_UPLOAD_MAX_BYTES / 1024 / 1024)} MB.`,
      });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid multipart upload" });
  });
}

function requireHeyGenKey(res: Response): boolean {
  if (HEYGEN_API_KEY) return true;
  res.status(503).json({ error: "HEYGEN_API_KEY is not configured on the server." });
  return false;
}

function heygenHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    accept: "application/json",
    "x-api-key": HEYGEN_API_KEY,
    ...(extra ?? {}),
  };
}

async function readHeyGenJson(resp: globalThis.Response): Promise<unknown> {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchWithTimeout(url: string | URL, init?: RequestInit): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEYGEN_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
    const ipKind = isIP(host);
    if (ipKind === 4) {
      const [a, b] = host.split(".").map((part) => Number(part));
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
    }
    if (ipKind === 6) {
      if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateTranslationBody(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "JSON body is required";
  const input = body as Record<string, any>;
  const video = input.video;
  if (!video || typeof video !== "object" || Array.isArray(video)) return "video is required";
  if (video.type === "url") {
    if (typeof video.url !== "string" || !isSafeExternalUrl(video.url.trim())) {
      return "video.url must be a public http(s) URL";
    }
  } else if (video.type === "asset_id") {
    if (typeof video.asset_id !== "string" || !SAFE_ID_RE.test(video.asset_id)) {
      return "video.asset_id is invalid";
    }
  } else {
    return "video.type must be url or asset_id";
  }
  if (!Array.isArray(input.output_languages) || input.output_languages.length < 1) {
    return "output_languages must contain at least one language";
  }
  if (input.output_languages.length > 10 || input.output_languages.some((lang: unknown) => typeof lang !== "string" || lang.length > 120)) {
    return "output_languages contains an invalid language value";
  }
  if (input.audio) {
    const audio = input.audio;
    if (typeof audio !== "object" || Array.isArray(audio)) return "audio is invalid";
    if (audio.type === "asset_id" && (typeof audio.asset_id !== "string" || !SAFE_ID_RE.test(audio.asset_id))) {
      return "audio.asset_id is invalid";
    }
    if (audio.type === "url" && (typeof audio.url !== "string" || !isSafeExternalUrl(audio.url.trim()))) {
      return "audio.url must be a public http(s) URL";
    }
  }
  if (input.srt) {
    const srt = input.srt;
    if (typeof srt !== "object" || Array.isArray(srt)) return "srt is invalid";
    if (srt.type !== "url" || typeof srt.url !== "string" || !isSafeExternalUrl(srt.url.trim())) {
      return "srt.url must be a public http(s) URL";
    }
  }
  return null;
}

function isAllowedUploadFile(file: Express.Multer.File): boolean {
  const ext = extname(file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();
  return ALLOWED_FILE_EXTENSIONS.has(ext) || mime.startsWith("video/") || mime.startsWith("audio/") || mime === "application/octet-stream";
}

// Strict check for files forwarded to HeyGen's /v3/assets endpoint. Anything
// outside HeyGen's supported set is rejected locally with a clear 415 instead
// of bubbling up an opaque upstream 400.
function isHeyGenAssetFile(file: Express.Multer.File): boolean {
  const ext = extname(file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();
  return HEYGEN_ASSET_EXTENSIONS.has(ext) || HEYGEN_ASSET_MIMES.has(mime);
}

// Log the real error server-side but return a generic message to the client so
// internal details (outbound URLs, abort reasons) never leak in API responses.
function proxyError(req: Request, res: Response, fallback: string, err: unknown, status = 502): void {
  const detail = err instanceof Error ? err.message : String(err);
  (req as Request & { log?: { warn: (obj: unknown, msg?: string) => void } }).log?.warn(
    { err: detail },
    fallback,
  );
  res.status(status).json({ error: fallback });
}

// ── Poster thumbnails ──────────────────────────────────────────────────────
// Generate a single still-frame JPEG from a translated video so the project
// grids can render a lightweight <img> instead of a heavy <video> element.
const POSTER_CACHE_PREFIX = "heygen-posters";
const POSTER_FFMPEG_TIMEOUT_MS = 30_000;

function resolveFfmpegBin(): string {
  return process.env.FFMPEG_BIN || (ffmpegStatic as string | null) || "ffmpeg";
}

function generatePosterJpeg(videoUrl: string): Promise<Buffer> {
  const bin = resolveFfmpegBin();
  return new Promise<Buffer>((resolve, reject) => {
    // -ss before -i = fast input seek (only downloads the bytes needed to decode
    // a frame ~1s in). Scaled to 480px wide, single frame, piped to stdout.
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-ss", "1",
      "-i", videoUrl,
      "-frames:v", "1",
      "-vf", "scale=480:-2",
      "-q:v", "5",
      "-f", "image2",
      "-c:v", "mjpeg",
      "pipe:1",
    ];
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("poster ffmpeg timed out"));
    }, POSTER_FFMPEG_TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0 && buf.length > 0) {
        resolve(buf);
      } else {
        reject(new Error(`poster ffmpeg failed (code ${code}): ${Buffer.concat(err).toString("utf8").slice(-300)}`));
      }
    });
  });
}

async function proxyHeyGenJson(req: Request, res: Response, path: string, init?: RequestInit) {
  if (!requireHeyGenKey(res)) return;
  const url = new URL(`${HEYGEN_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, String(v)));
    } else if (value != null) {
      url.searchParams.set(key, String(value));
    }
  }

  const resp = await fetchWithTimeout(url, init);
  const body = await readHeyGenJson(resp);
  res.status(resp.status).json(body);
}

router.get("/me", async (req, res) => {
  try {
    await proxyHeyGenJson(req, res, "/users/me", { headers: heygenHeaders() });
  } catch (err) {
    proxyError(req, res, "HeyGen user lookup failed", err);
  }
});

router.get("/brand-glossaries", async (req, res) => {
  try {
    await proxyHeyGenJson(req, res, "/brand-glossaries", { headers: heygenHeaders() });
  } catch (err) {
    proxyError(req, res, "HeyGen glossary lookup failed", err);
  }
});

router.get("/video-translations", async (req, res) => {
  try {
    await proxyHeyGenJson(req, res, "/video-translations", { headers: heygenHeaders() });
  } catch (err) {
    proxyError(req, res, "HeyGen translation list failed", err);
  }
});

router.get("/video-translations/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!SAFE_ID_RE.test(id)) {
      res.status(400).json({ error: "Invalid translation id" });
      return;
    }
    await proxyHeyGenJson(req, res, `/video-translations/${encodeURIComponent(id)}`, {
      headers: heygenHeaders(),
    });
  } catch (err) {
    proxyError(req, res, "HeyGen translation status failed", err);
  }
});

// Lightweight poster image for a completed translation. Cached in S3 after first
// generation so the grids load a small cached JPEG instead of a heavy <video>.
router.get("/poster/:id", async (req, res) => {
  if (!requireHeyGenKey(res)) return;
  const id = String(req.params.id || "");
  if (!SAFE_ID_RE.test(id)) {
    res.status(400).json({ error: "Invalid translation id" });
    return;
  }
  if (!isS3StorageEnabled()) {
    res.status(404).json({ error: "Poster storage is not configured." });
    return;
  }

  const cacheKey = `${POSTER_CACHE_PREFIX}/${id}.jpg`;

  // 1) Serve from cache if we've already generated it.
  try {
    const cached = await readBufferFromS3(cacheKey);
    if (cached && cached.length > 0) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(cached);
      return;
    }
  } catch {
    // not cached yet → generate below
  }

  // 2) Resolve the current presigned video URL, then extract one frame.
  try {
    const resp = await fetchWithTimeout(`${HEYGEN_BASE_URL}/video-translations/${encodeURIComponent(id)}`, {
      headers: heygenHeaders(),
    });
    const body = (await readHeyGenJson(resp)) as { data?: { video_url?: unknown; status?: unknown } };
    const videoUrl = typeof body?.data?.video_url === "string" ? body.data.video_url : "";
    if (!videoUrl || !isSafeExternalUrl(videoUrl)) {
      res.status(404).json({ error: "No video available for poster." });
      return;
    }

    const poster = await generatePosterJpeg(videoUrl);
    // Cache for future requests (best-effort — don't block the response).
    void putBufferAtKey({ key: cacheKey, body: poster, contentType: "image/jpeg" }).catch(() => {});

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.end(poster);
  } catch (err) {
    proxyError(req, res, "Poster generation failed", err);
  }
});

router.post("/video-translations", async (req, res) => {
  if (!requireHeyGenKey(res)) return;
  const validationError = validateTranslationBody(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }
  try {
    const resp = await fetchWithTimeout(`${HEYGEN_BASE_URL}/video-translations`, {
      method: "POST",
      headers: heygenHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(req.body ?? {}),
    });
    const body = await readHeyGenJson(resp);
    res.status(resp.status).json(body);
  } catch (err) {
    proxyError(req, res, "HeyGen translation create failed", err);
  }
});

// Rename a translation job (HeyGen: PATCH /v3/video-translations/{id}, body { title }).
router.patch("/video-translations/:id", async (req, res) => {
  if (!requireHeyGenKey(res)) return;
  const id = String(req.params.id || "");
  if (!SAFE_ID_RE.test(id)) {
    res.status(400).json({ error: "Invalid translation id" });
    return;
  }
  const rawTitle = (req.body as { title?: unknown })?.title;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (!title || title.length > 300) {
    res.status(400).json({ error: "title is required (1-300 characters)" });
    return;
  }
  try {
    const resp = await fetchWithTimeout(`${HEYGEN_BASE_URL}/video-translations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: heygenHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ title }),
    });
    const body = await readHeyGenJson(resp);
    res.status(resp.status).json(body);
  } catch (err) {
    proxyError(req, res, "HeyGen translation update failed", err);
  }
});

// Permanently delete a translation job (HeyGen: DELETE /v3/video-translations/{id}).
router.delete("/video-translations/:id", async (req, res) => {
  if (!requireHeyGenKey(res)) return;
  const id = String(req.params.id || "");
  if (!SAFE_ID_RE.test(id)) {
    res.status(400).json({ error: "Invalid translation id" });
    return;
  }
  try {
    const resp = await fetchWithTimeout(`${HEYGEN_BASE_URL}/video-translations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: heygenHeaders(),
    });
    const body = await readHeyGenJson(resp);
    res.status(resp.status).json(body);
  } catch (err) {
    proxyError(req, res, "HeyGen translation delete failed", err);
  }
});

router.post("/assets", runUpload, async (req: Request, res: Response) => {
  if (!requireHeyGenKey(res)) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  if (!isHeyGenAssetFile(file)) {
    await rm(file.path, { force: true }).catch(() => {});
    res.status(415).json({ error: `Unsupported file type. HeyGen accepts ${HEYGEN_ASSET_SUPPORTED_LABEL}.` });
    return;
  }

  try {
    const bytes = await readFile(file.path);
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: file.mimetype || "application/octet-stream" }),
      file.originalname || basename(file.path),
    );

    const resp = await fetchWithTimeout(`${HEYGEN_BASE_URL}/assets`, {
      method: "POST",
      headers: heygenHeaders(),
      body: form,
    });
    const body = await readHeyGenJson(resp);
    res.status(resp.status).json(body);
  } catch (err) {
    proxyError(req, res, "HeyGen asset upload failed", err);
  } finally {
    await rm(file.path, { force: true }).catch(() => {});
  }
});

// Subtitle upload: host the SRT/VTT on our own S3 (short-lived presigned URL)
// and return that URL for the translation request. This replaces the previous
// browser-side upload to a third-party public host (tmpfiles.org), keeping
// potentially sensitive transcript content inside our own infrastructure.
router.post("/srt-upload", runUpload, async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  const ext = extname(file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();
  const looksLikeSubtitle = ext === ".srt" || ext === ".vtt" || mime.startsWith("text/") || mime === "application/x-subrip";
  if (!looksLikeSubtitle) {
    await rm(file.path, { force: true }).catch(() => {});
    res.status(415).json({ error: "Only .srt or .vtt subtitle files are supported" });
    return;
  }
  if (!isS3StorageEnabled()) {
    await rm(file.path, { force: true }).catch(() => {});
    res.status(503).json({ error: "Subtitle hosting is not configured on the server (S3 required)." });
    return;
  }
  try {
    const bytes = await readFile(file.path);
    if (bytes.byteLength > HEYGEN_SRT_MAX_BYTES) {
      res.status(413).json({ error: "Subtitle file is too large (max 5 MB)." });
      return;
    }
    const jobId = randomUUID();
    const safeName = (file.originalname || "subtitles.srt").replace(/[^\w.\-]+/g, "_").slice(0, 120);
    const isVtt = ext === ".vtt";
    const { key, filename } = await uploadBufferToS3({
      body: bytes,
      jobId,
      namespace: "heygen-srt",
      filename: safeName,
      contentType: isVtt ? "text/vtt" : "application/x-subrip",
    });
    // HeyGen fetches this URL server-side; a short-lived window is enough.
    const url = await getS3SignedDownloadUrl({ key, filename, expiresInSec: 6 * 60 * 60 });
    res.json({ url });
  } catch (err) {
    proxyError(req, res, "Subtitle upload failed", err);
  } finally {
    await rm(file.path, { force: true }).catch(() => {});
  }
});

const srtPrompt = `
You are an expert professional subtitle transcriber.
Transcribe the provided video/audio from start to end in the exact original spoken language.
Output only valid SRT text, with no markdown, explanations, summaries, labels, or code fences.
Use HH:MM:SS,mmm timestamps, sequential numbering, short readable subtitle blocks, and no overlapping timestamps.
Preserve names, devotional terms, Sanskrit/Hindi words, mixed-language speech, repetitions, and spoken wording accurately.
Do not translate unless the speaker actually changes language. Return only raw SRT.
`.trim();

router.post("/generate-srt", runUpload, async (req: Request, res: Response) => {
  if (!isGeminiConfigured()) {
    if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
    res.status(503).json({ error: "Gemini is not configured on the server." });
    return;
  }

  const file = req.file;
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  let uploadedName: string | undefined;

  try {
    const ai = createGeminiClient();
    const parts: any[] = [];

    if (file?.path) {
      if (!isAllowedUploadFile(file)) {
        res.status(415).json({ error: "Unsupported file type" });
        return;
      }
      const mimeType = file.mimetype || "video/mp4";
      if (isVertexGeminiEnabled()) {
        const data = (await readFile(file.path)).toString("base64");
        parts.push({ inlineData: { mimeType, data } });
      } else {
        const uploaded = await ai.files.upload({
          file: file.path,
          config: { mimeType, displayName: file.originalname || basename(file.path) },
        });
        uploadedName = uploaded.name;
        let fileInfo: any = uploaded;
        let attempts = 0;
        const startedAt = Date.now();
        while (fileInfo.state === "PROCESSING" && Date.now() - startedAt < GEMINI_SRT_PROCESSING_TIMEOUT_MS) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          fileInfo = await ai.files.get({ name: uploadedName! });
          attempts++;
        }
        if (fileInfo.state !== "ACTIVE") throw new Error("Gemini file processing timed out");
        parts.push({ fileData: { fileUri: fileInfo.uri, mimeType: fileInfo.mimeType || mimeType } });
      }
    } else if (url) {
      if (!isSafeExternalUrl(url)) {
        res.status(400).json({ error: "url must be a public http(s) URL" });
        return;
      }
      parts.push({ fileData: { fileUri: url, mimeType: "video/mp4" } });
    } else {
      res.status(400).json({ error: "file or url is required" });
      return;
    }

    parts.push({ text: srtPrompt });
    const result = await ai.models.generateContent({
      model: HEYGEN_SRT_MODEL,
      contents: [{ role: "user", parts }],
    });
    const text = String((result as any).text ?? "")
      .replace(/```srt/gi, "")
      .replace(/```/g, "")
      .trim();
    res.json({ srt: text });
  } catch (err) {
    proxyError(req, res, "Gemini SRT generation failed", err);
  } finally {
    if (uploadedName) {
      try {
        const ai = createGeminiClient();
        await ai.files.delete({ name: uploadedName });
      } catch {
        // best-effort cleanup
      }
    }
    if (file?.path && existsSync(file.path)) await rm(file.path, { force: true }).catch(() => {});
  }
});

const verifySrtPrompt = `
You are a senior professional transcription expert with 20+ years of experience verifying and correcting auto-generated subtitles for video content.

You will be given:
1. A video (YouTube URL) — watch and listen carefully to every word
2. An auto-generated SRT subtitle file — cross-check every word against what is actually spoken

Your task: VERIFY and CORRECT the SRT word-by-word.

What to fix:
- Wrong words, missed words, extra words, incorrect phrases
- Mishearings — especially names, places, devotional terms, Sanskrit/Hindi words, technical terms, numbers
- Broken or run-on subtitle blocks that don't match natural speech breaks
- Obvious timing mismatches where text clearly doesn't match the speech at that timestamp

Hard rules (never break these):
- Do NOT translate — keep the original spoken language(s) exactly
- Do NOT add sound descriptors: [music], [applause], [laughter], [inaudible], etc.
- Do NOT add speaker labels
- Do NOT reword, paraphrase, or improve the style — only fix actual transcription errors
- Do NOT change correct blocks — if a subtitle is accurate, leave it exactly as-is
- Preserve SRT format exactly: sequential numbers, HH:MM:SS,mmm --> HH:MM:SS,mmm timestamps, subtitle text
- Return ONLY the corrected SRT text — no markdown, no explanations, no code fences, no commentary
`.trim();

router.post("/verify-srt", async (req: Request, res: Response) => {
  if (!isGeminiConfigured()) {
    res.status(503).json({ error: "Gemini is not configured on the server." });
    return;
  }

  const srt = typeof req.body?.srt === "string" ? req.body.srt.trim() : "";
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";

  if (!srt) {
    res.status(400).json({ error: "srt text is required" });
    return;
  }
  if (!url) {
    res.status(400).json({ error: "video url is required for verification" });
    return;
  }
  if (!isSafeExternalUrl(url)) {
    res.status(400).json({ error: "url must be a public http(s) URL" });
    return;
  }

  try {
    const ai = createGeminiClient();
    const parts: any[] = [
      { fileData: { fileUri: url, mimeType: "video/mp4" } },
      { text: `${verifySrtPrompt}\n\nHere is the auto-generated SRT to verify and correct:\n\n${srt}` },
    ];

    const result = await ai.models.generateContent({
      model: HEYGEN_SRT_MODEL,
      contents: [{ role: "user", parts }],
    });
    const text = String((result as any).text ?? "")
      .replace(/```srt/gi, "")
      .replace(/```/g, "")
      .trim();

    if (!text) throw new Error("Empty response from Gemini verification");
    res.json({ srt: text });
  } catch (err) {
    proxyError(req, res, "Gemini SRT verification failed", err);
  }
});

export default router;
