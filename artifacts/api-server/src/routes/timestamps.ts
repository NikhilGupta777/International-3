/**
 * Timestamps route — YouTube chapter timestamp generation with Gemini 2.5 Pro.
 *
 * Deployment modes:
 *  - Local / ECS (persistent server): analysis runs inline with EventEmitter-based SSE.
 *  - AWS Lambda (serverless): transcript fetch runs in the API handler, then a Lambda
 *    worker is invoked for the Gemini call; SSE streams by polling DynamoDB.
 *
 * Routes:
 *  POST /api/youtube/timestamps          — start analysis, returns { jobId }
 *  GET  /api/youtube/timestamps/stream/:jobId — SSE progress stream
 *  GET  /api/youtube/timestamps/status/:jobId — polling fallback
 */

import { Router, type Request, type Response } from "express";
import { setupSse } from "../lib/sse";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  unlinkSync, rmdirSync, statSync, createReadStream, writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { GoogleGenAI } from "@google/genai";
import {
  DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { logger } from "../lib/logger";
import { readTextFromS3 } from "../lib/s3-storage";

const router = Router();

// ── AWS / environment config ──────────────────────────────────────────────────
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const JOB_TABLE = process.env.YOUTUBE_QUEUE_JOB_TABLE ?? process.env.JOB_TABLE ?? "";
const WORKER_FUNCTION_NAME =
  process.env.TIMESTAMPS_WORKER_FUNCTION_NAME ??
  process.env.AWS_LAMBDA_FUNCTION_NAME ??
  "";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/tmp/ytgrabber";
const _workspaceRoot = process.env.REPL_HOME ?? process.cwd();
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";

const ddb = JOB_TABLE ? new DynamoDBClient({ region: REGION }) : null;
const lambdaClient = WORKER_FUNCTION_NAME ? new LambdaClient({ region: REGION }) : null;

// ── yt-dlp environment (mirrors youtube.ts / subtitles.ts) ───────────────────
function buildPythonEnv(root: string): NodeJS.ProcessEnv {
  const bin = join(root, ".pythonlibs", "bin");
  const lib = join(root, ".pythonlibs", "lib");
  if (!existsSync(bin)) return { ...process.env };
  let site = join(lib, "python3.11", "site-packages");
  try {
    const py = readdirSync(lib).find((e) => /^python3\.\d+$/.test(e));
    if (py) site = join(lib, py, "site-packages");
  } catch {}
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONPATH: site,
  };
}

const PYTHON_ENV = buildPythonEnv(_workspaceRoot);
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
const YTDLP_BIN =
  process.env.YTDLP_BIN ??
  (process.platform === "win32"
    ? ""
    : ["/usr/local/bin/yt-dlp", "/opt/bin/yt-dlp", "/var/task/bin/yt-dlp"].find(existsSync) ?? "");
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const YTDLP_COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE || join(_workspaceRoot, ".yt-cookies.txt");
const YTDLP_COOKIES_S3_KEY = process.env.YTDLP_COOKIES_S3_KEY ?? "";

// ── Cookie loading ────────────────────────────────────────────────────────────
let _cookiesLoaded = false;
let _cookiesLoading: Promise<void> | null = null;

type BrowserCookie = {
  domain?: unknown; path?: unknown; secure?: unknown; session?: unknown;
  expirationDate?: unknown; name?: unknown; value?: unknown; hostOnly?: unknown;
};

function cookiesToNetscape(list: BrowserCookie[]): string | null {
  const lines: string[] = [];
  for (const c of list) {
    const domain = typeof c.domain === "string" ? c.domain.trim() : "";
    const name = typeof c.name === "string" ? c.name.trim() : "";
    const value = typeof c.value === "string" ? c.value : "";
    if (!domain || !name) continue;
    const dl = domain.toLowerCase();
    if (!dl.includes("youtube") && !dl.includes("google") && !dl.includes("yt")) continue;
    const include = c.hostOnly === false ? "TRUE" : "FALSE";
    const secure = c.secure === true ? "TRUE" : "FALSE";
    const exp = typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : 0;
    lines.push(`${domain}\t${include}\t${c.path ?? "/"}\t${secure}\t${exp}\t${name}\t${value}`);
  }
  return lines.length ? `# Netscape HTTP Cookie File\n\n${lines.join("\n")}\n` : null;
}

function decodeCookiesFromStorage(raw: string): string | null {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) return null;

  let decoded = trimmedRaw;
  try {
    decoded = Buffer.from(trimmedRaw, "base64").toString("utf8").trim();
  } catch {
    decoded = trimmedRaw;
  }

  if (!decoded) return null;
  if (
    decoded.startsWith("# Netscape HTTP Cookie File") ||
    decoded.startsWith(".youtube.com") ||
    decoded.includes("\t")
  ) {
    return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
  }

  try {
    if (decoded.startsWith("{")) {
      const parsed = JSON.parse(decoded) as { cookies?: BrowserCookie[] };
      return Array.isArray(parsed.cookies) ? cookiesToNetscape(parsed.cookies) : null;
    }
    if (decoded.startsWith("[")) {
      const parsed = JSON.parse(decoded) as BrowserCookie[];
      return Array.isArray(parsed) ? cookiesToNetscape(parsed) : null;
    }
  } catch {
    return null;
  }

  return null;
}

async function ensureCookiesLoaded(): Promise<void> {
  if (_cookiesLoaded) return;
  if (_cookiesLoading) return _cookiesLoading;
  _cookiesLoading = (async () => {
    try {
      if (!YTDLP_COOKIES_S3_KEY) return;
      const netscape = decodeCookiesFromStorage(await readTextFromS3(YTDLP_COOKIES_S3_KEY));
      if (!netscape) return;
      const cookieDir = dirname(YTDLP_COOKIES_FILE);
      if (!existsSync(cookieDir)) mkdirSync(cookieDir, { recursive: true });
      writeFileSync(YTDLP_COOKIES_FILE, netscape, "utf8");
      logger.info("[timestamps] Cookies loaded from S3");
    } catch (err) {
      logger.warn({ err }, "[timestamps] Cookie load failed — continuing without cookies");
    } finally {
      _cookiesLoaded = true;
    }
  })();
  return _cookiesLoading;
}

