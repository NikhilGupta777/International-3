import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { readFile, rm } from "fs/promises";
import { join, extname, basename } from "path";
import { tmpdir } from "os";
import { isIP } from "net";
import { createGeminiClient, isGeminiConfigured, isVertexGeminiEnabled } from "../lib/gemini-client";

const router = Router();

const HEYGEN_BASE_URL = "https://api.heygen.com/v3";
const HEYGEN_API_KEY = (process.env.HEYGEN_API_KEY ?? "").trim();
const DEFAULT_UPLOAD_MAX_BYTES = process.env.NODE_ENV === "production"
  ? 5 * 1024 * 1024
  : 512 * 1024 * 1024;
const HEYGEN_UPLOAD_MAX_BYTES = Math.max(
  1,
  Number(process.env.HEYGEN_UPLOAD_MAX_BYTES ?? String(DEFAULT_UPLOAD_MAX_BYTES)) || DEFAULT_UPLOAD_MAX_BYTES,
);
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

router.get("/disabled-config", (_req, res) => {
  res.status(404).json({ error: "Client-side config files are disabled. HeyGen keys are server-managed." });
});

router.get("/me", async (req, res) => {
  try {
    await proxyHeyGenJson(req, res, "/users/me", { headers: heygenHeaders() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "HeyGen user lookup failed" });
  }
});

router.get("/brand-glossaries", async (req, res) => {
  try {
    await proxyHeyGenJson(req, res, "/brand-glossaries", { headers: heygenHeaders() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "HeyGen glossary lookup failed" });
  }
});

router.get("/video-translations", async (req, res) => {
  try {
    await proxyHeyGenJson(req, res, "/video-translations", { headers: heygenHeaders() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "HeyGen translation list failed" });
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
    res.status(502).json({ error: err instanceof Error ? err.message : "HeyGen translation status failed" });
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
    res.status(502).json({ error: err instanceof Error ? err.message : "HeyGen translation create failed" });
  }
});

router.post("/assets", runUpload, async (req: Request, res: Response) => {
  if (!requireHeyGenKey(res)) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file is required" });
    return;
  }
  if (!isAllowedUploadFile(file)) {
    await rm(file.path, { force: true }).catch(() => {});
    res.status(415).json({ error: "Unsupported file type" });
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
    res.status(502).json({ error: err instanceof Error ? err.message : "HeyGen asset upload failed" });
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
    res.status(502).json({ error: err instanceof Error ? err.message : "Gemini SRT generation failed" });
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

export default router;
