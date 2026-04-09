import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
} from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { logger } from "../lib/logger";
import ffmpegStatic from "ffmpeg-static";

const router = Router();

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/tmp/ytgrabber";

// ── Python / yt-dlp environment (mirrors setup in youtube.ts) ────────────────
// Make yt-dlp visible to Python without overriding system PATH in environments
// where .pythonlibs does not exist (e.g. the Docker production container).
const _workspaceRoot = process.env.REPL_HOME ?? process.cwd();

function buildPythonEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const pythonLibsBin = join(workspaceRoot, ".pythonlibs", "bin");
  const pythonLibsLib = join(workspaceRoot, ".pythonlibs", "lib");

  if (!existsSync(pythonLibsBin)) {
    return { ...process.env, PYTHONUNBUFFERED: "1" };
  }

  let sitePackages = join(pythonLibsLib, "python3.11", "site-packages");
  try {
    const entries = readdirSync(pythonLibsLib);
    const pyDir = entries.find((e) => /^python3\.\d+$/.test(e));
    if (pyDir) sitePackages = join(pythonLibsLib, pyDir, "site-packages");
  } catch {}

  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PATH: `${pythonLibsBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONPATH: sitePackages,
  };
}

const PYTHON_ENV = buildPythonEnv(_workspaceRoot);
const PYTHON_BIN =
  process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");

// ── yt-dlp config (mirrors youtube.ts / bhagwat.ts) ─────────────────────────
const YTDLP_PROXY        = process.env.YTDLP_PROXY ?? "";
const YTDLP_POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL ?? "";
const YTDLP_PO_TOKEN     = process.env.YTDLP_PO_TOKEN ?? "";
const YTDLP_VISITOR_DATA = process.env.YTDLP_VISITOR_DATA ?? "";
const HAS_DYNAMIC_POT_PROVIDER = !!YTDLP_POT_PROVIDER_URL;
const HAS_STATIC_PO_TOKEN = !!(YTDLP_PO_TOKEN && YTDLP_VISITOR_DATA);
const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ?? join(_workspaceRoot, ".yt-cookies.txt");

// Base args applied to every yt-dlp call (matches youtube.ts for consistency).
const YTDLP_BASE_ARGS: string[] = [
  "--retries",            "5",
  "--fragment-retries",   "5",
  "--extractor-retries",  "5",
  "--socket-timeout",     "30",
  "--js-runtimes", "node",
  "--js-runtimes", "bun",
  "--remote-components", "ejs:github",
  "--add-headers",
  [
    "Accept-Language:en-US,en;q=0.9",
    "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer:https://www.youtube.com/",
    "Origin:https://www.youtube.com",
  ].join(";"),
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "--sleep-requests", "1",
  "--sleep-interval",  "2",
];

if (ffmpegStatic) YTDLP_BASE_ARGS.push("--ffmpeg-location", ffmpegStatic);
if (YTDLP_PROXY) YTDLP_BASE_ARGS.push("--proxy", YTDLP_PROXY);

if (HAS_DYNAMIC_POT_PROVIDER) {
  YTDLP_BASE_ARGS.push(
    "--extractor-args",
    `youtubepot-bgutilhttp:base_url=${YTDLP_POT_PROVIDER_URL}`,
  );
}

function getDefaultSrtYoutubeExtractorArgs(): string[] {
  if (HAS_DYNAMIC_POT_PROVIDER) {
    return [
      "--extractor-args",
      "youtube:player_client=web,web_embedded,mweb",
    ];
  }
  if (HAS_STATIC_PO_TOKEN) {
    return [
      "--extractor-args",
      `youtube:player_client=web,web_embedded,mweb;po_token=web.gvs+${YTDLP_PO_TOKEN};visitor_data=${YTDLP_VISITOR_DATA}`,
    ];
  }
  return [
    "--extractor-args",
    "youtube:player_client=tv_embedded,android_vr,mweb,-android_sdkless",
  ];
}

function getSrtYoutubeFallbacks(): string[][] {
  if (HAS_DYNAMIC_POT_PROVIDER || HAS_STATIC_PO_TOKEN) {
    return [
      ["--extractor-args", "youtube:player_client=web,web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=web_embedded,mweb"],
      ["--extractor-args", "youtube:player_client=mweb,ios"],
      ["--extractor-args", "youtube:player_client=ios"],
      ["--extractor-args", "youtube:player_client=android_vr"],
    ];
  }
  return [
    ["--extractor-args", "youtube:player_client=tv_embedded,android_vr"],
    ["--extractor-args", "youtube:player_client=tv_embedded"],
    ["--extractor-args", "youtube:player_client=android_vr"],
    ["--extractor-args", "youtube:player_client=mweb"],
    ["--extractor-args", "youtube:player_client=ios"],
  ];
}

// Return cookie args only when the cookies file exists and is a valid Netscape file.
function getSrtCookieArgs(): string[] {
  if (!YTDLP_COOKIES_FILE) return [];
  try {
    if (!existsSync(YTDLP_COOKIES_FILE)) return [];
    const stat = statSync(YTDLP_COOKIES_FILE);
    if (!stat.isFile() || stat.size < 24) return [];
    const header = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
    if (
      !header.startsWith("# Netscape HTTP Cookie File") &&
      !header.startsWith(".youtube.com")
    ) return [];
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch { return []; }
}

// YouTube block detection — broad pattern to catch all YouTube error variants in 2025/2026.
function isSrtYtBlocked(msg: string): boolean {
  return /confirm.*not a bot|sign in to confirm|sign.*in.*required|sign.*in.*your age|age.*restrict|http error 429|too many requests|rate.?limit|forbidden|http error 403|access.*denied|bot.*detect|unable to extract|nsig.*extraction|player.*response|no video formats|video.*unavailable.*country|precondition.*failed|http error 401|not made this video available|not available in your country|geo.*restrict|requested format is not available/i.test(msg);
}

// Fallback clients ordered by reliability on AWS/datacenter IPs.
// tv_embedded (YouTube TV embedded player) is the least bot-checked on server IPs.
const SRT_YTDLP_FALLBACKS: string[][] = getSrtYoutubeFallbacks();

/**
 * Run yt-dlp to download audio for a subtitles job.
 * Supports cancellation via job.cancelled and retries with fallback clients on YouTube bot-blocks.
 */
async function runYtDlpAudio(args: string[], job: { cancelled?: boolean }): Promise<void> {
  function spawnOnce(extraArgs: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(
        PYTHON_BIN,
        ["-m", "yt_dlp", ...YTDLP_BASE_ARGS, ...extraArgs, ...args],
        { env: PYTHON_ENV },
      );
      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      const cancelPoll = setInterval(() => {
        if (job.cancelled) {
          clearInterval(cancelPoll);
          try { proc.kill("SIGTERM"); } catch {}
        }
      }, 500);
      proc.on("close", (code) => {
        clearInterval(cancelPoll);
        if (job.cancelled) resolve();
        else if (code === 0) resolve();
        else reject(new Error(stderr.slice(-400) || `yt-dlp exited ${code}`));
      });
      proc.on("error", (err) => { clearInterval(cancelPoll); reject(err); });
    });
  }

  const cookieArgs = getSrtCookieArgs();
  const defaultYoutubeArgs = getDefaultSrtYoutubeExtractorArgs();
  const attemptPlans: string[][] = [];
  if (cookieArgs.length) attemptPlans.push([...cookieArgs, ...defaultYoutubeArgs]);
  attemptPlans.push(defaultYoutubeArgs);

  let lastErr: Error | null = null;
  const attempted = new Set<string>();

  for (const extra of attemptPlans) {
    if (job.cancelled) return;
    const key = extra.join("\x01");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      await spawnOnce(extra);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error("yt-dlp failed");
      if (!isSrtYtBlocked(lastErr.message)) throw lastErr;
    }
  }

  for (const fallback of SRT_YTDLP_FALLBACKS) {
    if (job.cancelled) return;
    const plans = cookieArgs.length ? [[...cookieArgs, ...fallback], fallback] : [fallback];
    for (const extra of plans) {
      const key = extra.join("\x01");
      if (attempted.has(key)) continue;
      attempted.add(key);
      try {
        await spawnOnce(extra);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error("yt-dlp fallback failed");
      }
    }
  }

  throw lastErr ?? new Error("yt-dlp: all clients failed");
}

// ── In-memory job store ──────────────────────────────────────────────────────
type JobStatus = "pending" | "audio" | "uploading" | "generating" | "correcting" | "translating" | "verifying" | "done" | "error" | "cancelled";
interface SrtJob {
  status: JobStatus;
  message: string;
  srt?: string;
  originalSrt?: string;
  error?: string;
  filename: string;
  originalFilename?: string;
  createdAt: number;
  translateTo?: string;
  cancelled?: boolean;
  durationSecs?: number;
}
const jobs = new Map<string, SrtJob>();

// Clean up jobs older than 30 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

// Disk storage for uploaded files
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = join(DOWNLOAD_DIR, "srt-uploads");
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = file.originalname.split(".").pop() ?? "bin";
    cb(null, `${randomUUID()}.${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

function pickFirst(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function audioMimeType(ext: string): string {
  const map: Record<string, string> = {
    m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm",
    ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg",
    flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
    mkv: "video/x-matroska", avi: "video/x-msvideo", mov: "video/quicktime",
  };
  return map[ext.toLowerCase()] ?? "audio/mpeg";
}

function isAiConfigured(): boolean {
  return !!(
    (process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY) ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY
  );
}

// 15-minute timeout — long audio files can take many minutes for Gemini to process
const GEMINI_TIMEOUT_MS = 15 * 60 * 1000;

function getGenAI(): GoogleGenAI | null {
  const directKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (directKey) {
    return new GoogleGenAI({ apiKey: directKey, httpOptions: { timeout: GEMINI_TIMEOUT_MS } });
  }
  return null;
}

// Returns all configured personal API key clients in order.
// Reads GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, GEMINI_API_KEY_4.
function getAllPersonalGenAIClients(): GoogleGenAI[] {
  const keyEnvs = [
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
  ];
  return keyEnvs
    .filter((k): k is string => !!k)
    .map((apiKey) => new GoogleGenAI({ apiKey, httpOptions: { timeout: GEMINI_TIMEOUT_MS } }));
}

function getReplitGenAI(): GoogleGenAI | null {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (baseUrl && apiKey) {
    return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl, timeout: GEMINI_TIMEOUT_MS } });
  }
  return null;
}

