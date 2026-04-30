import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, Languages, Mic, MicOff, Play, Download, CheckCircle,
  Loader2, AlertCircle, X, ChevronDown, Subtitles, RefreshCw,
  Film, Wand2, Volume2, Eye, Share2, History, Trash2, Terminal, ChevronUp
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  loadActiveTranslatorJobs,
  upsertActiveTranslatorJob,
  removeActiveTranslatorJob,
  loadTranslatorHistory,
  saveTranslatorHistory,
  deleteTranslatorHistory,
  isTranslatorHistoryDeleted,
  type ActiveTranslatorJob,
  type TranslatorHistoryEntry,
} from "@/lib/translator-history";
import { translatorAuthHeaders } from "@/lib/translator-client-id";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API = `${BASE}/api/translator`;

// â”€â”€ Language options â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const LANGS = [
  { code: "auto", name: "Auto-detect" },
  { code: "en", name: "English" }, { code: "es", name: "Spanish" }, { code: "fr", name: "French" },
  { code: "de", name: "German" }, { code: "pt", name: "Portuguese" }, { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" }, { code: "ko", name: "Korean" }, { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" }, { code: "ru", name: "Russian" }, { code: "hi", name: "Hindi" },
  { code: "nl", name: "Dutch" }, { code: "pl", name: "Polish" }, { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" }, { code: "vi", name: "Vietnamese" }, { code: "id", name: "Indonesian" },
  { code: "fil", name: "Filipino" }, { code: "fi", name: "Finnish" },
];
const TARGET_LANGS = LANGS.filter(l => l.code !== "auto");
const MAX_VIDEO_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const NO_STORE: RequestCache = "no-store";

async function responseError(res: Response, fallback: string): Promise<Error> {
  try {
    const data = await readJsonResponse<{ error?: string }>(res);
    if (typeof data?.error === "string" && data.error.trim()) {
      return new Error(data.error);
    }
  } catch { }
  return new Error(fallback);
}