function getCookieArgs(): string[] {
  if (!YTDLP_COOKIES_FILE || !existsSync(YTDLP_COOKIES_FILE)) return [];
  try {
    const st = statSync(YTDLP_COOKIES_FILE);
    if (!st.isFile() || st.size < 24) return [];
    const hdr = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
    if (!hdr.startsWith("# Netscape HTTP Cookie File") && !hdr.startsWith(".youtube.com")) return [];
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch { return []; }
}

// ── Base yt-dlp args ──────────────────────────────────────────────────────────
const BASE_YTDLP_ARGS = [
  "--retries", "3", "--extractor-retries", "3", "--socket-timeout", "30",
  "--js-runtimes", "node", "--js-runtimes", "bun",
  "--remote-components", "ejs:github",
  "--add-headers",
  ["Accept-Language:en-US,en;q=0.9", "Referer:https://www.youtube.com/", "Origin:https://www.youtube.com"].join(";"),
  "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ...(YTDLP_PROXY ? ["--proxy", YTDLP_PROXY] : []),
];

// ── yt-dlp runners ────────────────────────────────────────────────────────────
function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(host);
  } catch {
    return false;
  }
}

function isYouTubeBlockedError(message: string): boolean {
  return /confirm.*not a bot|sign in to confirm|sign.*in.*required|http error 429|too many requests|rate.?limit|forbidden|http error 403|access.*denied|bot.*detect|unable to extract|nsig.*extraction|player.*response|no video formats|precondition.*failed|http error 401|requested format is not available|format.*not available/i.test(message);
}

function getFriendlyYtError(message: string): string {
  if (/video unavailable|this video is unavailable|removed by|has been removed/i.test(message)) {
    return "This video is unavailable or has been removed.";
  }
  if (/not made this video available|not available in your country|geo.?restrict/i.test(message)) {
    return "This video is geo-restricted and cannot be accessed from this server.";
  }
  if (isYouTubeBlockedError(message)) {
    return "YouTube blocked server access even after cookie/client fallback. Try again or use a different video.";
  }
  return "Could not load video info. Check the URL and try again.";
}

function getDefaultYoutubeArgs(hasCookies: boolean): string[] {
  return hasCookies
    ? ["--extractor-args", "youtube:player_client=web,web_embedded,tv_embedded"]
    : ["--extractor-args", "youtube:player_client=tv_embedded,android_vr,mweb,-android_sdkless"];
}

function getYoutubeFallbacks(hasCookies: boolean): string[][] {
  return hasCookies
    ? [
        ["--extractor-args", "youtube:player_client=web"],
        ["--extractor-args", "youtube:player_client=web_embedded,mweb"],
        ["--extractor-args", "youtube:player_client=tv_embedded,android_vr"],
        ["--extractor-args", "youtube:player_client=tv_embedded"],
        ["--extractor-args", "youtube:player_client=android_vr"],
        ["--extractor-args", "youtube:player_client=mweb"],
        ["--extractor-args", "youtube:player_client=ios"],
      ]
    : [
        ["--extractor-args", "youtube:player_client=tv_embedded,android_vr"],
        ["--extractor-args", "youtube:player_client=tv_embedded"],
        ["--extractor-args", "youtube:player_client=android_vr"],
        ["--extractor-args", "youtube:player_client=mweb"],
        ["--extractor-args", "youtube:player_client=ios"],
      ];
}

function runYtDlpOnce(extraArgs: string[], args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const cmd = YTDLP_BIN || PYTHON_BIN;
    const cmdArgs = YTDLP_BIN
      ? [...BASE_YTDLP_ARGS, ...extraArgs, ...args]
      : ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...extraArgs, ...args];
    const proc = spawn(cmd, cmdArgs, { env: PYTHON_ENV });
    let out = ""; let err = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err.slice(-2000) || `yt-dlp exited ${code}`)));
    proc.on("error", reject);
  });
}

async function runYtDlp(args: string[]): Promise<string> {
  await ensureCookiesLoaded();
  const maybeUrl = [...args].reverse().find((arg) => /^https?:\/\//i.test(arg));
  const isYt = !!(maybeUrl && isYouTubeUrl(maybeUrl));
  const cookieArgs = getCookieArgs();
  const hasCookies = cookieArgs.length > 0;
  const baseClientArgs = isYt ? getDefaultYoutubeArgs(hasCookies) : [];
  const attempts: string[][] = hasCookies
    ? [[...cookieArgs, ...baseClientArgs], baseClientArgs]
    : [baseClientArgs];

  if (isYt) {
    for (const fallback of getYoutubeFallbacks(hasCookies)) {
      if (hasCookies) attempts.push([...cookieArgs, ...fallback]);
      attempts.push(fallback);
    }
  }

  const attempted = new Set<string>();
  let lastErr: Error | null = null;
  for (const extra of attempts) {
    const key = extra.join("\u0001");
    if (attempted.has(key)) continue;
    attempted.add(key);
    try {
      return await runYtDlpOnce(extra, args);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error("yt-dlp failed");
      if (!isYt || !isYouTubeBlockedError(lastErr.message)) throw lastErr;
    }
  }
  throw lastErr ?? new Error("yt-dlp failed");
}

async function runYtDlpMetadata(url: string): Promise<any> {
  const raw = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
  return JSON.parse(raw);
}

function runYtDlpForSubs(args: string[]): Promise<void> {
  return runYtDlp(args).then(() => undefined);
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? httpsGet : httpGet;
    let data = "";
    const req = get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject); return;
      }
      res.on("data", (c: Buffer) => { data += c.toString(); });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Subtitle fetch timed out")); });
  });
}

function pickBestSubtitleUrl(
  subtitles: Record<string, any[]>,
  autoCaptions: Record<string, any[]>,
  videoLang?: string,
): string | null {
  const findVtt = (tracks: any[]): string | null => {
    if (!Array.isArray(tracks)) return null;
    const vtt = tracks.find((t: any) => t.ext === "vtt") ??
      tracks.find((t: any) => typeof t.url === "string" && t.url.includes("fmt=vtt"));
    return vtt?.url ?? null;
  };
  const preferred = [
    ...(videoLang ? [videoLang] : []),
    "hi", "hi-IN", "hi-Latn", "hi-orig", "en", "en-US", "en-GB", "en-orig",
  ];
  for (const lang of preferred) { if (subtitles[lang]?.length) { const u = findVtt(subtitles[lang]); if (u) return u; } }
  for (const t of Object.values(subtitles)) { if (t?.length) { const u = findVtt(t); if (u) return u; } }
  for (const lang of preferred) { if (autoCaptions[lang]?.length) { const u = findVtt(autoCaptions[lang]); if (u) return u; } }
  for (const t of Object.values(autoCaptions)) { if (t?.length) { const u = findVtt(t); if (u) return u; } }
  return null;
}