// Passes 1 & 2 (audio-dependent): use personal keys only with key rotation.
// Tries each configured key in order with gemini-2.5-flash.
// Rotates to the next key on 429 rate limit. Throws if all keys are exhausted.
// Models tried in order — gemini-2.5-flash is primary (as specified).
// The remaining models are used only when ALL keys are rate-limited on the current model.
const KEY_ROTATION_MODELS = [
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-1.5-flash",
  "gemini-3.1-flash-lite-preview",
];

async function generateWithKeyRotation(
  requestFactory: (model: string) => any,
  label: string,
): Promise<string> {
  const clients = getAllPersonalGenAIClients();
  if (clients.length === 0) {
    throw new Error("No Gemini API key configured — add GEMINI_API_KEY");
  }

  let lastErr: unknown;

  // Outer loop: model. Inner loop: key.
  // All 4 keys are tried for each model before falling to the next model.
  for (const model of KEY_ROTATION_MODELS) {
    let allQuotaForModel = true;

    for (let i = 0; i < clients.length; i++) {
      const keyLabel = `key ${i + 1}`;
      try {
        const result = await clients[i].models.generateContent(requestFactory(model));
        logger.info({ model, keyLabel, label }, `${label} completed via personal ${keyLabel}`);
        return result.text?.trim() ?? "";
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err ?? "");
        const isQuota = /resource_exhausted|quota|429|rate.?limit/i.test(msg);
        if (isQuota) {
          logger.warn({ model, keyLabel, label }, `${label} ${keyLabel} rate limited on ${model} — trying next`);
        } else {
          // Non-quota error (e.g. network, invalid request) — stop immediately
          allQuotaForModel = false;
          logger.warn({ err, model, keyLabel, label }, `${label} ${keyLabel} failed (non-quota error)`);
          throw err;
        }
      }
    }

    if (allQuotaForModel) {
      logger.warn({ model, label }, `${label} all keys rate limited on ${model} — trying next model`);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed on all keys and all models`);
}

// Passes 3 & 4 (text-only): try Replit integration first, fall back to personal key rotation.
async function generateWithReplitFirst(
  replitModel: string,
  requestFactory: (model: string) => any,
  label: string,
): Promise<string> {
  const replitClient = getReplitGenAI();

  if (replitClient) {
    try {
      const result = await replitClient.models.generateContent(requestFactory(replitModel));
      logger.info({ model: replitModel, label }, `${label} completed via Replit integration`);
      return result.text?.trim() ?? "";
    } catch (err) {
      logger.warn(
        { err, model: replitModel, label },
        `${label} Replit failed — falling back to personal key rotation`,
      );
    }
  }

  return generateWithKeyRotation(requestFactory, label);
}

function buildSrtPrompt(language: string, durationSrt: string): string {
  const langNote =
    language === "auto"
      ? "The audio may be in any language — transcribe it in the original language spoken, do NOT translate."
      : `The audio is in ${language}. Transcribe it in ${language} exactly as spoken — do NOT translate.`;

  return `You are a professional subtitle creator. Listen to the ENTIRE audio from start to finish and produce a complete, accurate SRT subtitle file.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. You MUST transcribe ALL speech from 00:00:00 all the way to ${durationSrt}. Do NOT stop early. Even if there are quiet sections or pauses, continue listening — more speech follows.

CRITICAL TIMESTAMP FORMAT:
- Every timestamp MUST use HH:MM:SS,mmm format with ALL THREE parts separated by colons
- CORRECT: 00:01:23,456  (hours:minutes:seconds,milliseconds)
- WRONG:   01:23,456     (missing hours — NEVER use this format)
- WRONG:   1:23,456      (missing hours — NEVER use this format)
- The hours part is ALWAYS required, even when it is 00
- Use COMMA for milliseconds separator (not dot)
- All timestamps MUST be within 00:00:00,000 to ${durationSrt},000

STRICT SRT FORMAT RULES:
1. Each entry has exactly 3 parts, followed by a blank line:
   (a) A sequential number (1, 2, 3 ...)
   (b) A timestamp line: HH:MM:SS,mmm --> HH:MM:SS,mmm
   (c) The spoken text — MAXIMUM 6 WORDS per entry (1 line only)
2. WORD LIMIT IS MANDATORY: Each subtitle entry must contain NO MORE THAN 6 words. This is the most important rule.
   - If 10 words are spoken in a stretch, split them into 2 entries of ~5 words each with proportional timestamps.
   - If 15 words are spoken, split into 3 entries of 5 words each.
   - Never pack more than 6 words into one entry under any circumstances.
3. Each subtitle entry should cover 1-4 seconds of audio (shorter entries = better readability)
4. Transcribe EVERY word spoken — do not skip, skip sections, or summarize anything
5. If there is a quiet section or pause, keep listening — do not stop — transcribe what comes after
6. For unclear words, make your best guess based on context and language
7. Do NOT translate — keep the original spoken language
8. Do NOT write non-speech annotations like [music], [background noise], [silence], [applause], [inaudible] etc. — only transcribe actual spoken words
9. Return ONLY the SRT content — no explanations, no markdown fences, no extra text

Example of CORRECT format — notice each entry has at most 6 words:
1
00:00:01,000 --> 00:00:02,500
Welcome to today's session.

2
00:00:02,500 --> 00:00:04,200
We will discuss several topics.

3
00:00:04,200 --> 00:00:05,800
Starting with the basics first.

4
00:01:04,600 --> 00:01:06,200
Speech that starts at one

5
00:01:06,200 --> 00:01:08,000
minute four seconds exactly here.

Now transcribe the ENTIRE audio from beginning to end:`;
}

function buildCorrectionPrompt(rawSrt: string, language: string, durationSrt: string): string {
  const langNote =
    language === "auto"
      ? "The audio and subtitles are in their original language — do NOT translate anything."
      : `The audio and subtitles are in ${language} — do NOT translate anything.`;

  return `You are an expert subtitle proofreader and corrector. I will give you an audio recording and a draft SRT subtitle file that was auto-generated from it.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. All timestamps MUST be within 00:00:00,000 to ${durationSrt},000. If you see any timestamp beyond ${durationSrt}, it is a hallucination — fix it.

CRITICAL TIMESTAMP FORMAT:
- Every timestamp MUST use HH:MM:SS,mmm format with ALL THREE parts (hours:minutes:seconds,milliseconds)
- CORRECT: 00:01:23,456  — WRONG: 01:23,456 (missing hours) — WRONG: 1:23,456 (missing hours)
- The hours part is ALWAYS required, even when it is 00

IMPORTANT: The draft SRT may be INCOMPLETE — it may only cover part of the audio. Listen to the ENTIRE audio from start to ${durationSrt} and ADD any speech that is missing from the draft. Do not stop at the last entry of the draft if there is more speech in the audio.

Your task: Listen to the ENTIRE audio, fix ALL errors in the SRT, and add any missing speech.

Common errors to fix:
- Wrong words (mishearings, similar-sounding words mixed up)
- Missing words or phrases that are clearly spoken but not in the SRT
- Hallucinated words (text in the SRT that is NOT actually spoken in the audio)
- Wrong word forms (e.g., wrong verb endings, missing particles/suffixes)
- Timestamp mismatches (subtitle appearing too early or too late)
- Timestamps using wrong format (MM:SS,mmm instead of HH:MM:SS,mmm — fix these)
- Timestamps that go BEYOND the audio duration
- MISSING ENTRIES: speech that occurs after the last SRT entry — add them
- Duplicate entries: two entries with nearly identical text for the same moment — keep only one
- OVERFULL ENTRIES: any entry with more than 6 words MUST be split into shorter entries with proportional timestamps

WORD LIMIT RULE (MANDATORY):
- Each subtitle entry must contain NO MORE THAN 6 words
- If an existing entry has 10 words, split it into 2 entries of ~5 words with proportional timestamps
- If an existing entry has 12 words, split it into 2–3 entries of 4–6 words each
- This applies to every single entry — check them all

IMPORTANT RULES:
- Keep the exact same SRT format (number, timestamp, text, blank line)
- Re-number entries sequentially from 1 after adding/splitting entries
- Do NOT add translation or explanations
- Return ONLY the corrected and completed SRT content — no explanations, no markdown fences

Here is the draft SRT to correct and complete:
---
${rawSrt}
---

Now listen to the full audio from 00:00:00 to ${durationSrt} and return the fully corrected and completed SRT:`;
}

function buildTranslationPrompt(correctedSrt: string, fromLanguage: string, toLanguage: string): string {
  const fromNote = fromLanguage === "auto" ? "its original language" : fromLanguage;
  return `You are a professional subtitle translator. I will give you an SRT subtitle file written in ${fromNote}. Translate the subtitle text into ${toLanguage}.

CRITICAL RULES:
1. Keep EVERY timestamp line EXACTLY as-is — do NOT change any HH:MM:SS,mmm timestamps
2. Keep EVERY entry number EXACTLY as-is — the number of entries in your output MUST equal the number of entries in the input
3. Keep the exact same SRT structure (number, timestamp, translated text, blank line)
4. Translate ONLY the subtitle text lines — nothing else
5. Produce natural, fluent ${toLanguage} — not a word-for-word literal translation
6. Preserve the meaning, tone, and context of the original speech
7. Keep names of people, places, and proper nouns as they are (or use the standard ${toLanguage} spelling)
8. Each subtitle must fit on 1-2 lines, max ~42 characters per line — split long translations naturally at phrase boundaries
9. Return ONLY the translated SRT — no explanations, no markdown fences, no extra text
10. DO NOT add or remove entries — the output entry count must match the input exactly

Here is the SRT to translate:
---
${correctedSrt}
---

Now return the fully translated SRT in ${toLanguage}:`;
}

function buildTranslationVerifyPrompt(originalSrt: string, translatedSrt: string, fromLanguage: string, toLanguage: string): string {
  const fromNote = fromLanguage === "auto" ? "the original language" : fromLanguage;
  return `You are an expert bilingual subtitle proofreader. I will give you two SRT files: the ORIGINAL (in ${fromNote}) and a TRANSLATED version (in ${toLanguage}). Your task is to verify the translation and fix any errors.

Check every entry for:
- Mistranslations (wrong meaning)
- Missing content (original says something that is absent in the translation)
- Added content (translation says something not in the original)
- Unnatural or awkward ${toLanguage} phrasing
- Names/proper nouns that were incorrectly changed
- Timestamp or entry number changes (they must be identical to the original)
- Line length: each subtitle line must be max ~42 characters — split longer lines at phrase boundaries

RULES:
- Keep ALL timestamps exactly as they appear in the original SRT — do NOT change them
- Keep ALL entry numbers exactly as they appear in the original SRT
- The number of entries in your output MUST be exactly the same as the input
- Fix ONLY the translation text — nothing else
- Return ONLY the corrected translated SRT — no explanations, no markdown fences

ORIGINAL SRT (${fromNote}):
---
${originalSrt}
---

TRANSLATED SRT (${toLanguage}) to verify and fix:
---
${translatedSrt}
---

Return the fully verified and corrected ${toLanguage} SRT:`;
}

// ── Normalize SRT timestamps ─────────────────────────────────────────────────
// Fixes two classes of Gemini timestamp mistakes:
//   1. Missing hours: "01:23,456" → "00:01:23,456"  (MM:SS,mmm → HH:MM:SS,mmm)
//   2. Single-digit parts: "00:1:2,700" → "00:01:02,700"
//   3. Seconds/minutes >= 60: carry-over into the next unit
function normalizeTs(ts: string): string {
  const [timePart, ms = "000"] = ts.split(",");
  const parts = timePart.split(":");
  let hRaw: string, mRaw: string, sRaw: string;
  if (parts.length === 3) {
    [hRaw, mRaw, sRaw] = parts;
  } else if (parts.length === 2) {
    hRaw = "00";
    [mRaw, sRaw] = parts;
  } else {
    hRaw = "00"; mRaw = "00"; sRaw = parts[0];
  }
  // Carry-over: seconds >= 60 → minutes, minutes >= 60 → hours
  let hh = parseInt(hRaw, 10) || 0;
  let mm = parseInt(mRaw, 10) || 0;
  let ss = parseInt(sRaw, 10) || 0;
  const msNum = parseInt(ms, 10) || 0;
  mm += Math.floor(ss / 60); ss = ss % 60;
  hh += Math.floor(mm / 60); mm = mm % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(msNum).padStart(3, "0")}`;
}

function normalizeSrtTimestamps(srt: string): string {
  // Replace every timestamp line: "START --> END"
  return srt.replace(
    /^([\d:,]+)\s*-->\s*([\d:,]+)$/gm,
    (_m, start, end) => `${normalizeTs(start.trim())} --> ${normalizeTs(end.trim())}`,
  );
}

// ── Parse SRT timestamp to milliseconds ──────────────────────────────────────
function tsToMs(ts: string): number {
  const m = ts.match(/(\d+):(\d+):(\d+),(\d+)/);
  if (!m) return -1;
  return (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])) * 1000 + parseInt(m[4]);
}

