import { Router, type Request, type Response } from "express";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  unlinkSync, rmdirSync, statSync, createReadStream,
  writeFileSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { GoogleGenAI } from "@google/genai";
import { logger } from "../lib/logger";
import { readTextFromS3 } from "../lib/s3-storage";

const router = Router();

// ── Environment & yt-dlp setup (mirrors youtube.ts / subtitles.ts) ────────────
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/tmp/ytgrabber";
const _workspaceRoot = process.env.REPL_HOME ?? process.cwd();
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ?? "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";

function buildPythonEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const pythonLibsBin = join(workspaceRoot, ".pythonlibs", "bin");
  const pythonLibsLib = join(workspaceRoot, ".pythonlibs", "lib");
  if (!existsSync(pythonLibsBin)) return { ...process.env };
  let sitePackages = join(pythonLibsLib, "python3.11", "site-packages");
  try {
    const entries = readdirSync(pythonLibsLib);
    const pyDir = entries.find((e) => /^python3\.\d+$/.test(e));
    if (pyDir) sitePackages = join(pythonLibsLib, pyDir, "site-packages");
  } catch {}
  return {
    ...process.env,
    PATH: `${pythonLibsBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONPATH: sitePackages,
  };
}

const PYTHON_ENV = buildPythonEnv(_workspaceRoot);
const PYTHON_BIN = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
const YTDLP_BIN =
  process.env.YTDLP_BIN ??
  (process.platform === "win32"
    ? ""
    : ["/usr/local/bin/yt-dlp", "/opt/bin/yt-dlp", "/var/task/bin/yt-dlp"].find(
        (c) => existsSync(c),
      ) ?? "");
const YTDLP_PROXY = process.env.YTDLP_PROXY ?? "";
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || join(_workspaceRoot, ".yt-cookies.txt");
const YTDLP_COOKIES_S3_KEY = process.env.YTDLP_COOKIES_S3_KEY ?? "";

// ── Cookie loading (mirrors youtube.ts) ───────────────────────────────────────
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
    const domainLower = domain.toLowerCase();
    const isYT = domainLower.includes("youtube") || domainLower.includes("google") || domainLower.includes("yt");
    if (!isYT) continue;
    const include = c.hostOnly === false ? "TRUE" : "FALSE";
    const secure = c.secure === true ? "TRUE" : "FALSE";
    const exp = typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : 0;
    lines.push(`${domain}\t${include}\t${c.path ?? "/"}\t${secure}\t${exp}\t${name}\t${value}`);
  }
  if (!lines.length) return null;
  return `# Netscape HTTP Cookie File\n# https://curl.se/docs/http-cookies.html\n\n${lines.join("\n")}\n`;
}

async function ensureCookiesLoaded(): Promise<void> {
  if (_cookiesLoaded) return;
  if (_cookiesLoading) return _cookiesLoading;
  _cookiesLoading = (async () => {
    try {
      if (!YTDLP_COOKIES_S3_KEY) return;
      const raw = await readTextFromS3(YTDLP_COOKIES_S3_KEY);
      if (!raw) return;
      let decoded: string;
      try {
        decoded = Buffer.from(raw.trim(), "base64").toString("utf8");
      } catch {
        decoded = raw.trim();
      }
      let parsed: BrowserCookie[];
      try { parsed = JSON.parse(decoded); } catch { return; }
      if (!Array.isArray(parsed)) return;
      const netscape = cookiesToNetscape(parsed);
      if (!netscape) return;
      writeFileSync(YTDLP_COOKIES_FILE, netscape, "utf8");
      logger.info("[timestamps] Loaded yt-dlp cookies from S3");
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
    const header = readFileSync(YTDLP_COOKIES_FILE, "utf8").slice(0, 256).trimStart();
    if (!header.startsWith("# Netscape HTTP Cookie File") && !header.startsWith(".youtube.com")) return [];
    return ["--cookies", YTDLP_COOKIES_FILE];
  } catch { return []; }
}

// ── Base yt-dlp args ──────────────────────────────────────────────────────────
const BASE_YTDLP_ARGS = [
  "--retries", "3",
  "--extractor-retries", "3",
  "--socket-timeout", "30",
  "--js-runtimes", "node",
  "--js-runtimes", "bun",
  "--remote-components", "ejs:github",
  "--add-headers",
  [
    "Accept-Language:en-US,en;q=0.9",
    "Referer:https://www.youtube.com/",
    "Origin:https://www.youtube.com",
  ].join(";"),
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ...(YTDLP_PROXY ? ["--proxy", YTDLP_PROXY] : []),
];

// ── yt-dlp runner ─────────────────────────────────────────────────────────────
function runYtDlpRaw(extraArgs: string[], args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = YTDLP_BIN || PYTHON_BIN;
    const commandArgs = YTDLP_BIN
      ? [...BASE_YTDLP_ARGS, ...extraArgs, ...args]
      : ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...extraArgs, ...args];
    const proc = spawn(command, commandArgs, { env: PYTHON_ENV });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.slice(-2000) || `yt-dlp exited ${code}`));
    });
    proc.on("error", reject);
  });
}