// ── VTT parsing ───────────────────────────────────────────────────────────────
interface VttCue { startSec: number; endSec: number; text: string; }

function vttTimeToSec(t: string): number {
  const p = t.split(":");
  if (p.length === 3) return parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2]);
  return parseFloat(p[0]) * 60 + parseFloat(p[1]);
}

function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [startStr, endStr] = tl.split("-->").map((s) => s.trim().split(" ")[0]);
    const text = lines
      .filter((l) => !l.includes("-->") && !l.match(/^\d+$/) && l.trim())
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean).join(" ");
    if (text) cues.push({ startSec: vttTimeToSec(startStr), endSec: vttTimeToSec(endStr), text });
  }
  return cues;
}

function cuesToText(cues: VttCue[]): string {
  return cues.map((c) => {
    const mm = Math.floor(c.startSec / 60);
    const ss = Math.floor(c.startSec % 60);
    return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${c.text}`;
  }).join("\n");
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sampleTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const lines = transcript.split("\n").filter(Boolean);
  const target = Math.floor(maxChars / 85);
  if (lines.length <= target) return transcript.slice(0, maxChars);
  const step = lines.length / target;
  const sampled: string[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.floor(i * step);
    if (lines[idx]) sampled.push(lines[idx]);
  }
  return `[Note: transcript sampled evenly from ${lines.length} lines for full-video coverage]\n${sampled.join("\n")}`;
}

// ── AssemblyAI helpers ────────────────────────────────────────────────────────
type AssemblyAiWord = { start: number; end: number; text: string; confidence: number };

async function assemblyAiUpload(audioPath: string): Promise<string> {
  const { request } = await import("https");
  return new Promise((resolve, reject) => {
    const size = statSync(audioPath).size;
    const req = request(
      { hostname: "api.assemblyai.com", path: "/v2/upload", method: "POST",
        headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/octet-stream", "content-length": size } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString(); });
        res.on("end", () => {
          try {
            const j = JSON.parse(body) as { upload_url?: string; error?: string };
            if (j.upload_url) resolve(j.upload_url);
            else reject(new Error(j.error ?? `AssemblyAI upload failed (HTTP ${res.statusCode})`));
          } catch { reject(new Error("AssemblyAI upload: bad JSON")); }
        });
      });
    req.on("error", reject);
    createReadStream(audioPath).pipe(req);
  });
}

async function assemblyAiCreateTranscript(uploadUrl: string): Promise<string> {
  const { request } = await import("https");
  const payload = JSON.stringify({ audio_url: uploadUrl, language_detection: true, punctuate: true, format_text: true });
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "api.assemblyai.com", path: "/v2/transcript", method: "POST",
        headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString(); });
        res.on("end", () => {
          try {
            const j = JSON.parse(body) as { id?: string; error?: string };
            if (j.id) resolve(j.id);
            else reject(new Error(j.error ?? `AssemblyAI create failed (HTTP ${res.statusCode})`));
          } catch { reject(new Error("AssemblyAI create: bad JSON")); }
        });
      });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function assemblyAiPoll(transcriptId: string): Promise<AssemblyAiWord[]> {
  const { request } = await import("https");
  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const result = await new Promise<any>((resolve, reject) => {
      const req = request(
        { hostname: "api.assemblyai.com", path: `/v2/transcript/${transcriptId}`, method: "GET",
          headers: { authorization: ASSEMBLYAI_API_KEY } },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => { body += c.toString(); });
          res.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("AssemblyAI poll: bad JSON")); } });
        });
      req.on("error", reject);
      req.end();
    });
    if (result.status === "completed") {
      if (!Array.isArray(result.words) || result.words.length === 0)
        throw new Error("AssemblyAI: no speech detected");
      return result.words as AssemblyAiWord[];
    }
    if (result.status === "error") throw new Error(result.error ?? "AssemblyAI transcription failed");
  }
  throw new Error("AssemblyAI transcription timed out after 30 minutes");
}

function assemblyAiWordsToText(words: AssemblyAiWord[]): string {
  if (!words.length) return "";
  const MAX_WORDS = 12;
  const MAX_MS = 8000;
  const lines: string[] = [];
  let i = 0;
  while (i < words.length) {
    const startMs = words[i].start;
    const mm = Math.floor(startMs / 60000);
    const ss = Math.floor((startMs % 60000) / 1000);
    const group: string[] = [];
    while (i < words.length && group.length < MAX_WORDS && words[i].start - startMs < MAX_MS) {
      group.push(words[i].text); i++;
    }
    lines.push(`[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${group.join(" ")}`);
  }
  return lines.join("\n");
}

async function downloadAudio(url: string, outputPath: string): Promise<void> {
  await runYtDlp([
    "-x", "--audio-format", "mp3", "--audio-quality", "5",
    "--no-playlist", "--no-warnings", "-o", outputPath, url,
  ]).then(() => undefined);
}

// ── Gemini timestamp generation ───────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a Bhagwat Katha timestamp expert. You deeply understand spiritual discourses (pravachan), bhajans, mantra chanting, and devotional content in Hindi, Odia, Sanskrit, and English.

Your task: analyze the transcript and produce DETAILED, topic-level timestamps — one per distinct topic, story, bhajan, or mantra segment.

OUTPUT FORMAT: Return ONLY a valid JSON array. Each object must have:
  { "startSec": number, "endSec": number, "label": string }

CRITICAL RULES:
1. First entry MUST be startSec: 0.
2. COVERAGE: capture EVERY distinct topic, scripture, story, prophecy, bhajan, mantra, and segment — however many there are. A 2h video with 30 topic shifts gets 30 entries. Do NOT merge unrelated topics. Do NOT impose any maximum or minimum count — let the content dictate.
3. Each "endSec" = the startSec of the NEXT entry (last entry endSec = video duration in seconds).
4. Write labels in the SAME language as the video (Hindi for Hindi, Odia for Odia, etc.).
5. Bhajans/songs: "भजन — [first line or name of the song]"
6. Mantra chanting / aarti: "मंत्रोच्चारण / आरती"
7. Labels must be SPECIFIC and DESCRIPTIVE (10-60 chars). No generic "Part 1", "Introduction", "Conclusion".
8. Capture every distinct topic shift — scripture citation, prophecy, moral story, devotee anecdote, philosophical point, etc.
9. Return ONLY the JSON array — no explanation, no markdown fences.

REFERENCE EXAMPLE A — L4 Katha (~2 hr 7 min): "L4- कल्कि भगवान के साथ भेंट करने का मार्ग"
[{"startSec":0,"endSec":230,"label":"परिचय और आरंभिक मंत्रोच्चारण"},
{"startSec":230,"endSec":452,"label":"पंचसखाओं ने चारों युगों में जन्म लेकर कार्य किए और मालिका 600 साल पहले लिखी"},
{"startSec":452,"endSec":514,"label":"भविष्य मालिका में गोपी, तापी, कपी का कलयुग से सतयुग में प्रवेश"},
{"startSec":514,"endSec":605,"label":"चारों युगों के भक्त ही कल्कि भगवान को पहचानेंगे, अन्य कोई नहीं"},
{"startSec":605,"endSec":683,"label":"कल्कि भगवान भक्त को सपने में या मालिका द्वारा जन्म का संदेश देंगे"},
{"startSec":683,"endSec":1352,"label":"12000 भक्तों को लेकर भगवान कल्कि धर्म संस्थापना का कार्य करेंगे"},
{"startSec":1352,"endSec":1649,"label":"कलयुग अंत में शासक लोग जनता को लूटेंगे, सुखा पड़ेगा तब कल्कि अवतार"},
{"startSec":1649,"endSec":1854,"label":"रामायण में कलयुग अंत के संकेत — तुलसीदास, गरुण और काग भूशंडी संवाद"},
{"startSec":1854,"endSec":1944,"label":"कोष दल भक्त पहले आएंगे, बाद वालों की रक्षा भगवान के नाम से"},
{"startSec":1944,"endSec":2711,"label":"सुधर्मा सभा जाजपुर में जब बैठेगा, ब्रह्मा विष्णु महेश वहां आएंगे"},
{"startSec":2711,"endSec":2940,"label":"एक भक्त द्वारा देखा गया मां काली का स्वरूप"},
{"startSec":2940,"endSec":3060,"label":"माता योग माया रोग रूप में मनुष्य के शरीर में प्रवेश करेंगी"},
{"startSec":3060,"endSec":3217,"label":"कोलकाता शहर में भविष्य में कैसा विनाश होगा"},
{"startSec":3217,"endSec":3322,"label":"13 मुस्लिम देश कौन से हैं जो भारत पर आक्रमण करेंगे"},
{"startSec":3322,"endSec":3348,"label":"भारत के पक्ष में कौन से देश — अमेरिका विश्वासघात करेगा"},
{"startSec":3584,"endSec":3654,"label":"उड़ीसा में कल्कि भगवान 14 लाख म्लेच्छ सैनिकों का सुदर्शन चक्र से संहार"},
{"startSec":4044,"endSec":4096,"label":"कलि कौन है?"},
{"startSec":4901,"endSec":4943,"label":"भगवान कल्कि मानव शरीर में आएंगे"},
{"startSec":6494,"endSec":6560,"label":"माता काल भैरवी का आवास कब होगा?"},
{"startSec":6968,"endSec":7027,"label":"गुप्त संबल ग्राम कहां है?"}]

REFERENCE EXAMPLE B — Pune Sabha Day 4 (~2 hr): "PUNE SABHA DAY 4"
[{"startSec":0,"endSec":828,"label":"आरंभ और मंत्रोच्चारण"},
{"startSec":828,"endSec":1012,"label":"तप, दया और दान का अर्थ"},
{"startSec":1012,"endSec":1350,"label":"धन की कमी — अमीर गरीब सब एक समान हो जायेंगे"},
{"startSec":1350,"endSec":1685,"label":"भजन — गोविंद राधे माधव, गोपाल राधे माधव"},
{"startSec":1885,"endSec":1969,"label":"सनातनी कौन है?"},
{"startSec":1969,"endSec":2276,"label":"मत्स्य अवतार"},
{"startSec":2276,"endSec":2663,"label":"कच्छप अवतार"},
{"startSec":2663,"endSec":3244,"label":"भजन — मेरा छोड़ दे दुपट्टा नन्दलाल सवेरे दही लेके आयूंगी"},
{"startSec":3262,"endSec":3415,"label":"वराह अवतार"},
{"startSec":3415,"endSec":3674,"label":"दशावतार से अष्टादश पुराण का फल"},
{"startSec":4074,"endSec":4375,"label":"माधव नाम का अर्थ और महत्व"},
{"startSec":4433,"endSec":4682,"label":"माधव नाम से भूकंप और बाढ़ आदि से सुरक्षा"},
{"startSec":4768,"endSec":4834,"label":"माधव नाम से मिसाइल और बीमारियों से सुरक्षा"},
{"startSec":4841,"endSec":4978,"label":"नरसिंह अवतार"},
{"startSec":4990,"endSec":5265,"label":"वामन अवतार"},
{"startSec":5303,"endSec":6265,"label":"भजन — सांवली सूरत पे मोहन दिल दीवाना हो गया"},
{"startSec":6040,"endSec":6164,"label":"परशुराम अवतार"},
{"startSec":6353,"endSec":6604,"label":"भगवान कल्कि की परशुराम जी को गुरु दक्षिणा और हर युग में अस्त्र प्रदान"},
{"startSec":6608,"endSec":6910,"label":"राम अवतार"}]`;


async function callGemini(videoTitle: string, videoDuration: number, transcript: string, instructions?: string): Promise<string> {
  const userContent = `VIDEO TITLE: ${videoTitle}
VIDEO DURATION: ${formatTime(videoDuration)}
${instructions ? `\nCUSTOM INSTRUCTIONS: ${instructions}\n` : ""}
TRANSCRIPT:
${transcript}

Generate topic-level timestamps — one entry for EVERY distinct topic, bhajan, story, scripture, or segment in the video. No count limit. Include endSec for each entry. Return ONLY the JSON array.`;

  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const integrationKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  if (baseUrl && integrationKey) {
    try {
      const client = new GoogleGenAI({ apiKey: integrationKey, httpOptions: { apiVersion: "", baseUrl } });
      const result = await client.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        config: { systemInstruction: SYSTEM_PROMPT },
      });
      return (result as any).text ?? "";
    } catch (err) {
      logger.warn({ err }, "[timestamps] Replit Gemini integration failed, trying own key");
    }
  }

  if (!GEMINI_API_KEY) throw new Error("No Gemini API key configured. Set GEMINI_API_KEY in Secrets.");

  try {
    const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const result = await client.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: userContent }] }],
      config: { systemInstruction: SYSTEM_PROMPT },
    });
    return (result as any).text ?? "";
  } catch (err) {
    logger.warn({ err }, "[timestamps] Gemini 2.5 Pro failed");
    throw new Error("Gemini timestamp generation failed. Check GEMINI_API_KEY and try again.");
  }
}