// ── Strip hallucinated / garbage entries ──────────────────────────────────────
function cleanupHallucinatedEntries(srt: string): string {
  const entries = srt.trim().split(/\n\n+/);
  const valid: string[] = [];
  let prevText = "";
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) continue;
    // Must start with a number
    if (!/^\d+$/.test(lines[0].trim())) continue;

    const tsLine = lines[1].trim();
    const text = lines.slice(2).join(" ").trim();
    const words = text.split(/\s+/).filter(Boolean);
    const unique = new Set(words);

    // 1. Word-repetition hallucination (>80% same word)
    if (words.length > 10 && unique.size <= 2) continue;

    // 2. Empty or whitespace-only text
    if (!text) continue;

    // 3. Punctuation-only entries (e.g. "...", "—", ".", "-")
    if (/^[\s.…\-—–·,!?।]+$/.test(text)) continue;

    // 4. Consecutive identical text (duplicate entries)
    if (text === prevText) continue;

    // 5. Impossibly short duration (< 200ms) — almost always an artifact
    const tsParts = tsLine.match(/^(.+?)\s*-->\s*(.+)$/);
    if (tsParts) {
      const startMs = tsToMs(tsParts[1].trim());
      const endMs = tsToMs(tsParts[2].trim());
      if (startMs >= 0 && endMs >= 0 && endMs - startMs < 200) continue;
    }

    prevText = text;
    valid.push(entry.trim());
  }
  // Re-number the valid entries sequentially
  return valid
    .map((entry, i) => {
      const lines = entry.split("\n");
      lines[0] = String(i + 1);
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}

// ── Split overfull subtitle entries (> 6 words) ───────────────────────────────
// Acts as a hard safety net after Gemini output — even if the model ignores the
// word-limit instruction, every entry is guaranteed to have ≤ 6 words.
function splitOverfullEntries(srt: string, maxWords = 6): string {
  const entries = srt.trim().split(/\n\n+/);
  const result: string[] = [];

  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) { result.push(entry.trim()); continue; }

    const tsLine = lines[1].trim();
    const text = lines.slice(2).join(" ").trim();
    const words = text.split(/\s+/).filter(Boolean);

    if (words.length <= maxWords) {
      result.push(entry.trim());
      continue;
    }

    // Parse start/end timestamps in ms
    const tsParts = tsLine.match(/^(.+?)\s*-->\s*(.+)$/);
    if (!tsParts) { result.push(entry.trim()); continue; }

    const startMs = tsToMs(tsParts[1].trim());
    const endMs = tsToMs(tsParts[2].trim());
    if (startMs < 0 || endMs <= startMs) { result.push(entry.trim()); continue; }

    const totalMs = endMs - startMs;
    const totalWords = words.length;
    const chunkCount = Math.ceil(totalWords / maxWords);

    for (let i = 0; i < chunkCount; i++) {
      const chunkWords = words.slice(i * maxWords, (i + 1) * maxWords);
      const chunkStart = startMs + Math.round((i / chunkCount) * totalMs);
      const chunkEnd   = startMs + Math.round(((i + 1) / chunkCount) * totalMs);

      const fmtMs = (ms: number) => {
        const hh = Math.floor(ms / 3600000);
        const mm = Math.floor((ms % 3600000) / 60000);
        const ss = Math.floor((ms % 60000) / 1000);
        const msRem = ms % 1000;
        return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")},${String(msRem).padStart(3,"0")}`;
      };

      result.push(`0\n${fmtMs(chunkStart)} --> ${fmtMs(chunkEnd)}\n${chunkWords.join(" ")}`);
    }
  }

  // Re-number all entries sequentially
  return result
    .map((entry, i) => {
      const lines = entry.split("\n");
      lines[0] = String(i + 1);
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}

// ── Restore timestamps from original SRT into translated SRT ─────────────────
// Gemini sometimes reformats timestamps during translation. Since timestamps
// must NEVER change during translation, we overwrite every timestamp in the
// translated SRT with the corresponding timestamp from the original, matched
// by entry number. If entry counts differ, we log a warning and do a best-effort.
function restoreTimestamps(originalSrt: string, translatedSrt: string): string {
  const parseEntries = (srt: string) => {
    return srt.trim().split(/\n\n+/).map((block) => {
      const lines = block.trim().split("\n");
      if (lines.length < 3) return null;
      const num = parseInt(lines[0].trim(), 10);
      if (isNaN(num)) return null;
      return { num, timestamp: lines[1].trim(), text: lines.slice(2).join("\n") };
    }).filter((e): e is { num: number; timestamp: string; text: string } => e !== null);
  };

  const origEntries = parseEntries(originalSrt);
  const transEntries = parseEntries(translatedSrt);

  if (origEntries.length !== transEntries.length) {
    logger.warn(
      { origCount: origEntries.length, transCount: transEntries.length },
      "Entry count mismatch between original and translated SRT — timestamps may be misaligned"
    );
  }

  const timestampMap = new Map<number, string>();
  for (const e of origEntries) timestampMap.set(e.num, e.timestamp);

  const restored = transEntries.map((e) => {
    const ts = timestampMap.get(e.num) ?? e.timestamp;
    return `${e.num}\n${ts}\n${e.text}`;
  });

  return restored.join("\n\n") + "\n";
}

// ── Filter entries beyond audio duration ─────────────────────────────────────
function filterOutOfBoundsEntries(srt: string, durationSecs: number): string {
  if (durationSecs <= 0) return srt;
  const entries = srt.trim().split(/\n\n+/);
  const valid: string[] = [];
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) continue;
    const tsMatch = lines[1].match(/^(\d{2}):(\d{2}):(\d{2}),\d{3}\s*-->/);
    if (!tsMatch) { valid.push(entry.trim()); continue; }
    const entrySecs = parseInt(tsMatch[1], 10) * 3600 + parseInt(tsMatch[2], 10) * 60 + parseInt(tsMatch[3], 10);
    if (entrySecs <= durationSecs + 5) valid.push(entry.trim()); // 5s tolerance
  }
  return valid.map((entry, i) => {
    const lines = entry.split("\n");
    lines[0] = String(i + 1);
    return lines.join("\n");
  }).join("\n\n") + "\n";
}