async function runYtDlp(args: string[]): Promise<string> {
  await ensureCookiesLoaded();
  const cookieArgs = getCookieArgs();
  const hasCookies = cookieArgs.length > 0;
  const clientArgs = hasCookies
    ? ["--extractor-args", "youtube:player_client=web,web_embedded,tv_embedded"]
    : ["--extractor-args", "youtube:player_client=tv_embedded,android_vr,mweb,-android_sdkless"];
  return runYtDlpRaw([...clientArgs, ...cookieArgs], args);
}

async function runYtDlpMetadata(url: string): Promise<any> {
  const raw = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
  return JSON.parse(raw);
}

function runYtDlpForSubs(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    void ensureCookiesLoaded().then(() => {
      const cookieArgs = getCookieArgs();
      const command = YTDLP_BIN || PYTHON_BIN;
      const commandArgs = YTDLP_BIN
        ? [...BASE_YTDLP_ARGS, ...cookieArgs, ...args]
        : ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...cookieArgs, ...args];
      const proc = spawn(command, commandArgs, { env: PYTHON_ENV });
      let stderr = "";
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.slice(-1000) || `yt-dlp subs exited ${code}`));
      });
      proc.on("error", reject);
    });
  });
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? httpsGet : httpGet;
    let data = "";
    const req = get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Subtitle fetch timed out")); });
  });
}

function pickBestSubtitleUrl(
  subtitles: Record<string, any[]>,
  automaticCaptions: Record<string, any[]>,
  videoLanguage?: string,
): string | null {
  const findVttUrl = (tracks: any[]): string | null => {
    if (!Array.isArray(tracks)) return null;
    const vtt = tracks.find((t: any) => t.ext === "vtt") ??
      tracks.find((t: any) => typeof t.url === "string" && t.url.includes("fmt=vtt"));
    return vtt?.url ?? null;
  };
  const preferredLangs = [
    ...(videoLanguage ? [videoLanguage] : []),
    "hi", "hi-IN", "hi-Latn", "hi-orig", "en", "en-US", "en-GB", "en-orig",
  ];
  for (const lang of preferredLangs) {
    if (subtitles[lang]?.length) { const u = findVttUrl(subtitles[lang]); if (u) return u; }
  }
  for (const tracks of Object.values(subtitles)) {
    if (tracks?.length) { const u = findVttUrl(tracks); if (u) return u; }
  }
  for (const lang of preferredLangs) {
    if (automaticCaptions[lang]?.length) { const u = findVttUrl(automaticCaptions[lang]); if (u) return u; }
  }
  for (const tracks of Object.values(automaticCaptions)) {
    if (tracks?.length) { const u = findVttUrl(tracks); if (u) return u; }
  }
  return null;
}

// ── VTT parsing ───────────────────────────────────────────────────────────────
interface VttCue { startSec: number; endSec: number; text: string; }

function vttTimeToSec(t: string): number {
  const parts = t.split(":");
  if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
}