async function readJsonResponse<T = any>(res: Response, fallback?: T): Promise<T> {
  const text = await res.text();
  if (!text.trim()) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Server returned an empty response (${res.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error(`Server returned invalid JSON (${res.status})`);
  }
}

function toEpoch(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function translatorShareUrl(jobId: string): string {
  const path = `${BASE}/api/translator/share/${encodeURIComponent(jobId)}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

// â”€â”€ Step config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const STEP_ICONS: Record<string, React.ReactNode> = {
  audio_extraction: <Volume2 className="w-4 h-4" />,
  transcription: <Subtitles className="w-4 h-4" />,
  translation: <Languages className="w-4 h-4" />,
  voice_generation: <Mic className="w-4 h-4" />,
  lip_sync: <Film className="w-4 h-4" />,
  video_merge: <Wand2 className="w-4 h-4" />,
};
const STEP_COLORS: Record<string, string> = {
  completed: "text-green-400 border-green-500/30 bg-green-500/8",
  running: "text-blue-400  border-blue-500/30  bg-blue-500/8",
  failed: "text-red-400   border-red-500/30   bg-red-500/8",
  skipped: "text-white/30  border-white/10     bg-white/3",
  pending: "text-white/40  border-white/10     bg-white/3",
};

// â”€â”€ Select component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function LangSelect({ value, onChange, options, label, id }: {
  value: string; onChange: (v: string) => void;
  options: typeof LANGS; label: string; id: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-white/40 font-medium uppercase tracking-wider">{label}</label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full appearance-none bg-white/[0.06] border border-white/[0.1] rounded-xl
                     px-4 py-2.5 pr-8 text-sm text-white/90 focus:outline-none focus:border-primary/60
                     cursor-pointer transition-colors"
        >
          {options.map(l => (
            <option key={l.code} value={l.code} className="bg-[#1a1a1a] text-white">{l.name}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
      </div>
    </div>
  );
}

// â”€â”€ Step card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function StepCard({ step }: { step: any }) {
  const colorClass = STEP_COLORS[step.status] ?? STEP_COLORS.pending;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex items-center gap-3 px-4 py-3 rounded-xl border transition-all", colorClass)}
    >
      <span className="shrink-0">{STEP_ICONS[step.name] ?? <Wand2 className="w-4 h-4" />}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{step.label}</span>
          {step.status === "running" && step.progress != null && (
            <span className="text-xs font-mono opacity-70">{step.progress}%</span>
          )}
        </div>
        {step.message && (
          <p className="text-xs opacity-60 truncate mt-0.5">{step.message}</p>
        )}
        {step.status === "running" && step.progress != null && (
          <div className="mt-2 h-1 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-blue-400 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${step.progress}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        )}
      </div>
      <span className="shrink-0">
        {step.status === "completed" && <CheckCircle className="w-4 h-4 text-green-400" />}
        {step.status === "running" && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
        {step.status === "failed" && <AlertCircle className="w-4 h-4 text-red-400" />}
      </span>
    </motion.div>
  );
}

// â”€â”€ Transcript panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function TranscriptPanel({ segments }: { segments: any[] }) {
  if (!segments.length) return null;
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <Subtitles className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-white/80">Transcript</span>
        <span className="text-xs text-white/30 ml-auto">{segments.length} segments</span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {segments.map((s, i) => (
          <div key={i} className="px-4 py-2 border-b border-white/[0.04] last:border-0">
            <div className="flex items-start gap-3">
              <span className="text-[10px] text-white/30 font-mono shrink-0 mt-0.5">
                {String(Math.floor(s.start / 60)).padStart(2, "0")}:{String(Math.floor(s.start % 60)).padStart(2, "0")}
              </span>
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="text-xs text-white/50 line-through">{s.originalText}</p>
                <p className="text-sm text-white/90">{s.translatedText}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// â”€â”€ Drop zone â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function DropZone({ onFile, disabled }: { onFile: (f: File) => void; disabled?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault(); setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f && !disabled) onFile(f);
      }}
      className={cn(
        "relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed",
        "cursor-pointer transition-all duration-200 py-16 px-8",
        dragging ? "border-primary/70 bg-primary/8 scale-[1.01]"
          : "border-white/[0.12] hover:border-white/25 bg-white/[0.02] hover:bg-white/[0.04]",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <div className="w-16 h-16 rounded-2xl bg-white/[0.06] border border-white/[0.1] flex items-center justify-center">
        <Upload className="w-7 h-7 text-white/50" />
      </div>
      <div className="text-center">
        <p className="text-base font-semibold text-white/80">Drop your video here</p>
        <p className="text-sm text-white/40 mt-1">MP4, MOV, MKV, AVI, WebM Â· Max 2GB</p>
      </div>
      <input ref={inputRef} type="file" accept=".mp4,.mov,.mkv,.avi,.webm" className="hidden"
        onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}

// â”€â”€ Main component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function VideoTranslator() {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [srcLang, setSrcLang] = useState("auto");
  const [tgtLang, setTgtLang] = useState("en");
  const [voiceStyle, setVoiceStyle] = useState<"original" | "female">("original");
  const [lipSync, setLipSync] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [transcript, setTranscript] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveTranslatorJob[]>(() => loadActiveTranslatorJobs());
  const [history, setHistory] = useState<TranslatorHistoryEntry[]>(() => loadTranslatorHistory());
  const [debugLog, setDebugLog] = useState<{ ts: number; level: "info" | "warn" | "error"; msg: string }[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const appendLog = (level: "info" | "warn" | "error", msg: string) =>
    setDebugLog(prev => [...prev.slice(-49), { ts: Date.now(), level, msg }]);

  const refreshHistory = useCallback(() => {
    setActiveJobs(loadActiveTranslatorJobs());
    setHistory(loadTranslatorHistory());
  }, []);

  const fetchResultUrls = useCallback(async (id: string) => {
    const tr = await fetch(`${API}/result/${id}`, { headers: translatorAuthHeaders(), cache: NO_STORE });
    if (!tr.ok) return null;
    const result = await readJsonResponse(tr);
    return {
      ...(result as { videoUrl?: string; shareUrl?: string; srtUrl?: string; transcriptUrl?: string }),
      shareUrl: translatorShareUrl(id),
    };
  }, []);

  const fetchResult = useCallback(async (id: string) => {
    const result = await fetchResultUrls(id);
    if (!result) return null;
    if (result.transcriptUrl) {
      const tj = await fetch(result.transcriptUrl, { cache: NO_STORE });
      if (tj.ok) {
        const parsed = await readJsonResponse(tj, { segments: [] });
        setTranscript(parsed.segments ?? []);
      }
    }
    setJob((prev: any) => ({ ...prev, ...result }));
    return result;
  }, [fetchResultUrls]);

  // Poll job status from DynamoDB via API
  const pollStatus = useCallback(async (id: string) => {
    try {
      const r = await fetch(`${API}/status/${id}`, { headers: translatorAuthHeaders(), cache: NO_STORE });
      if (!r.ok) {
        if (r.status === 404 || r.status === 410) {
          removeActiveTranslatorJob(id);
          refreshHistory();
          clearInterval(pollRef.current!);
          if (jobId === id) {
            setJob(null);
            setJobId(null);
          }
        }
        return;
      }
      const data = await readJsonResponse(r);
      setJob(data);
      // Append real step/warning/error messages to debug log
      if (data.step) appendLog(data.status === "FAILED" ? "error" : "info", `[${data.status}] ${data.step}`);
      if (data.lipsyncWarning) appendLog("warn", `[LIPSYNC] ${data.lipsyncWarning}`);
      if (data.voiceCloneWarning) appendLog("warn", `[VOICE CLONE] ${data.voiceCloneWarning}`);
      if (data.error) appendLog("error", `[ERROR] ${data.error}`);
      const activeMeta = loadActiveTranslatorJobs().find((j) => j.jobId === id);
      if (!["DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(data.status)) {
        upsertActiveTranslatorJob({
          jobId: id,
          filename: data.filename ?? activeMeta?.filename ?? file?.name ?? "video.mp4",
          targetLang: data.targetLang ?? activeMeta?.targetLang ?? TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
          targetLangCode: data.targetLangCode ?? activeMeta?.targetLangCode ?? tgtLang,
          sourceLang: data.sourceLang ?? activeMeta?.sourceLang ?? srcLang,
          startedAt: activeMeta?.startedAt ?? toEpoch(data.createdAt),
          progress: data.progress ?? activeMeta?.progress ?? 0,
          step: data.step ?? activeMeta?.step ?? "",
          status: data.status ?? activeMeta?.status ?? "QUEUED",
        });
        refreshHistory();
      }
      if (data.status === "DONE") {
        clearInterval(pollRef.current!);
        const result = await fetchResult(id);
        removeActiveTranslatorJob(id);
        saveTranslatorHistory({
          jobId: id,
          createdAt: toEpoch(data.createdAt, activeMeta?.startedAt ?? Date.now()),
          updatedAt: toEpoch(data.updatedAt, Date.now()),
          filename: data.filename ?? activeMeta?.filename ?? file?.name ?? "video.mp4",
          targetLang: data.targetLang ?? activeMeta?.targetLang ?? TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
          targetLangCode: data.targetLangCode ?? activeMeta?.targetLangCode ?? tgtLang,
          sourceLang: data.sourceLang ?? activeMeta?.sourceLang ?? srcLang,
          progress: 100,
          segmentCount: data.segmentCount,
          videoUrl: result?.videoUrl,
          shareUrl: translatorShareUrl(id),
          srtUrl: result?.srtUrl,
          transcriptUrl: result?.transcriptUrl,
        });
        refreshHistory();
      } else if (data.status === "FAILED") {
        clearInterval(pollRef.current!);
        removeActiveTranslatorJob(id);
        refreshHistory();
        setError(data.error ?? "Translation failed");
      } else if (data.status === "CANCELLED" || data.status === "EXPIRED") {
        clearInterval(pollRef.current!);
        removeActiveTranslatorJob(id);
        refreshHistory();
      }
    } catch (e: any) {
      setError(e?.message);
    }
  }, [fetchResult, file?.name, jobId, refreshHistory, srcLang, tgtLang]);

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(() => pollStatus(jobId), 2000);
    pollStatus(jobId);
    return () => clearInterval(pollRef.current!);
  }, [jobId, pollStatus]);

  useEffect(() => {
    let closed = false;
    const reconcileTranslatorJobs = async () => {
      try {
        const activeJobs = loadActiveTranslatorJobs();
        for (const activeJob of activeJobs) {
          if (isTranslatorHistoryDeleted(activeJob.jobId)) {
            removeActiveTranslatorJob(activeJob.jobId);
            continue;
          }

          try {
            const statusRes = await fetch(`${API}/status/${encodeURIComponent(activeJob.jobId)}`, {
              headers: translatorAuthHeaders(),
              cache: NO_STORE,
            });
            if (!statusRes.ok) {
              if (statusRes.status === 404 || statusRes.status === 410) {
                removeActiveTranslatorJob(activeJob.jobId);
              }
              continue;
            }
            const statusItem = await readJsonResponse<any>(statusRes, { status: "UNKNOWN" });
            if (statusItem.status === "DONE") {
              const urls = await fetchResultUrls(activeJob.jobId);
              saveTranslatorHistory({
                jobId: activeJob.jobId,
                createdAt: toEpoch(statusItem.createdAt, activeJob.startedAt),
                updatedAt: toEpoch(statusItem.updatedAt, Date.now()),
                filename: statusItem.filename ?? activeJob.filename,
                targetLang: statusItem.targetLang ?? activeJob.targetLang,
                targetLangCode: statusItem.targetLangCode ?? activeJob.targetLangCode,
                sourceLang: statusItem.sourceLang ?? activeJob.sourceLang,
                progress: 100,
                segmentCount: statusItem.segmentCount,
                videoUrl: urls?.videoUrl,
                shareUrl: translatorShareUrl(activeJob.jobId),
                srtUrl: urls?.srtUrl,
                transcriptUrl: urls?.transcriptUrl,
              });
              removeActiveTranslatorJob(activeJob.jobId);
            } else if (statusItem.status === "FAILED" || statusItem.status === "CANCELLED" || statusItem.status === "EXPIRED") {
              removeActiveTranslatorJob(activeJob.jobId);
            } else {
              upsertActiveTranslatorJob({
                ...activeJob,
                filename: statusItem.filename ?? activeJob.filename,
                targetLang: statusItem.targetLang ?? activeJob.targetLang,
                targetLangCode: statusItem.targetLangCode ?? activeJob.targetLangCode,
                sourceLang: statusItem.sourceLang ?? activeJob.sourceLang,
                progress: statusItem.progress ?? activeJob.progress,
                step: statusItem.step ?? activeJob.step,
                status: statusItem.status ?? activeJob.status,
              });
            }
          } catch { }
        }

        const res = await fetch(`${API}/history?limit=20`, { headers: translatorAuthHeaders(), cache: NO_STORE });
        if (!res.ok) return;
        const data = await readJsonResponse<any>(res, { jobs: [] });
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        for (const item of jobs) {
          if (!item?.jobId) continue;
          if (isTranslatorHistoryDeleted(item.jobId)) {
            removeActiveTranslatorJob(item.jobId);
            continue;
          }

          const existingActive = loadActiveTranslatorJobs().find((entry) => entry.jobId === item.jobId);
          if (item.status === "DONE") {
            const existing = loadTranslatorHistory().find((entry) => entry.jobId === item.jobId);
            let urls: { videoUrl?: string; shareUrl?: string; srtUrl?: string; transcriptUrl?: string } | null = null;
            try {
              urls = await fetchResultUrls(item.jobId);
            } catch { }
            saveTranslatorHistory({
              jobId: item.jobId,
              createdAt: toEpoch(item.createdAt, existingActive?.startedAt ?? Date.now()),
              updatedAt: toEpoch(item.updatedAt, toEpoch(item.createdAt)),
              filename: item.filename ?? existing?.filename ?? "video.mp4",
              targetLang: item.targetLang ?? existing?.targetLang ?? "Unknown",
              targetLangCode: item.targetLangCode ?? existing?.targetLangCode,
              sourceLang: item.sourceLang ?? existing?.sourceLang,
              progress: 100,
              segmentCount: item.segmentCount,
              videoUrl: urls?.videoUrl ?? existing?.videoUrl,
              shareUrl: translatorShareUrl(item.jobId),
              srtUrl: urls?.srtUrl ?? existing?.srtUrl,
              transcriptUrl: urls?.transcriptUrl ?? existing?.transcriptUrl,
            });
            removeActiveTranslatorJob(item.jobId);
          } else if (item.status === "FAILED" || item.status === "CANCELLED" || item.status === "EXPIRED") {
            removeActiveTranslatorJob(item.jobId);
          } else if (existingActive) {
            upsertActiveTranslatorJob({
              ...existingActive,
              filename: item.filename ?? existingActive.filename,
              targetLang: item.targetLang ?? existingActive.targetLang,
              targetLangCode: item.targetLangCode ?? existingActive.targetLangCode,
              sourceLang: item.sourceLang ?? existingActive.sourceLang,
              progress: item.progress ?? existingActive.progress,
              step: item.step ?? existingActive.step,
              status: item.status ?? existingActive.status,
            });
          }
        }
        if (!closed) {
          refreshHistory();
          if (!jobId) {
            const active = loadActiveTranslatorJobs();
            const newest = active.sort((a, b) => b.startedAt - a.startedAt)[0];
            if (newest) {
              setJobId(newest.jobId);
              setJob({
                jobId: newest.jobId,
                status: newest.status,
                progress: newest.progress,
                step: newest.step,
                filename: newest.filename,
                targetLang: newest.targetLang,
              });
            }
          }
        }
      } catch { }
    };

    void reconcileTranslatorJobs();
    return () => {
      closed = true;
    };
  }, [fetchResultUrls, jobId, refreshHistory]);

  const handleUpload = async () => {
    if (!file) return;
    setError(null); setUploading(true); setJob(null); setTranscript([]);
    try {
      if (file.size > MAX_VIDEO_SIZE_BYTES) {
        throw new Error("Video is larger than the 2GB upload limit.");
      }

      // Step 1: Get S3 presigned PUT URL
      const presignRes = await fetch(
        `${API}/presign?filename=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type || "video/mp4")}`,
        { headers: translatorAuthHeaders() },
      );
      if (!presignRes.ok) throw await responseError(presignRes, "Failed to get upload URL");
      const { jobId: newJobId, presignedUrl, s3Key } = await readJsonResponse(presignRes);
      if (!newJobId || !presignedUrl || !s3Key) {
        throw new Error("Upload URL response was incomplete.");
      }

      // Step 2: Upload directly to S3
      const uploadRes = await fetch(presignedUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "video/mp4" },
      });
      if (!uploadRes.ok) throw new Error("S3 upload failed");

      // Step 3: Submit Batch job
      const submitRes = await fetch(`${API}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...translatorAuthHeaders() },
        body: JSON.stringify({
          jobId: newJobId,
          s3Key,
          filename: file.name,
          targetLang: TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
          targetLangCode: tgtLang,
          sourceLang: srcLang,
          voiceClone: voiceStyle === "original",
          lipSync,
          lipSyncQuality: "latentsync",
        }),
      });
      if (!submitRes.ok) throw await responseError(submitRes, "Submit failed");
      const submitData = await readJsonResponse(submitRes);
      if (!submitData?.jobId) {
        throw new Error("Submit response was incomplete.");
      }

      upsertActiveTranslatorJob({
        jobId: newJobId,
        filename: file.name,
        targetLang: TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
        targetLangCode: tgtLang,
        sourceLang: srcLang,
        startedAt: Date.now(),
        progress: 0,
        step: "Job queued, waiting for worker...",
        status: "QUEUED",
      });
      setJobId(newJobId);
      refreshHistory();
    } catch (e: any) {
      setError(e?.message);
    } finally {
      setUploading(false);
    }
  };

  const reset = () => {
    clearInterval(pollRef.current!);
    setFile(null); setJobId(null); setJob(null);
    setTranscript([]); setError(null); setShowTranscript(false);
  };

  const openActiveEntry = (entry: ActiveTranslatorJob) => {
    clearInterval(pollRef.current!);
    setFile(null);
    setError(null);
    setTranscript([]);
    setJobId(entry.jobId);
    setJob({
      jobId: entry.jobId,
      status: entry.status,
      progress: entry.progress,
      step: entry.step,
      filename: entry.filename,
      targetLang: entry.targetLang,
      targetLangCode: entry.targetLangCode,
      sourceLang: entry.sourceLang,
      createdAt: entry.startedAt,
    });
  };

  const cancelTranslation = async (id: string) => {
    try {
      const res = await fetch(`${API}/cancel/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: translatorAuthHeaders(),
        cache: NO_STORE,
      });
      if (!res.ok) throw await responseError(res, "Cancel failed");
      removeActiveTranslatorJob(id);
      refreshHistory();
      if (jobId === id) {
        clearInterval(pollRef.current!);
        setJob((prev: any) => ({ ...(prev ?? { jobId: id }), status: "CANCELLED", step: "Cancelled by user." }));
        setError(null);
      }
      toast({ title: "Translation cancelled" });
    } catch (e: any) {
      setError(e?.message ?? "Cancel failed");
    }
  };

  const openHistoryEntry = async (entry: TranslatorHistoryEntry) => {
    clearInterval(pollRef.current!);
    setFile(null);
    setError(null);
    setTranscript([]);
    setJobId(entry.jobId);
    setJob({
      jobId: entry.jobId,
      status: "DONE",
      progress: 100,
      step: "Translation complete!",
      filename: entry.filename,
      targetLang: entry.targetLang,
      segmentCount: entry.segmentCount,
      videoUrl: entry.videoUrl,
      srtUrl: entry.srtUrl,
      transcriptUrl: entry.transcriptUrl,
      shareUrl: entry.shareUrl ?? translatorShareUrl(entry.jobId),
    });
    const result = await fetchResult(entry.jobId);
    if (result) {
      const updated = { ...entry, ...result, shareUrl: translatorShareUrl(entry.jobId) };
      saveTranslatorHistory(updated);
      refreshHistory();
    }
  };

  const deleteHistoryEntry = (id: string) => {
    deleteTranslatorHistory(id);
    refreshHistory();
    if (jobId === id) reset();
  };

  const shareUrl = async (url?: string) => {
    if (!url) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Translated video", url });
      } else {
        await navigator.clipboard.writeText(url);
        toast({ title: "Link copied" });
      }
    } catch { }
  };

  const isProcessing = job && !["DONE", "FAILED", "CANCELLED", "EXPIRED"].includes(job.status);
  const isDone = job?.status === "DONE";
  const overallPct = job?.progress ?? 0;

  // Derive step-by-step breakdown from real DynamoDB status + progress
  // Worker status flow: QUEUED → STARTING → EXTRACTING → TRANSCRIBING →
  //   TRANSLATING → CLONING → LIPSYNC → MERGING → UPLOADING → DONE
  const PIPELINE_STEPS = [
    { name: "download", label: "Downloading video", thresholdPct: 3, status_keys: ["STARTING"] },
    { name: "audio_extraction", label: "Extracting audio", thresholdPct: 12, status_keys: ["EXTRACTING"] },
    { name: "transcription", label: "Transcribing speech", thresholdPct: 28, status_keys: ["TRANSCRIBING"] },
    { name: "translation", label: "Translating text", thresholdPct: 48, status_keys: ["TRANSLATING"] },
    { name: "voice_generation", label: "Cloning voice", thresholdPct: 65, status_keys: ["CLONING"] },
    { name: "lip_sync", label: "Running lip sync", thresholdPct: 82, status_keys: ["LIPSYNC"] },
    { name: "video_merge", label: "Merging & generating SRT", thresholdPct: 88, status_keys: ["MERGING"] },
    { name: "upload", label: "Uploading to cloud", thresholdPct: 100, status_keys: ["UPLOADING", "DONE"] },
  ];

  const derivedSteps = isProcessing || isDone
    ? PIPELINE_STEPS.map((s) => {
      const isCurrentStatus = s.status_keys.includes(job?.status ?? "");
      const isPastThreshold = overallPct >= s.thresholdPct;
      const isBeforeThreshold = overallPct < s.thresholdPct && !isCurrentStatus;
      let stepStatus: string;
      if (isDone || isPastThreshold) stepStatus = "completed";
      else if (isCurrentStatus) stepStatus = "running";
      else if (isBeforeThreshold) stepStatus = "pending";
      else stepStatus = "completed";
      return {
        name: s.name,
        label: s.label,
        status: stepStatus,
        // Show real step message from DynamoDB on the currently running step
        message: isCurrentStatus ? (job?.step ?? "") : undefined,
        // Show real sub-progress on the running step
        progress: isCurrentStatus ? overallPct : undefined,
      };
    })
    : null;


  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Languages className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Video Translator</h1>
            <p className="text-sm text-white/40">GPU-powered voice cloning Â· 20 languages</p>
          </div>
          {jobId && (
            <button onClick={reset} className="ml-auto p-2 rounded-xl bg-white/6 hover:bg-white/10 text-white/50 hover:text-white transition-colors">
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              className="flex flex-col gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-300 text-sm">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="flex-1">{error}</span>
                <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
              </div>
              {/* Quick-fix actions */}
              <div className="flex gap-2 pl-7">
                {error.toLowerCase().includes("cosyvoice") || error.toLowerCase().includes("voice clon") ? (
                  <button
                    onClick={() => { setVoiceStyle("female"); setError(null); setJobId(null); setJob(null); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/10 hover:bg-white/15 text-white/80 transition-colors border border-white/12"
                  >
                    👩 Switch to Neural Voice &amp; Retry
                  </button>
                ) : null}
                <button
                  onClick={() => { setError(null); setJobId(null); setJob(null); }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/06 hover:bg-white/10 text-white/50 transition-colors border border-white/08"
                >
                  Start Over
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {activeJobs.length > 0 && (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-amber-300 animate-spin" />
              <span className="text-sm font-semibold text-white/85">Active translations</span>
              <span className="text-xs text-white/35 ml-auto">{activeJobs.length}</span>
            </div>
            <div className="divide-y divide-white/[0.05]">
              {activeJobs.map((entry) => (
                <div key={entry.jobId} className={cn(
                  "px-4 py-3 flex items-center gap-3 transition-colors",
                  jobId === entry.jobId ? "bg-white/[0.05]" : "hover:bg-white/[0.03]"
                )}>
                  <button
                    onClick={() => openActiveEntry(entry)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="text-sm text-white/85 font-medium truncate">{entry.filename}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-white/40">
                      <span>{entry.status}</span>
                      <span>{entry.progress}%</span>
                      <span>{formatRelative(entry.startedAt)}</span>
                    </div>
                    <div className="mt-2 h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400 rounded-full" style={{ width: `${Math.max(2, entry.progress)}%` }} />
                    </div>
                  </button>
                  <button
                    onClick={() => void cancelTranslation(entry.jobId)}
                    className="px-3 py-2 rounded-lg text-xs font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <>
          <>
            {/* Drop zone */}
            <DropZone onFile={setFile} disabled={uploading} />
            {file && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.05] border border-white/[0.08]">
                <Film className="w-4 h-4 text-primary shrink-0" />
                <span className="text-sm text-white/80 flex-1 truncate">{file.name}</span>
                <span className="text-xs text-white/40">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                <button onClick={() => setFile(null)} className="text-white/30 hover:text-white/70 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Settings */}
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 flex flex-col gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 vt-options-grid">
                <LangSelect id="src-lang" label="Source Language" value={srcLang}
                  onChange={setSrcLang} options={LANGS} />
                <LangSelect id="tgt-lang" label="Target Language" value={tgtLang}
                  onChange={setTgtLang} options={TARGET_LANGS} />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs text-white/40 font-medium uppercase tracking-wider">Voice Style</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setVoiceStyle("original")}
                    className={cn("flex-1 py-3 rounded-xl text-sm font-medium border transition-all flex flex-col items-center gap-1",
                      voiceStyle === "original" ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/80")}
                  >
                    <span>🎤 Clone Voice</span>
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300/80 border border-amber-400/20">GPU Required</span>
                  </button>
                  <button
                    onClick={() => setVoiceStyle("female")}
                    className={cn("flex-1 py-3 rounded-xl text-sm font-medium border transition-all flex flex-col items-center gap-1",
                      voiceStyle === "female" ? "bg-primary/20 border-primary/50 text-primary" : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/80")}
                  >
                    <span>👩 Neural Voice</span>
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300/80 border border-emerald-400/20">Always Available</span>
                  </button>
                </div>
                {voiceStyle === "original" && (
                  <p className="text-[11px] text-amber-300/60 flex items-center gap-1.5">
                    <span>⚠️</span>
                    Requires GPU worker. Auto-falls back to Neural Voice if unavailable.
                  </p>
                )}
              </div>

              <label className="flex items-center gap-3 cursor-pointer select-none">
                <div onClick={() => setLipSync(!lipSync)}
                  className={cn("w-10 h-6 rounded-full transition-all relative",
                    lipSync ? "bg-primary" : "bg-white/20")}>
                  <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all",
                    lipSync ? "left-[18px]" : "left-0.5")} />
                </div>
                <div>
                  <p className="text-sm text-white/80 font-medium">Lip Sync (LatentSync)</p>
                  <p className="text-xs text-white/40">Match mouth movements to translated audio</p>
                </div>
              </label>
            </div>

            {/* Submit */}
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className={cn(
                "w-full py-3.5 rounded-2xl font-bold text-base flex items-center justify-center gap-2 transition-all",
                file && !uploading
                  ? "bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/25"
                  : "bg-white/10 text-white/30 cursor-not-allowed"
              )}
            >
              {uploading ? <><Loader2 className="w-5 h-5 animate-spin" /> Uploadingâ€¦</> : <><Languages className="w-5 h-5" /> Translate Video</>}
            </button>
          </>
        </>

        {jobId && (
          <>
            {/* Overall progress */}
            {isProcessing && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-white/88">Translating video…</span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-mono text-white/50">{overallPct.toFixed(0)}%</span>
                    <button
                      onClick={() => jobId && void cancelTranslation(jobId)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                {job?.step && (
                  <p className="text-xs text-white/45 mb-3 flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin shrink-0 text-primary/60" />
                    {job.step}
                  </p>
                )}
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <motion.div className="h-full bg-gradient-to-r from-primary to-orange-400 rounded-full"
                    animate={{ width: `${Math.max(2, overallPct)}%` }} transition={{ duration: 0.6 }} />
                </div>
              </>
            )}
            {/* Steps + Debug log */}
            {derivedSteps && (
              <div className="flex flex-col gap-2 mt-3">
                {derivedSteps.map((s) => <StepCard key={s.name} step={s} />)}
              </div>
            )}

            {/* Debug Log — collapsible, always available during/after processing */}
            {debugLog.length > 0 && (
              <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/30 overflow-hidden">
                <button
                  onClick={() => setShowDebug(v => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs text-white/50 hover:text-white/70 hover:bg-white/5 transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <Terminal className="w-3 h-3" />
                    Debug log
                    {debugLog.some(l => l.level === "error") && (
                      <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-mono">
                        {debugLog.filter(l => l.level === "error").length} error{debugLog.filter(l => l.level === "error").length > 1 ? "s" : ""}
                      </span>
                    )}
                    {debugLog.some(l => l.level === "warn") && (
                      <span className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono">
                        {debugLog.filter(l => l.level === "warn").length} warning{debugLog.filter(l => l.level === "warn").length > 1 ? "s" : ""}
                      </span>
                    )}
                  </span>
                  {showDebug ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {showDebug && (
                  <div className="px-3 pb-3 flex flex-col gap-0.5 max-h-52 overflow-y-auto font-mono text-[11px]">
                    {debugLog.map((entry, i) => (
                      <div key={i} className={cn(
                        "flex gap-2 leading-5",
                        entry.level === "error" ? "text-red-400" :
                          entry.level === "warn" ? "text-yellow-400" :
                            "text-white/40"
                      )}>
                        <span className="shrink-0 text-white/20">
                          {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </span>
                        <span className="break-all">{entry.msg}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Done */}
            {isDone && (
              <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                className="rounded-2xl border border-green-500/25 bg-green-500/8 p-5 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-6 h-6 text-green-400" />
                  <div>
                    <p className="font-bold text-green-300">Translation Complete!</p>
                    <p className="text-xs text-white/40 mt-0.5">{job?.filename ?? file?.name ?? "Translated video"}</p>
                  </div>
                </div>
                {job?.videoUrl && (
                  <video
                    src={job.videoUrl}
                    controls
                    className="w-full rounded-xl bg-black aspect-video"
                  />
                )}
                <div className="flex gap-3">
                  {job?.videoUrl && (
                    <a href={job.videoUrl} download="translated_video.mp4"
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-white text-sm transition-all"
                      style={{ background: "linear-gradient(135deg,#16a34a,#15803d)", boxShadow: "0 4px 16px rgba(22,163,74,0.3)" }}>
                      <Download className="w-4 h-4" /> Download Video
                    </a>
                  )}
                  {job?.srtUrl && (
                    <a href={job.srtUrl} download="subtitles.srt"
                      className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                      <Subtitles className="w-4 h-4" /> SRT
                    </a>
                  )}
                  <button onClick={() => setShowTranscript(!showTranscript)}
                    className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                    <Eye className="w-4 h-4" /> Transcript
                  </button>
                  {job?.videoUrl && (
                    <button onClick={() => shareUrl(job.shareUrl ?? (job.jobId ? translatorShareUrl(job.jobId) : job.videoUrl))}
                      className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                      <Share2 className="w-4 h-4" /> Share
                    </button>
                  )}
                </div>
              </motion.div>
            )}

            {(job?.status === "CANCELLED" || job?.status === "EXPIRED") && (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-sm text-white/60">
                {job.status === "CANCELLED" ? "Translation cancelled." : "Translation expired."}
              </div>
            )}

            {/* Transcript */}
            {showTranscript && transcript.length > 0 && (
              <TranscriptPanel segments={transcript} />
            )}
          </>
        )}

        {history.length > 0 && (
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
              <History className="w-4 h-4 text-white/50" />
              <span className="text-sm font-semibold text-white/80">Translation History</span>
              <span className="text-xs text-white/30 ml-auto">{history.length}</span>
            </div>
            <div className="divide-y divide-white/[0.05]">
              {history.slice(0, 8).map((entry) => (
                <div key={entry.jobId} className="px-4 py-3 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <Languages className="w-4 h-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white/85 font-medium truncate">{entry.filename}</p>
                    <div className="flex items-center gap-1.5 text-xs text-white/35 mt-0.5">
                      <span>{entry.targetLang}</span>
                      {entry.segmentCount != null && <><span>{"\u00b7"}</span><span>{entry.segmentCount} segments</span></>}
                      <span>{"\u00b7"}</span>
                      <span>{formatRelative(entry.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => void openHistoryEntry(entry)}
                      className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                      title="Preview"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    {entry.videoUrl && (
                      <a
                        href={entry.videoUrl}
                        download="translated_video.mp4"
                        className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                        title="Download"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    )}
                    <button
                      onClick={() => shareUrl(entry.shareUrl ?? translatorShareUrl(entry.jobId))}
                      disabled={!entry.jobId}
                      className="p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                      title="Share"
                    >
                      <Share2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => deleteHistoryEntry(entry.jobId)}
                      className="p-2 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Remove"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