// ── Basic SRT validity check ──────────────────────────────────────────────────
// Checks first AND last entry so truncated output (maxOutputTokens hit) is caught.
function validateSrt(srt: string): boolean {
  const entries = srt.trim().split(/\n\n+/).filter(Boolean);
  if (entries.length === 0) return false;

  // Check first entry structure
  const firstLines = entries[0].trim().split("\n");
  if (firstLines.length < 3) return false;
  if (!/^\d+$/.test(firstLines[0].trim())) return false;
  if (!/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(firstLines[1])) return false;

  // Check last entry is also complete — guards against Gemini token-limit truncation
  if (entries.length > 1) {
    const lastLines = entries[entries.length - 1].trim().split("\n");
    if (lastLines.length < 3) {
      logger.warn("Last SRT entry appears truncated — likely hit token limit");
      return false;
    }
  }

  return true;
}

// ── Strip markdown code fences from AI output ────────────────────────────────
function stripFences(text: string): string {
  let s = text.trim();
  // Normalize Windows line endings so all downstream splits work correctly
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Remove opening fence with optional language tag (e.g. ```srt or ```text)
  s = s.replace(/^```(?:[a-z]*)[ \t]*\n/i, "");
  // Remove closing fence
  s = s.replace(/\n```[ \t]*$/i, "");
  return s.trim();
}