function parseTimestampsJson(raw: string): TimestampEntry[] | null {
  let cleaned = raw.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
  const tryParse = (s: string) => {
    try {
      const r = JSON.parse(s);
      if (Array.isArray(r)) return r.filter((x) => typeof x.startSec === "number" && typeof x.label === "string");
    } catch {}
    return null;
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const arr = tryParse(cleaned.slice(start, end + 1));
    if (arr) return arr;
  }
  return null;
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────
async function ddbPutJob(jobId: string, status: string, message: string): Promise<void> {
  if (!ddb || !JOB_TABLE) return;
  const now = Date.now();
  await ddb.send(new PutItemCommand({
    TableName: JOB_TABLE,
    Item: {
      jobId: { S: jobId }, jobType: { S: "timestamps" },
      status: { S: status }, message: { S: message },
      createdAt: { N: String(now) }, updatedAt: { N: String(now) },
    },
  }));
}

async function ddbUpdateJob(jobId: string, status: string, message: string, extra?: { resultJson?: string; progressPct?: number }): Promise<void> {
  if (!ddb || !JOB_TABLE) return;
  const names: Record<string, string> = { "#s": "status", "#m": "message", "#u": "updatedAt" };
  const values: Record<string, any> = { ":s": { S: status }, ":m": { S: message }, ":u": { N: String(Date.now()) } };
  const sets = ["#s = :s", "#m = :m", "#u = :u"];
  if (extra?.resultJson) { names["#r"] = "resultJson"; values[":r"] = { S: extra.resultJson }; sets.push("#r = :r"); }
  if (typeof extra?.progressPct === "number") { names["#p"] = "progressPct"; values[":p"] = { N: String(extra.progressPct) }; sets.push("#p = :p"); }
  await ddb.send(new UpdateItemCommand({
    TableName: JOB_TABLE,
    Key: { jobId: { S: jobId } },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function ddbReadJob(jobId: string) {
  if (!ddb || !JOB_TABLE) return null;
  const out = await ddb.send(new GetItemCommand({
    TableName: JOB_TABLE,
    Key: { jobId: { S: jobId } },
    ConsistentRead: true,
  }));
  const item = out.Item;
  if (!item || item.jobType?.S !== "timestamps") return null;
  return {
    status: item.status?.S ?? "pending",
    message: item.message?.S ?? "",
    progressPct: item.progressPct?.N ? Number(item.progressPct.N) : null,
    resultJson: item.resultJson?.S ?? null,
    updatedAt: item.updatedAt?.N ? Number(item.updatedAt.N) : null,
  };
}

// ── Job store (in-memory for inline mode) ─────────────────────────────────────
export interface TimestampEntry { startSec: number; endSec?: number; label: string; }

interface TimestampJob {
  status: "pending" | "running" | "done" | "error";
  mode: "inline" | "lambda";
  timestamps?: TimestampEntry[];
  error?: string;
  videoTitle?: string;
  videoDuration?: number;
  hasTranscript?: boolean;
  transcriptSource?: "youtube" | "assemblyai" | "chapters";
  emitter: EventEmitter;
}

const tsJobs = new Map<string, TimestampJob>();

setInterval(() => {
  if (tsJobs.size > 200) {
    const toDelete = Array.from(tsJobs.keys()).slice(0, tsJobs.size - 100);
    for (const id of toDelete) tsJobs.delete(id);
  }
}, 30 * 60 * 1000);

// ── Transcript fetcher (runs in main API server, NOT in Lambda worker) ────────
async function fetchTranscript(
  url: string,
  meta: any,
  onStep: (msg: string) => void,
): Promise<{ transcript: string; source: "youtube" | "assemblyai" | "chapters" | null }> {
  const subDir = join(DOWNLOAD_DIR, `ts_subs_${randomUUID()}`);
  const audioPath = join(DOWNLOAD_DIR, `ts_audio_${randomUUID()}.mp3`);
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  try {
    // 1. Existing chapter markers — pass as HINTS to Gemini rather than using directly.
    // YouTube auto-chapters are often too coarse (3-5 entries for a 2h katha).
    // We keep them in transcript form so Gemini can use them as anchor points.
    let chapterHints = "";
    if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
      chapterHints = "[EXISTING YOUTUBE CHAPTERS — use as timing hints only, generate more detailed entries]\n"
        + meta.chapters.map((c: any) => `[${formatTime(c.start_time)}] ${c.title}`).join("\n") + "\n\n";
    }

    const videoLang: string | undefined = meta.language ?? meta.original_language ?? undefined;
    const subtitleUrl = pickBestSubtitleUrl(meta.subtitles ?? {}, meta.automatic_captions ?? {}, videoLang);
    // We'll prepend chapterHints to the transcript so Gemini has timing anchors

    // 2. Direct URL from metadata
    if (subtitleUrl) {
      try {
        const raw = await fetchUrl(subtitleUrl);
        if (raw.includes("WEBVTT") || raw.includes("-->")) {
          const cues = parseVtt(raw);
          const deduped: VttCue[] = [];
          for (const cue of cues) {
            if (!deduped.length || deduped[deduped.length - 1].text !== cue.text) deduped.push(cue);
          }
          if (deduped.length > 0) return { transcript: chapterHints + cuesToText(deduped), source: "youtube" };
        }
      } catch (_e) {}
    }

    // 3. yt-dlp subtitle download
    try {
      mkdirSync(subDir, { recursive: true });
      const subBase = join(subDir, "sub");
      await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-lang", "hi.*,en.*", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, url]).catch(() => {});
      if (!readdirSync(subDir).some((f) => f.endsWith(".vtt"))) {
        await runYtDlpForSubs(["--write-subs", "--write-auto-subs", "--sub-format", "vtt", "--skip-download", "--no-warnings", "--no-playlist", "-o", subBase, url]).catch(() => {});
      }
      const files = existsSync(subDir) ? readdirSync(subDir) : [];
      const vttFile = files.map((f) => join(subDir, f)).find((f) => f.endsWith(".vtt"));
      if (vttFile) {
        const vttContent = readFileSync(vttFile, "utf8");
        const cues = parseVtt(vttContent);
        const deduped: VttCue[] = [];
        for (const cue of cues) {
          if (!deduped.length || deduped[deduped.length - 1].text !== cue.text) deduped.push(cue);
        }
        for (const f of files) try { unlinkSync(join(subDir, f)); } catch {}
        try { rmdirSync(subDir); } catch {}
        if (deduped.length > 0) return { transcript: chapterHints + cuesToText(deduped), source: "youtube" };
      }
    } catch (_e) {
      try { if (existsSync(subDir)) { for (const f of readdirSync(subDir)) try { unlinkSync(join(subDir, f)); } catch {} rmdirSync(subDir); } } catch {}
    }

    // 4. AssemblyAI fallback
    if (ASSEMBLYAI_API_KEY) {
      onStep("No YouTube subtitles — downloading audio for AI transcription...");
      try {
        await downloadAudio(url, audioPath);
        onStep("Uploading to AssemblyAI...");
        const uploadUrl = await assemblyAiUpload(audioPath);
        onStep("Transcribing audio (this may take several minutes for long videos)...");
        const transcriptId = await assemblyAiCreateTranscript(uploadUrl);
        const words = await assemblyAiPoll(transcriptId);
        const transcript = chapterHints + assemblyAiWordsToText(words);
        return { transcript, source: "assemblyai" };
      } catch (err) {
        logger.warn({ err }, "[timestamps] AssemblyAI failed");
      } finally {
        try { if (existsSync(audioPath)) unlinkSync(audioPath); } catch {}
      }
    }

    return { transcript: "", source: null };
  } finally {
    try { if (existsSync(audioPath)) unlinkSync(audioPath); } catch {}
  }
}

// ── Main analysis runner (inline mode) ───────────────────────────────────────
const MAX_TRANSCRIPT_CHARS = 120_000;

async function runTimestampAnalysis(
  jobId: string,
  job: TimestampJob,
  url: string,
  instructions?: string,
): Promise<void> {
  const emit = (type: string, data: object) => {
    if (type === "error" && job.emitter.listenerCount("error") === 0) return;
    job.emitter.emit(type, data);
  };
  const step = (name: string, status: "running" | "done" | "warn", message: string, data?: object) =>
    emit("step", { step: name, status, message, ...data });

  job.status = "running";

  try {
    // Step 1: metadata
    step("metadata", "running", "Fetching video info...");
    let meta: any;
    try {
      meta = await runYtDlpMetadata(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = getFriendlyYtError(msg);
      job.status = "error"; job.error = friendly;
      emit("error", { message: friendly });
      return;
    }

    const videoTitle: string = meta.title ?? "";
    const videoDuration: number = meta.duration ?? 0;
    const videoDescription: string = (meta.description ?? "").slice(0, 800);
    job.videoTitle = videoTitle;
    job.videoDuration = videoDuration;

    const titleShort = `"${videoTitle.slice(0, 60)}${videoTitle.length > 60 ? "…" : ""}"`;
    step("metadata", "done", `${titleShort}${videoDuration ? ` · ${formatTime(videoDuration)}` : ""}`, { videoTitle, videoDuration });

    // Step 2: transcript
    step("transcript", "running", "Fetching transcript...");
    let transcript = "";
    let source: "youtube" | "assemblyai" | "chapters" | null = null;

    const transcriptResult = await fetchTranscript(url, meta, (msg) => {
      step("transcript", "running", msg);
    });
    transcript = transcriptResult.transcript;
    source = transcriptResult.source;

    if (source === "chapters") {
      step("transcript", "done", `${(meta.chapters as any[]).length} chapter markers found`, { hasTranscript: true });
    } else if (source === "youtube") {
      const lineCount = transcript.split("\n").filter(Boolean).length;
      step("transcript", "done", `Transcript ready — ${lineCount} lines`, { hasTranscript: true });
    } else if (source === "assemblyai") {
      const wordCount = transcript.split("\n").filter(Boolean).length;
      step("transcript", "done", `AssemblyAI transcript ready — ${wordCount} segments`, { hasTranscript: true });
    } else {
      step("transcript", "warn", "No transcript found — using title and description", { hasTranscript: false });
      transcript = `Title: ${videoTitle}\nDescription: ${videoDescription}`;
    }

    job.hasTranscript = !!source;
    job.transcriptSource = source ?? undefined;

    // Step 3: Gemini
    step("ai", "running", "Generating timestamps with Gemini 2.5 Pro...");
    const sampled = sampleTranscript(transcript, MAX_TRANSCRIPT_CHARS);
    let rawResponse: string;
    try {
      rawResponse = await callGemini(videoTitle, videoDuration, sampled, instructions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI generation failed";
      job.status = "error"; job.error = msg;
      emit("error", { message: msg });
      return;
    }

    const timestamps = parseTimestampsJson(rawResponse);
    if (!timestamps || timestamps.length === 0) {
      const msg = "AI did not return valid timestamps. Please try again.";
      job.status = "error"; job.error = msg;
      emit("error", { message: msg });
      return;
    }

    timestamps.sort((a, b) => a.startSec - b.startSec);
    if (timestamps[0].startSec > 5) timestamps.unshift({ startSec: 0, label: "शुरुआत / Start" });

    step("ai", "done", `${timestamps.length} timestamps generated`);

    job.status = "done";
    job.timestamps = timestamps;
    emit("done", {
      timestamps, videoTitle, videoDuration,
      hasTranscript: job.hasTranscript,
      transcriptSource: source,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    logger.error({ err, jobId }, "[timestamps] Analysis failed");
    job.status = "error"; job.error = msg;
    emit("error", { message: msg });
  }
}

// ── Lambda worker (called from lambda.ts) ─────────────────────────────────────
//
// Two payload shapes are supported:
//   1. { url, instructions? }            — full pipeline (yt-dlp metadata +
//                                          transcript + Gemini). Used by the
//                                          API handler when running on Lambda.
//   2. { videoTitle, videoDuration,
//        transcript, instructions? }     — Gemini-only (legacy). Kept so that
//                                          any in-flight invocations from a
//                                          prior deploy still complete.
//
// Lambda freezes the API container as soon as `res.json` returns to API
// Gateway, which means any work scheduled via `setImmediate` in the API
// handler may never finish. Doing the full pipeline here, in a dedicated
// worker invocation, gives us the full 15-minute Lambda runtime per job.
export type TimestampWorkerEvent = {
  source: "videomaking.timestamps";
  jobId: string;
  url?: string;
  videoTitle?: string;
  videoDuration?: number;
  transcript?: string;
  instructions?: string;
};

async function runTimestampPipelineFromUrl(
  jobId: string,
  url: string,
  instructions?: string,
): Promise<void> {
  // 1. Metadata
  await ddbUpdateJob(jobId, "running", "Fetching video info...", { progressPct: 10 });
  let meta: any;
  try {
    meta = await runYtDlpMetadata(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(getFriendlyYtError(msg));
  }

  const videoTitle: string = meta.title ?? "";
  const videoDuration: number = meta.duration ?? 0;
  const videoDescription: string = (meta.description ?? "").slice(0, 800);

  // 2. Transcript
  await ddbUpdateJob(
    jobId,
    "running",
    `Fetching transcript for "${videoTitle.slice(0, 50)}"...`,
    { progressPct: 30 },
  );
  const { transcript, source } = await fetchTranscript(url, meta, async (msg) => {
    await ddbUpdateJob(jobId, "running", msg, { progressPct: 45 }).catch(() => {});
  });
  const finalTranscript =
    transcript || `Title: ${videoTitle}\nDescription: ${videoDescription}`;

  logger.info({ jobId, source, transcriptChars: finalTranscript.length }, "[timestamps] transcript ready");

  // 3. Gemini
  await ddbUpdateJob(jobId, "running", "Generating timestamps with Gemini 2.5 Pro...", { progressPct: 65 });
  const sampled = sampleTranscript(finalTranscript, MAX_TRANSCRIPT_CHARS);
  const rawResponse = await callGemini(videoTitle, videoDuration, sampled, instructions);

  const timestamps = parseTimestampsJson(rawResponse);
  if (!timestamps || timestamps.length === 0) {
    throw new Error("AI did not return valid timestamps. Please try again.");
  }
  timestamps.sort((a, b) => a.startSec - b.startSec);
  if (timestamps[0].startSec > 5) timestamps.unshift({ startSec: 0, label: "शुरुआत / Start" });

  await ddbUpdateJob(jobId, "done", `${timestamps.length} timestamps generated`, {
    progressPct: 100,
    resultJson: JSON.stringify({ timestamps, videoTitle, videoDuration }),
  });
}

export async function runTimestampWorker(event: TimestampWorkerEvent): Promise<void> {
  const { jobId, url, videoTitle, videoDuration, transcript, instructions } = event;
  try {
    if (url && url.trim()) {
      await runTimestampPipelineFromUrl(jobId, url.trim(), instructions);
      return;
    }

    // Legacy Gemini-only path
    if (typeof transcript !== "string" || typeof videoTitle !== "string") {
      throw new Error("Worker payload missing url or transcript");
    }
    await ddbUpdateJob(jobId, "running", "Generating timestamps with Gemini...", { progressPct: 60 });
    const sampled = sampleTranscript(transcript, MAX_TRANSCRIPT_CHARS);
    const rawResponse = await callGemini(videoTitle, videoDuration ?? 0, sampled, instructions);
    const timestamps = parseTimestampsJson(rawResponse);
    if (!timestamps || timestamps.length === 0)
      throw new Error("AI did not return valid timestamps");
    timestamps.sort((a, b) => a.startSec - b.startSec);
    if (timestamps[0].startSec > 5) timestamps.unshift({ startSec: 0, label: "शुरुआत / Start" });
    await ddbUpdateJob(jobId, "done", `${timestamps.length} timestamps generated`, {
      progressPct: 100,
      resultJson: JSON.stringify({ timestamps, videoTitle, videoDuration: videoDuration ?? 0 }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Timestamp generation failed";
    logger.error({ err, jobId }, "[timestamps] worker failed");
    await ddbUpdateJob(jobId, "error", message.slice(0, 500), { progressPct: 0 }).catch(() => {});
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/youtube/timestamps — start analysis
function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

router.post("/youtube/timestamps", async (req: Request, res: Response) => {
  const { url, instructions } = req.body as { url?: string; instructions?: string };
  if (!url || typeof url !== "string" || !url.trim()) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const jobId = randomUUID();
  const useLambda = !!(lambdaClient && WORKER_FUNCTION_NAME && ddb && JOB_TABLE);

  if (useLambda) {
    // ── Lambda mode: invoke worker Lambda for the full pipeline ──────────────
    //
    // Earlier versions did the yt-dlp metadata + transcript fetch inside a
    // setImmediate before invoking the worker for Gemini. That doesn't work
    // on Lambda — the API container is frozen the moment the response is
    // returned, so the setImmediate code may never finish (jobs got stuck at
    // progressPct 5 forever). We now hand the URL directly to the worker
    // Lambda, which has its own 15-minute runtime.
    try {
      await ddbPutJob(jobId, "running", "Queued for AI analysis...");

      const workerPayload: TimestampWorkerEvent = {
        source: "videomaking.timestamps",
        jobId,
        url: url.trim(),
        instructions: instructions?.trim() || undefined,
      };

      if (lambdaClient && WORKER_FUNCTION_NAME) {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: WORKER_FUNCTION_NAME,
          InvocationType: "Event",
          Payload: Buffer.from(JSON.stringify(workerPayload)),
        }));
        res.json({ jobId, mode: "lambda" });
      } else {
        // Should not happen given useLambda check above, but guard anyway.
        res.json({ jobId, mode: "lambda" });
        setImmediate(() => {
          runTimestampWorker(workerPayload).catch((err) => {
            logger.error({ err, jobId }, "[timestamps] Inline worker fallback failed");
          });
        });
      }
    } catch (err) {
      logger.error({ err, jobId }, "[timestamps] Failed to start Lambda-mode job");
      await ddbUpdateJob(jobId, "error", "Failed to start job").catch(() => {});
      res.status(502).json({ error: "Failed to start job" });
    }
    return;
  }

  // ── Inline mode: run everything in this server process ────────────────────
  const job: TimestampJob = {
    status: "pending",
    mode: "inline",
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(20);
  tsJobs.set(jobId, job);

  runTimestampAnalysis(jobId, job, url.trim(), instructions?.trim() || undefined).catch((err) => {
    logger.error({ err, jobId }, "[timestamps] Unhandled analysis error");
    job.status = "error";
    job.error = "Unexpected server error";
  });

  res.json({ jobId, mode: "inline" });
});

// GET /api/youtube/timestamps/stream/:jobId — SSE stream (both inline and Lambda modes)
router.get("/youtube/timestamps/stream/:jobId", async (req: Request, res: Response) => {
  const jobId = routeParam(req.params.jobId);

  // ── Lambda mode: poll DynamoDB ────────────────────────────────────────────
  if (!tsJobs.has(jobId) && ddb && JOB_TABLE) {
    setupSse(res);

    const send = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if ("flush" in res && typeof (res as any).flush === "function") (res as any).flush();
    };

    let done = false;
    const pollOnce = async (): Promise<boolean> => {
      const job = await ddbReadJob(jobId);
      if (!job) {
        send({ type: "error", message: "Job not found" });
        return true;
      }
      const isTerminal = ["done", "error", "cancelled"].includes(job.status);
      if (isTerminal) {
        if (job.status === "done" && job.resultJson) {
          try {
            const result = JSON.parse(job.resultJson) as { timestamps: TimestampEntry[]; videoTitle: string; videoDuration: number };
            send({ type: "done", ...result, hasTranscript: true });
          } catch {
            send({ type: "error", message: "Failed to parse result" });
          }
        } else {
          send({ type: "error", message: job.message || job.status });
        }
        return true;
      }
      const stepName = job.progressPct && job.progressPct >= 55 ? "ai"
        : job.progressPct && job.progressPct >= 20 ? "transcript"
        : "metadata";
      send({ type: "step", step: stepName, status: "running", message: job.message ?? "Processing...", progressPct: job.progressPct });
      return false;
    };

    void pollOnce().then((finished) => {
      if (finished) { done = true; res.end(); }
    }).catch((err) => {
      req.log?.error({ err }, "[timestamps] DDB poll failed");
      send({ type: "error", message: "Failed to fetch job status" });
      res.end();
    });

    const timer = setInterval(() => {
      if (done) { clearInterval(timer); return; }
      void pollOnce().then((finished) => {
        if (finished) { done = true; clearInterval(timer); res.end(); }
      }).catch((err) => {
        req.log?.error({ err }, "[timestamps] DDB poll error");
        send({ type: "error", message: "Failed to fetch job status" });
        clearInterval(timer);
        res.end();
      });
    }, 2500);

    req.on("close", () => { done = true; clearInterval(timer); });
    return;
  }

  // ── Inline mode: EventEmitter SSE ─────────────────────────────────────────
  const job = tsJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  setupSse(res);

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if ("flush" in res && typeof (res as any).flush === "function") (res as any).flush();
  };

  if (job.status === "done") {
    send({ type: "done", timestamps: job.timestamps, videoTitle: job.videoTitle, videoDuration: job.videoDuration, hasTranscript: job.hasTranscript, transcriptSource: job.transcriptSource });
    res.end(); return;
  }
  if (job.status === "error") {
    send({ type: "error", message: job.error ?? "Analysis failed" });
    res.end(); return;
  }

  const onStep = (data: object) => send({ type: "step", ...data });
  const onDone = (data: object) => { send({ type: "done", ...data }); res.end(); cleanup(); };
  const onError = (data: object) => { send({ type: "error", ...data }); res.end(); cleanup(); };
  const cleanup = () => {
    job.emitter.off("step", onStep);
    job.emitter.off("done", onDone);
    job.emitter.off("error", onError);
  };

  job.emitter.on("step", onStep);
  job.emitter.on("done", onDone);
  job.emitter.on("error", onError);
  req.on("close", cleanup);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    if (job.status === "done" || job.status === "error") { clearInterval(heartbeat); return; }
    res.write(": heartbeat\n\n");
    if ("flush" in res && typeof (res as any).flush === "function") (res as any).flush();
  }, 15000);
  req.on("close", () => clearInterval(heartbeat));
});

// GET /api/youtube/timestamps/status/:jobId — polling fallback
router.get("/youtube/timestamps/status/:jobId", async (req: Request, res: Response) => {
  const jobId = routeParam(req.params.jobId);

  // Try DynamoDB first (Lambda mode)
  if (ddb && JOB_TABLE && !tsJobs.has(jobId)) {
    try {
      const job = await ddbReadJob(jobId);
      if (!job) { res.status(404).json({ error: "Job not found" }); return; }
      let result: { timestamps?: TimestampEntry[]; videoTitle?: string; videoDuration?: number } = {};
      if (job.status === "done" && job.resultJson) {
        try { result = JSON.parse(job.resultJson); } catch {}
      }
      res.json({ status: job.status, message: job.message, progressPct: job.progressPct, ...result, error: job.status === "error" ? job.message : undefined });
      return;
    } catch (err) {
      logger.warn({ err, jobId }, "[timestamps] DDB status read failed");
    }
  }

  // In-memory (inline mode)
  const job = tsJobs.get(jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({
    status: job.status,
    timestamps: job.timestamps,
    videoTitle: job.videoTitle,
    videoDuration: job.videoDuration,
    hasTranscript: job.hasTranscript,
    transcriptSource: job.transcriptSource,
    error: job.error,
  });
});

export default router;
