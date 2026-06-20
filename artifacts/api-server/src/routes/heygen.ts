import { Router, Request, Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { readFile, rm } from "fs/promises";
import { join, extname, basename } from "path";
import { tmpdir } from "os";
import { createGeminiClient, isGeminiConfigured, isVertexGeminiEnabled } from "../lib/gemini-client";

const router = Router();

const HEYGEN_BASE_URL = "https://api.heygen.com/v3";
const HEYGEN_API_KEY = (process.env.HEYGEN_API_KEY ?? "").trim();
const HEYGEN_UPLOAD_MAX_BYTES = Math.max(
  1,
  Number(process.env.HEYGEN_UPLOAD_MAX_BYTES ?? String(512 * 1024 * 1024)) || 512 * 1024 * 1024,
);
const HEYGEN_SRT_MODEL = process.env.HEYGEN_SRT_MODEL || process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.5-flash";

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

  const resp = await fetch(url, init);
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
    await proxyHeyGenJson(req, res, `/video-translations/${encodeURIComponent(req.params.id)}`, {
      headers: heygenHeaders(),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "HeyGen translation status failed" });
  }
});

router.post("/video-translations", async (req, res) => {
  if (!requireHeyGenKey(res)) return;
  try {
    const resp = await fetch(`${HEYGEN_BASE_URL}/video-translations`, {
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

router.post("/assets", upload.single("file"), async (req: Request, res: Response) => {
  if (!requireHeyGenKey(res)) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file is required" });
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

    const resp = await fetch(`${HEYGEN_BASE_URL}/assets`, {
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

router.post("/generate-srt", upload.single("file"), async (req: Request, res: Response) => {
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
        while (fileInfo.state === "PROCESSING" && attempts < 90) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          fileInfo = await ai.files.get({ name: uploadedName! });
          attempts++;
        }
        if (fileInfo.state !== "ACTIVE") throw new Error("Gemini file processing timed out");
        parts.push({ fileData: { fileUri: fileInfo.uri, mimeType: fileInfo.mimeType || mimeType } });
      }
    } else if (url) {
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