// ── Preprocess audio with ffmpeg (16kHz mono WAV) ────────────────────────────
function preprocessAudio(inputPath: string): Promise<{ path: string; cleanup: () => void }> {
  const outputPath = inputPath + "_16k.wav";
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-y", "-i", inputPath,
      "-ac", "1",           // mono
      "-ar", "16000",       // 16 kHz
      "-c:a", "pcm_s16le",  // 16-bit PCM
      outputPath,
    ]);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ path: outputPath, cleanup: () => { try { rmSync(outputPath); } catch {} } });
      } else {
        // Fallback: use original if ffmpeg fails
        resolve({ path: inputPath, cleanup: () => {} });
      }
    });
    proc.on("error", () => resolve({ path: inputPath, cleanup: () => {} }));
  });
}

// ── Get audio duration via ffprobe ───────────────────────────────────────────
function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      const secs = parseFloat(out.trim());
      resolve(isNaN(secs) ? 0 : secs);
    });
    proc.on("error", () => resolve(0));
  });
}

/** Convert seconds → HH:MM:SS for use in prompts */
function secondsToSrtTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Core processing function ─────────────────────────────────────────────────
async function processAudio(
  jobId: string,
  audioPath: string,
  language: string,
  filename: string,
  translateTo?: string,
  cleanup?: () => void,
) {
  const job = jobs.get(jobId);
  if (!job) return;

  const clients = getAllPersonalGenAIClients();
  if (clients.length === 0) {
    job.status = "error";
    job.error = "Gemini API key not configured";
    return;
  }

  let preprocessCleanup: (() => void) | null = null;

  try {
    // Preprocess audio to 16kHz mono WAV for smaller upload and better accuracy
    const preprocessed = await preprocessAudio(audioPath);
    preprocessCleanup = preprocessed.cleanup;
    const processedPath = preprocessed.path;

    const ext = processedPath.split(".").pop()!.toLowerCase();
    const mimeType = audioMimeType(ext);
    const audioBuffer = readFileSync(processedPath);
    const audioBlob = new Blob([audioBuffer], { type: mimeType });

    // Measure exact audio duration so we can tell Gemini to stay within bounds
    const durationSecs = await getAudioDuration(processedPath);
    const durationSrt = durationSecs > 0 ? secondsToSrtTime(durationSecs) : "99:59:59";
    job.durationSecs = durationSecs;
    logger.info({ durationSecs, durationSrt }, "Audio duration measured");

    if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }

    // ── Key-rotation loop for Passes 1 & 2 (audio-dependent) ─────────────────
    // A fileUri is tied to the API key/project that uploaded it — a different key
    // gets 403 on the same URI. So each key attempt uploads its own copy, runs both
    // passes, then deletes the file. On quota (429) we move to the next key.
    let correctedFinalSrt: string | null = null;
    let lastKeyErr: unknown;

    for (let ki = 0; ki < clients.length; ki++) {
      const client = clients[ki];
      const keyLabel = `key ${ki + 1}`;
      let geminiFileName: string | null = null;

      try {
        // Upload with this key's client
        job.status = "uploading";
        job.message = ki === 0 ? "Uploading audio to AI..." : `Uploading audio to AI (${keyLabel})...`;

        const uploadResult = await client.files.upload({
          file: audioBlob,
          config: { mimeType, displayName: filename },
        });
        geminiFileName = uploadResult.name!;

        // Poll until ACTIVE (up to 3 min)
        let fileInfo: any = uploadResult;
        let attempts = 0;
        while (fileInfo.state === "PROCESSING" && attempts < 90) {
          await new Promise((r) => setTimeout(r, 2000));
          if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
          fileInfo = await client.files.get({ name: geminiFileName });
          attempts++;
        }
        if (fileInfo.state !== "ACTIVE") throw new Error("Audio processing timed out — please try again");

        const fileUri: string = fileInfo.uri;

        // Pass 1: Transcription — try each model in turn on this key
        if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
        job.status = "generating";
        job.message = "AI is transcribing audio...";

        let rawSrt = "";
        let lastPass1Err: unknown;
        for (const model of KEY_ROTATION_MODELS) {
          try {
            const result = await client.models.generateContent({
              model,
              contents: [{ role: "user", parts: [{ fileData: { mimeType, fileUri } }, { text: buildSrtPrompt(language, durationSrt) }] }],
              config: { temperature: 0.1, maxOutputTokens: 65536 },
            });
            rawSrt = result.text?.trim() ?? "";
            logger.info({ model, keyLabel }, "Initial subtitle transcription completed");
            break;
          } catch (err) {
            lastPass1Err = err;
            const msg = err instanceof Error ? err.message : String(err ?? "");
            if (!/resource_exhausted|quota|429|rate.?limit/i.test(msg)) throw err;
            logger.warn({ model, keyLabel }, `Transcription rate limited on ${model} — trying next model`);
          }
        }
        if (!rawSrt) throw lastPass1Err instanceof Error ? lastPass1Err : new Error("All models rate limited on transcription");

        const cleanedRaw = stripFences(rawSrt);

        // Pass 2: Correction — same fileUri (same key), try each model in turn
        if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
        job.status = "correcting";
        job.message = "AI is auto-correcting errors...";

        let correctedSrt = "";
        for (const model of KEY_ROTATION_MODELS) {
          try {
            const result = await client.models.generateContent({
              model,
              contents: [{ role: "user", parts: [{ fileData: { mimeType, fileUri } }, { text: buildCorrectionPrompt(cleanedRaw, language, durationSrt) }] }],
              config: { temperature: 0.1, maxOutputTokens: 65536 },
            });
            correctedSrt = result.text?.trim() ?? "";
            logger.info({ model, keyLabel }, "Subtitle correction completed");
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err ?? "");
            if (!/resource_exhausted|quota|429|rate.?limit/i.test(msg)) {
              logger.warn({ err, model, keyLabel }, "Correction failed (non-quota) — using Pass 1 output");
              break;
            }
            logger.warn({ model, keyLabel }, `Correction rate limited on ${model} — trying next model`);
          }
        }

        const rawFinal = (correctedSrt && correctedSrt.length > 10) ? stripFences(correctedSrt) : cleanedRaw;
        correctedFinalSrt = splitOverfullEntries(
          filterOutOfBoundsEntries(cleanupHallucinatedEntries(normalizeSrtTimestamps(rawFinal)), durationSecs),
        );

        break; // Both passes succeeded — exit key loop

      } catch (err) {
        lastKeyErr = err;
        const msg = err instanceof Error ? err.message : String(err ?? "");
        const isQuota = /resource_exhausted|quota|429|rate.?limit/i.test(msg);
        if (isQuota && ki < clients.length - 1) {
          logger.warn({ keyLabel }, `${keyLabel} quota exhausted — trying next key`);
        } else if (!isQuota) {
          throw err;
        }
      } finally {
        if (geminiFileName) {
          try { await client.files.delete({ name: geminiFileName }); } catch {}
        }
      }
    }

    if (!correctedFinalSrt) {
      job.status = "error";
      job.error = lastKeyErr instanceof Error ? lastKeyErr.message : "All API keys exhausted — try again later";
      return;
    }

    // Validate the SRT before proceeding
    if (!validateSrt(correctedFinalSrt)) {
      job.status = "error";
      job.error = "AI returned an invalid subtitle file — please try again";
      return;
    }

    // Step 4 (optional): Translate the corrected SRT
    if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
    if (translateTo && translateTo !== "none") {
      job.originalSrt = correctedFinalSrt;
      job.originalFilename = filename.replace(/\.srt$/i, "-original.srt");
      job.status = "translating";
      job.message = `Translating subtitles to ${translateTo}...`;

      const translatedRaw = await generateWithReplitFirst(
        "gemini-3.1-pro-preview",
        (model) => ({
          model,
          contents: [
            {
              role: "user",
              parts: [{ text: buildTranslationPrompt(correctedFinalSrt, language, translateTo) }],
            },
          ],
          config: {
            temperature: 0.2,
            maxOutputTokens: 65536,
          },
        }),
        "Subtitle translation pass",
      );
      const translatedClean = translatedRaw.length > 10
        ? stripFences(translatedRaw)
        : correctedFinalSrt;
      // Always restore original timestamps — Gemini sometimes garbles them during translation
      const translatedSrt = restoreTimestamps(correctedFinalSrt, translatedClean);

      // Step 5: Verify the translation (text-only, no audio needed)
      if (job.cancelled) { job.status = "cancelled"; job.message = "Cancelled"; return; }
      job.status = "verifying";
      job.message = `Verifying ${translateTo} translation...`;

      const verifiedRaw = await generateWithReplitFirst(
        "gemini-3.1-pro-preview",
        (model) => ({
          model,
          contents: [
            {
              role: "user",
              parts: [{ text: buildTranslationVerifyPrompt(correctedFinalSrt, translatedSrt, language, translateTo) }],
            },
          ],
          config: {
            temperature: 0.1,
            maxOutputTokens: 65536,
          },
        }),
        "Subtitle verification pass",
      );
      const verifiedClean = verifiedRaw.length > 10
        ? stripFences(verifiedRaw)
        : translatedSrt;
      // Restore timestamps again after verification pass (same Gemini behaviour)
      const verifiedSrt = restoreTimestamps(correctedFinalSrt, verifiedClean);

      const finalSrt = splitOverfullEntries(cleanupHallucinatedEntries(normalizeSrtTimestamps(verifiedSrt)));
      if (!validateSrt(finalSrt)) {
        job.status = "error";
        job.error = "AI returned an invalid translated subtitle file — please try again";
        return;
      }
      job.status = "done";
      job.message = "Subtitles ready!";
      job.srt = finalSrt;
    } else {
      job.status = "done";
      job.message = "Subtitles ready!";
      job.srt = correctedFinalSrt;
    }
  } catch (err: any) {
    logger.error({ err }, "SRT generation error");
    if (job.status !== "cancelled") {
      job.status = "error";
      job.error = err.message || "Failed to generate subtitles";
    }
  } finally {
    if (preprocessCleanup) {
      try { preprocessCleanup(); } catch {}
    }
    if (cleanup) {
      try { cleanup(); } catch {}
    }
  }
}