function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim().split(" ")[0]);
    const text = lines
      .filter((l) => !l.includes("-->") && !l.match(/^\d+$/) && l.trim())
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (text) cues.push({ startSec: vttTimeToSec(startStr), endSec: vttTimeToSec(endStr), text });
  }
  return cues;
}

function cuesToText(cues: VttCue[]): string {
  return cues
    .map((c) => {
      const mm = Math.floor(c.startSec / 60);
      const ss = Math.floor(c.startSec % 60);
      return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${c.text}`;
    })
    .join("\n");
}

function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sampleTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const lines = transcript.split("\n").filter(Boolean);
  const targetLineCount = Math.floor(maxChars / 85);
  if (lines.length <= targetLineCount) return transcript.slice(0, maxChars);
  const step = lines.length / targetLineCount;
  const sampled: string[] = [];
  for (let i = 0; i < targetLineCount; i++) {
    const idx = Math.floor(i * step);
    if (lines[idx]) sampled.push(lines[idx]);
  }
  return `[Note: transcript sampled evenly from all ${lines.length} lines for full-video coverage]\n${sampled.join("\n")}`;
}

// ── AssemblyAI helpers ────────────────────────────────────────────────────────
type AssemblyAiWord = { start: number; end: number; text: string; confidence: number };

async function assemblyAiUpload(audioPath: string): Promise<string> {
  const { request } = await import("https");
  return new Promise((resolve, reject) => {
    const size = statSync(audioPath).size;
    const opts = {
      hostname: "api.assemblyai.com", path: "/v2/upload", method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/octet-stream",
        "content-length": size,
      },
    };
    const req = request(opts, (res) => {
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
  const payload = JSON.stringify({
    audio_url: uploadUrl,
    language_detection: true,
    punctuate: true,
    format_text: true,
    word_boost: [],
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.assemblyai.com", path: "/v2/transcript", method: "POST",
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    };
    const req = request(opts, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => { body += c.toString(); });
      res.on("end", () => {
        try {
          const j = JSON.parse(body) as { id?: string; error?: string };
          if (j.id) resolve(j.id);
          else reject(new Error(j.error ?? `AssemblyAI transcript create failed (HTTP ${res.statusCode})`));
        } catch { reject(new Error("AssemblyAI transcript create: bad JSON")); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function assemblyAiPollTranscript(transcriptId: string): Promise<AssemblyAiWord[]> {
  const { request } = await import("https");
  const MAX_POLLS = 360;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const result = await new Promise<any>((resolve, reject) => {
      const opts = {
        hostname: "api.assemblyai.com",
        path: `/v2/transcript/${transcriptId}`,
        method: "GET",
        headers: { authorization: ASSEMBLYAI_API_KEY },
      };
      const req = request(opts, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => { body += c.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error("AssemblyAI poll: bad JSON")); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    if (result.status === "completed") {
      if (!Array.isArray(result.words) || result.words.length === 0)
        throw new Error("AssemblyAI: no speech detected in audio");
      return result.words as AssemblyAiWord[];
    }
    if (result.status === "error") throw new Error(result.error ?? "AssemblyAI transcription failed");
  }
  throw new Error("AssemblyAI transcription timed out");
}

function assemblyAiWordsToTimedText(words: AssemblyAiWord[]): string {
  if (words.length === 0) return "";
  const MAX_WORDS = 12;
  const MAX_MS = 8000;
  const lines: string[] = [];
  let i = 0;
  while (i < words.length) {
    const startMs = words[i].start;
    const mm = Math.floor(startMs / 60000);
    const ss = Math.floor((startMs % 60000) / 1000);
    const group: string[] = [];
    while (i < words.length && group.length < MAX_WORDS && (words[i].start - startMs) < MAX_MS) {
      group.push(words[i].text);
      i++;
    }
    lines.push(`[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${group.join(" ")}`);
  }
  return lines.join("\n");
}

async function downloadAudioForTranscription(url: string, outputPath: string): Promise<void> {
  await ensureCookiesLoaded();
  const cookieArgs = getCookieArgs();
  const hasCookies = cookieArgs.length > 0;
  const clientArgs = hasCookies
    ? ["--extractor-args", "youtube:player_client=web,web_embedded,tv_embedded"]
    : ["--extractor-args", "youtube:player_client=tv_embedded,android_vr,mweb"];

  return new Promise((resolve, reject) => {
    const command = YTDLP_BIN || PYTHON_BIN;
    const extraArgs = [
      ...BASE_YTDLP_ARGS, ...clientArgs, ...cookieArgs,
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "--no-playlist", "--no-warnings",
      "-o", outputPath, url,
    ];
    const commandArgs = YTDLP_BIN ? extraArgs : ["-m", "yt_dlp", ...extraArgs];
    const proc = spawn(command, commandArgs, { env: PYTHON_ENV });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-2000) || `Audio download failed (exit ${code})`));
    });
    proc.on("error", reject);
  });
}

// ── Gemini timestamp generation ───────────────────────────────────────────────
const TIMESTAMP_SYSTEM_PROMPT = `You are an expert YouTube chapter creator specializing in spiritual discourse, Katha, and devotional content videos.

Your job: analyze the provided video transcript and generate meaningful, well-structured YouTube chapter timestamps that help viewers navigate directly to topics they care about.

OUTPUT FORMAT: Return ONLY a valid JSON array. Each element must have:
- "startSec": number (start time in seconds, integer)
- "label": string (concise chapter title, 5-10 words, in the same language as the video)

STRICT RULES:
1. First timestamp MUST be startSec: 0
2. Minimum 1-2 minutes between timestamps (avoid too many granular ones)
3. Label language must match the video content (Hindi for Hindi videos, etc.)
4. Labels must be descriptive — what is the speaker discussing or what is happening
5. Separate distinct topics clearly: main discourse, bhajans/songs, Q&A, prayers/mantras
6. For bhajans (devotional songs), label them as "भजन — [Song name]" or "Bhajan — [Name]"
7. For mantra chanting, label as "मंत्रोच्चारण" or "Mantraucharan"
8. Keep labels concise but meaningful — avoid generic labels like "Part 1", "Topic 1"
9. Cover the entire video from start to end
10. Return ONLY the JSON array, no other text

EXAMPLE 1 — Hindi spiritual discourse (2+ hour video):
Video title: "L4- कल्कि भगवान के साथ भेंट करने का मार्ग"
Output:
[
  {"startSec": 0, "label": "परिचय"},
  {"startSec": 230, "label": "पंचसखाओं का चारों युगों में कार्य और भविष्य मालिका"},
  {"startSec": 452, "label": "भविष्य मालिका में गोपी, तापी, कपी का कलयुग से सतयुग प्रवेश"},
  {"startSec": 514, "label": "चारों युगों के भक्त ही कल्कि भगवान को पहचानेंगे"},
  {"startSec": 605, "label": "कल्कि भगवान सपने में या मालिका द्वारा भक्त को संदेश देंगे"},
  {"startSec": 693, "label": "12000 भक्तों के साथ धर्म संस्थापना"},
  {"startSec": 1352, "label": "कलयुग अंत में शासकों का अत्याचार और कल्कि अवतार"},
  {"startSec": 1649, "label": "रामायण में कलयुग अंत के संकेत — गरुण-काग भूशंडी संवाद"},
  {"startSec": 1854, "label": "कोष दल भक्त और भगवान के नाम की रक्षा"},
  {"startSec": 1944, "label": "सुधर्मा सभा में ब्रह्मा, विष्णु, महेश का आगमन"},
  {"startSec": 2711, "label": "एक भक्त द्वारा देखा गया मां काली का स्वरूप"},
  {"startSec": 2911, "label": "माता योगमाया रोग रूप में"},
  {"startSec": 3060, "label": "कोलकाता में भविष्य का विनाश"},
  {"startSec": 3217, "label": "भारत पर आक्रमण करने वाले 13 मुस्लिम देश"},
  {"startSec": 3322, "label": "युद्ध में भारत के पक्षधर देश — अमेरिका का विश्वासघात"},
  {"startSec": 3584, "label": "उड़ीसा में कल्कि द्वारा 14 लाख सैनिकों का संघार"},
  {"startSec": 4044, "label": "कलि कौन है?"},
  {"startSec": 4901, "label": "भगवान कल्कि मानव शरीर में आएंगे"},
  {"startSec": 6494, "label": "माता काल भैरवी का आवास"},
  {"startSec": 6968, "label": "गुप्त संबल ग्राम की स्थिति"}
]

EXAMPLE 2 — Mixed content (discourse + bhajans, ~2 hour video):
Video title: "Day 2 कोलकाता सभा — भागवत महापुराण और भविष्य मालिका"
Output:
[
  {"startSec": 0, "label": "आरंभ"},
  {"startSec": 606, "label": "मंत्रोच्चारण, निराशाष्टकम और जगन्नाथ अष्टकम"},
  {"startSec": 1347, "label": "सत्संग क्या है और सत्संग की धारा"},
  {"startSec": 1922, "label": "भजन — गोविन्द जय जय गोपाल जय जय"},
  {"startSec": 2145, "label": "नारद महामुनि का धरती पर आगमन — भागवत महापुराण"},
  {"startSec": 3550, "label": "भजन — मन चल रे वृन्दावन धाम"},
  {"startSec": 4094, "label": "हरे राम हरे कृष्ण महामंत्र जप"},
  {"startSec": 4571, "label": "कलियुग का अंत और सतयुग के आगमन का संकेत"},
  {"startSec": 5646, "label": "भजन — माधव माधव"},
  {"startSec": 5914, "label": "गीत गोविन्द और जयघोष"}
]

EXAMPLE 3 — Pathankot Katha Day 1 (Hindi + Bhajans):
Video title: "Day 1 Pathankot Katha — Bhavishya Malika aur Bhagwat Mahapuran"
Output:
[
  {"startSec": 0, "label": "Mantraucharan aur Aarti"},
  {"startSec": 1106, "label": "Bhajan — Govind Bolo Hari Gopal Bolo"},
  {"startSec": 1572, "label": "Manav Jeevan ka Lakshay aur Bhagwat Mahapuran ka Mahatva"},
  {"startSec": 2548, "label": "Hare Ram Hare Krishna Mahamantra"},
  {"startSec": 2567, "label": "Naam Bhajan ka Tatva aur Bhagwat Mahapuran ki Rachna (1)"},
  {"startSec": 3167, "label": "Bhajan — Madhav Madhav aur Kalki Mahamantra"},
  {"startSec": 3690, "label": "Satsang ka Manav Jeevan mein Mahatva"},
  {"startSec": 4270, "label": "Kaliyug ke Logo ka Udhar aur Bhagwat Mahapuran (2)"},
  {"startSec": 4750, "label": "Aarti Kunj Bihari Ki"},
  {"startSec": 5162, "label": "Bhagwat Mahapuran ka Tatva — Bhagwat Katha"},
  {"startSec": 6104, "label": "Geet Govind"}
]

Now analyze the video transcript provided by the user and generate timestamps in the same way.`;

async function callGeminiForTimestamps(videoTitle: string, videoDuration: number, transcript: string, customInstructions?: string): Promise<string> {
  const durationStr = formatTimestamp(videoDuration);
  const userContent = `VIDEO TITLE: ${videoTitle}
VIDEO DURATION: ${durationStr}

${customInstructions ? `CUSTOM INSTRUCTIONS: ${customInstructions}\n\n` : ""}TRANSCRIPT:
${transcript}

Generate YouTube chapter timestamps for this video. Remember: return ONLY the JSON array.`;

  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const integrationKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  if (baseUrl && integrationKey) {
    try {
      const client = new GoogleGenAI({ apiKey: integrationKey, httpOptions: { apiVersion: "", baseUrl } });
      const result = await client.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        config: { systemInstruction: TIMESTAMP_SYSTEM_PROMPT },
      });
      return (result as any).text ?? "";
    } catch (err) {
      logger.warn({ err }, "[timestamps] Replit Gemini integration failed, falling back to own key");
    }
  }

  if (!GEMINI_API_KEY) throw new Error("No Gemini API key configured");

  for (const model of ["gemini-2.5-pro", "gemini-2.0-flash"]) {
    try {
      const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const result = await client.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        config: { systemInstruction: TIMESTAMP_SYSTEM_PROMPT },
      });
      return (result as any).text ?? "";
    } catch (err) {
      logger.warn({ err, model }, "[timestamps] Gemini model failed, trying next");
    }
  }
  throw new Error("All Gemini models failed");
}

function extractTimestampsFromJson(raw: string): TimestampEntry[] | null {
  let cleaned = raw.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
  try {
    const r = JSON.parse(cleaned);
    if (Array.isArray(r)) return r.filter((x) => typeof x.startSec === "number" && typeof x.label === "string");
  } catch {}
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const r = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(r)) return r.filter((x) => typeof x.startSec === "number" && typeof x.label === "string");
    } catch {}
  }
  return null;
}

// ── Job types & store ─────────────────────────────────────────────────────────
export interface TimestampEntry { startSec: number; label: string; }
interface TimestampJob {
  status: "pending" | "running" | "done" | "error";
  timestamps?: TimestampEntry[];
  error?: string;
  message?: string;
  videoTitle?: string;
  videoDuration?: number;
  hasTranscript?: boolean;
  transcriptSource?: "youtube" | "assemblyai" | "chapters";
  emitter: EventEmitter;
}

const tsJobs = new Map<string, TimestampJob>();

// Clean up old jobs every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of tsJobs) {
    if (job.status === "done" || job.status === "error") {
      // We don't track createdAt here, just let GC handle it after the interval
      void id;
      void cutoff;
    }
  }
  if (tsJobs.size > 200) {
    const toDelete = Array.from(tsJobs.keys()).slice(0, tsJobs.size - 100);
    for (const id of toDelete) tsJobs.delete(id);
  }
}, 30 * 60 * 1000);

// ── Main analysis runner ──────────────────────────────────────────────────────
const MAX_TRANSCRIPT_CHARS = 120_000;

async function runTimestampAnalysis(
  jobId: string,
  job: TimestampJob,
  url: string,
  customInstructions?: string,
): Promise<void> {
  const emit = (type: string, data: object) => {
    if (type === "error" && job.emitter.listenerCount("error") === 0) return;
    job.emitter.emit(type, data);
  };
  const step = (name: string, status: "running" | "done" | "warn", message: string, data?: object) =>
    emit("step", { step: name, status, message, ...data });

  job.status = "running";
  const tmpId = randomUUID();
  const subDir = join(DOWNLOAD_DIR, `ts_subs_${tmpId}`);
  const audioPath = join(DOWNLOAD_DIR, `ts_audio_${tmpId}.mp3`);
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  try {
    // ── Step 1: Video metadata ──────────────────────────────────────────────
    step("metadata", "running", "Fetching video info...");
    let meta: any;
    try {
      meta = await runYtDlpMetadata(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = /sign.in|bot|blocked|403/i.test(msg)
        ? "YouTube blocked server access to this video. Try again later."
        : "Could not load video info. Check the URL and try again.";
      job.status = "error"; job.error = friendly;
      emit("error", { message: friendly });
      return;
    }

    const videoDuration: number = meta.duration ?? 0;
    const videoTitle: string = meta.title ?? "";
    const videoDescription: string = (meta.description ?? "").slice(0, 800);
    const videoLang: string | undefined = meta.language ?? meta.original_language ?? undefined;
    const metaSubtitleUrl = pickBestSubtitleUrl(meta.subtitles ?? {}, meta.automatic_captions ?? {}, videoLang);

    job.videoTitle = videoTitle;
    job.videoDuration = videoDuration;

    const titleShort = `"${videoTitle.slice(0, 60)}${videoTitle.length > 60 ? "…" : ""}"`;
    step("metadata", "done", `${titleShort}${videoDuration ? ` · ${formatTimestamp(videoDuration)}` : ""}`, { videoTitle, videoDuration });

    // ── Step 2: Transcript ──────────────────────────────────────────────────
    step("transcript", "running", "Fetching transcript...");
    let transcript = "";
    let transcriptSource: TimestampJob["transcriptSource"] = undefined;

    // 2a. Use chapters if present
    if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
      transcript = meta.chapters
        .map((c: any) => `[${formatTimestamp(c.start_time)}] ${c.title}`)
        .join("\n");
      transcriptSource = "chapters";
      step("transcript", "done", `${meta.chapters.length} chapter markers found`, { hasTranscript: true });
    }

    // 2b. Try direct subtitle URL from metadata
    if (!transcript && metaSubtitleUrl) {
      try {
        const raw = await fetchUrl(metaSubtitleUrl);
        if (raw.includes("WEBVTT") || raw.includes("-->")) {
          const cues = parseVtt(raw);
          const deduped: VttCue[] = [];
          for (const cue of cues) {
            if (!deduped.length || deduped[deduped.length - 1].text !== cue.text) deduped.push(cue);
          }
          if (deduped.length > 0) {
            transcript = cuesToText(deduped);
            transcriptSource = "youtube";
            step("transcript", "done", `Transcript ready — ${deduped.length} lines`, { hasTranscript: true });
          }
        }
      } catch (_e) {}
    }

    // 2c. Try yt-dlp subtitle download
    if (!transcript) {
      try {
        mkdirSync(subDir, { recursive: true });
        const subBase = join(subDir, "sub");
        await runYtDlpForSubs([
          "--write-subs", "--write-auto-subs",
          "--sub-lang", "hi.*,en.*",
          "--sub-format", "vtt",
          "--skip-download", "--no-warnings", "--no-playlist",
          "-o", subBase, url,
        ]).catch(() => {});

        if (!readdirSync(subDir).some((f) => f.endsWith(".vtt"))) {
          await runYtDlpForSubs([
            "--write-subs", "--write-auto-subs",
            "--sub-format", "vtt",
            "--skip-download", "--no-warnings", "--no-playlist",
            "-o", subBase, url,
          ]).catch(() => {});
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
          if (deduped.length > 0) {
            transcript = cuesToText(deduped);
            transcriptSource = "youtube";
            step("transcript", "done", `Transcript ready — ${deduped.length} lines`, { hasTranscript: true });
          }
        }
        for (const f of files) try { unlinkSync(join(subDir, f)); } catch {}
        try { rmdirSync(subDir); } catch {}
      } catch (_e) {
        try {
          if (existsSync(subDir)) {
            for (const f of readdirSync(subDir)) try { unlinkSync(join(subDir, f)); } catch {}
            rmdirSync(subDir);
          }
        } catch {}
      }
    }

    // 2d. AssemblyAI fallback — download audio and transcribe
    if (!transcript && ASSEMBLYAI_API_KEY) {
      step("transcript", "running", "No YouTube subtitles found — downloading audio for AI transcription...");
      try {
        await downloadAudioForTranscription(url, audioPath);
        step("transcript", "running", "Uploading to AssemblyAI for transcription...");
        const uploadUrl = await assemblyAiUpload(audioPath);
        step("transcript", "running", "Transcribing audio (this takes a few minutes for long videos)...");
        const transcriptId = await assemblyAiCreateTranscript(uploadUrl);
        const words = await assemblyAiPollTranscript(transcriptId);
        transcript = assemblyAiWordsToTimedText(words);
        transcriptSource = "assemblyai";
        step("transcript", "done", `AssemblyAI transcript ready — ${words.length} words`, { hasTranscript: true });
      } catch (aaiErr) {
        logger.warn({ err: aaiErr }, "[timestamps] AssemblyAI transcription failed");
        step("transcript", "warn", "Transcription failed — AI will use title and description only", { hasTranscript: false });
        transcript = `Title: ${videoTitle}\nDescription: ${videoDescription}`;
      } finally {
        try { if (existsSync(audioPath)) unlinkSync(audioPath); } catch {}
      }
    }

    // If still no transcript, use title + description
    if (!transcript) {
      step("transcript", "warn", "No transcript available — using title and description", { hasTranscript: false });
      transcript = `Title: ${videoTitle}\nDescription: ${videoDescription}`;
    }

    job.transcriptSource = transcriptSource;
    job.hasTranscript = !!transcriptSource;

    // ── Step 3: AI timestamp generation ────────────────────────────────────
    step("ai", "running", "Generating timestamps with Gemini 2.5 Pro...");
    const sampledTranscript = sampleTranscript(transcript, MAX_TRANSCRIPT_CHARS);
    let rawResponse: string;
    try {
      rawResponse = await callGeminiForTimestamps(videoTitle, videoDuration, sampledTranscript, customInstructions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI generation failed";
      job.status = "error"; job.error = msg;
      emit("error", { message: msg });
      return;
    }

    const timestamps = extractTimestampsFromJson(rawResponse);
    if (!timestamps || timestamps.length === 0) {
      job.status = "error"; job.error = "AI did not return valid timestamps. Please try again.";
      emit("error", { message: job.error });
      return;
    }

    // Ensure sorted and first is 0
    timestamps.sort((a, b) => a.startSec - b.startSec);
    if (timestamps[0].startSec > 5) timestamps.unshift({ startSec: 0, label: "शुरुआत / Start" });

    step("ai", "done", `${timestamps.length} timestamps generated`);

    job.status = "done";
    job.timestamps = timestamps;
    emit("done", {
      timestamps,
      videoTitle,
      videoDuration,
      hasTranscript: job.hasTranscript,
      transcriptSource,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    logger.error({ err, jobId }, "[timestamps] Analysis failed");
    job.status = "error"; job.error = msg;
    emit("error", { message: msg });
  } finally {
    try { if (existsSync(audioPath)) unlinkSync(audioPath); } catch {}
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/youtube/timestamps — start analysis
router.post("/timestamps", (req: Request, res: Response) => {
  const { url, instructions } = req.body as { url?: string; instructions?: string };
  if (!url || typeof url !== "string" || !url.trim()) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const jobId = randomUUID();
  const job: TimestampJob = {
    status: "pending",
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(20);
  tsJobs.set(jobId, job);

  runTimestampAnalysis(jobId, job, url.trim(), instructions?.trim() || undefined).catch((err) => {
    logger.error({ err, jobId }, "[timestamps] Unhandled error in runTimestampAnalysis");
    job.status = "error";
    job.error = "Unexpected server error";
  });

  res.json({ jobId });
});

// GET /api/youtube/timestamps/stream/:jobId — SSE stream
router.get("/timestamps/stream/:jobId", (req: Request, res: Response) => {
  const job = tsJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if ("flush" in res && typeof (res as any).flush === "function") (res as any).flush();
  };

  if (job.status === "done") {
    send({ type: "done", timestamps: job.timestamps, videoTitle: job.videoTitle, videoDuration: job.videoDuration, hasTranscript: job.hasTranscript, transcriptSource: job.transcriptSource });
    res.end();
    return;
  }
  if (job.status === "error") {
    send({ type: "error", message: job.error ?? "Analysis failed" });
    res.end();
    return;
  }

  const onStep = (data: object) => send({ type: "step", ...data });
  const onDone = (data: object) => { send({ type: "done", ...data }); res.end(); cleanup(); };
  const onError = (data: object) => { send({ type: "error", ...data }); res.end(); cleanup(); };

  job.emitter.on("step", onStep);
  job.emitter.on("done", onDone);
  job.emitter.on("error", onError);

  const cleanup = () => {
    job.emitter.off("step", onStep);
    job.emitter.off("done", onDone);
    job.emitter.off("error", onError);
  };

  req.on("close", cleanup);
});

// GET /api/youtube/timestamps/status/:jobId — polling fallback
router.get("/timestamps/status/:jobId", (req: Request, res: Response) => {
  const job = tsJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({
    status: job.status,
    message: job.message ?? "",
    timestamps: job.timestamps,
    videoTitle: job.videoTitle,
    videoDuration: job.videoDuration,
    hasTranscript: job.hasTranscript,
    transcriptSource: job.transcriptSource,
    error: job.error,
  });
});

export default router;