// ── Route: Generate from YouTube URL ────────────────────────────────────────
router.post("/subtitles/generate", async (req: Request, res: Response) => {
  const { url, language = "auto", translateTo } = req.body as { url: string; language?: string; translateTo?: string };

  if (!url?.trim()) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  if (!isAiConfigured()) {
    res.status(503).json({ error: "AI not configured — add GEMINI_API_KEY" });
    return;
  }

  const jobId = randomUUID();
  const audioDir = join(DOWNLOAD_DIR, `srt-yt-${jobId}`);
  const translateLang = translateTo && translateTo !== "none" ? translateTo : undefined;

  jobs.set(jobId, {
    status: "audio",
    message: "Downloading audio from YouTube...",
    filename: "subtitles.srt",
    createdAt: Date.now(),
    translateTo: translateLang,
  });

  res.json({ jobId });

  // Process in background
  (async () => {
    const job = jobs.get(jobId)!;
    try {
      mkdirSync(audioDir, { recursive: true });
      // Use video title in filename so the downloaded SRT has a meaningful name
      const audioPattern = join(audioDir, "%(title)s.%(ext)s");
      await runYtDlpAudio([
        "-f", "bestaudio/best",
        "--no-playlist", "--no-warnings",
        "-o", audioPattern, url.trim(),
      ], job);

      // Bail out if cancelled during download
      if (job.cancelled) {
        job.status = "cancelled";
        job.message = "Cancelled";
        return;
      }

      const audioFiles = existsSync(audioDir) ? readdirSync(audioDir) : [];
      const audioFile = audioFiles
        .map((f) => join(audioDir, f))
        .find((f) => /\.(m4a|mp4|webm|ogg|opus|mp3|flac|wav|aac)$/i.test(f));

      if (!audioFile) {
        job.status = "error";
        job.error = "Could not download audio — check the URL and try again";
        return;
      }

      // Use the actual video title for the SRT filename
      const rawFilename = audioFile.split("/").pop() ?? "";
      const videoTitle = rawFilename.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*]/g, "-").trim() || "subtitles";
      job.filename = `${videoTitle}.srt`;

      await processAudio(jobId, audioFile, language, job.filename, translateLang, () => {
        try { rmSync(audioDir, { recursive: true }); } catch {}
      });
    } catch (err: any) {
      logger.error({ err }, "SRT YouTube download error");
      if (job.status !== "cancelled") {
        job.status = "error";
        job.error = err.message || "Failed to download audio";
      }
      try { rmSync(audioDir, { recursive: true }); } catch {}
    }
  })();
});

// ── Route: Generate from uploaded file ──────────────────────────────────────
router.post(
  "/subtitles/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!isAiConfigured()) {
      try { rmSync(req.file.path); } catch {}
      res.status(503).json({ error: "AI not configured — add GEMINI_API_KEY" });
      return;
    }

    const language: string = (req.body as any).language ?? "auto";
    const translateTo: string | undefined = (req.body as any).translateTo;
    const translateLang = translateTo && translateTo !== "none" ? translateTo : undefined;
    const baseName = req.file.originalname.replace(/\.[^.]+$/, "");
    const srtFilename = `${baseName}.srt`;
    const jobId = randomUUID();

    jobs.set(jobId, {
      status: "uploading",
      message: "Uploading to AI...",
      filename: srtFilename,
      createdAt: Date.now(),
      translateTo: translateLang,
    });

    res.json({ jobId });

    // Process in background — delete the temp file after use
    (async () => {
      await processAudio(jobId, req.file!.path, language, srtFilename, translateLang, () => {
        try { rmSync(req.file!.path); } catch {}
      });
    })();
  },
);

// ── Multer error handler (must have 4 params to be treated as error middleware) ─
router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: "File is too large — maximum upload size is 500 MB" });
    return;
  }
  next(err);
});

// ── Route: Cancel a running job ───────────────────────────────────────────────
router.post("/subtitles/cancel/:jobId", (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
    res.json({ ok: true, alreadyFinished: true });
    return;
  }
  job.cancelled = true;
  job.status = "cancelled";
  job.message = "Cancelled by user";
  res.json({ ok: true });
});

// ── Route: Poll job status ────────────────────────────────────────────────────
router.get("/subtitles/status/:jobId", (req: Request, res: Response) => {
  const jobId = pickFirst(req.params.jobId);
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status === "done") {
    res.json({
      status: job.status,
      message: job.message,
      filename: job.filename,
      srt: job.srt,
      originalSrt: job.originalSrt ?? null,
      originalFilename: job.originalFilename ?? null,
      durationSecs: job.durationSecs ?? null,
    });
  } else if (job.status === "error") {
    res.json({ status: job.status, error: job.error, durationSecs: job.durationSecs ?? null });
  } else {
    res.json({
      status: job.status,
      message: job.message,
      durationSecs: job.durationSecs ?? null,
    });
  }
});

export default router;

