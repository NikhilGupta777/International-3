import React, { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText, Youtube, Upload, Download, Loader2, CheckCircle2,
  AlertCircle, Globe, X, FileAudio, FileVideo, ChevronDown,
  Copy, Check, RefreshCw, StopCircle, AlignLeft, History, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { LANGUAGES, TRANSLATE_LANGUAGES } from "@/lib/subtitle-languages";
import {
  type SubtitleHistoryEntry,
  loadHistory,
  saveToHistory,
  deleteFromHistory,
  clearHistory,
  formatRelativeTime,
} from "@/lib/subtitle-history";

const BASE = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

/** Strip SRT index numbers and timestamps — returns plain readable text */
function srtToText(srt: string): string {
  return srt.trim().split(/\n\n+/).map((block) => {
    const lines = block.trim().split("\n");
    return lines.slice(2).join(" ").trim();
  }).filter(Boolean).join("\n");
}

type InputMode = "url" | "file";

const STEP_LABELS: Record<string, string> = {
  audio:       "Downloading audio from YouTube...",
  uploading:   "Uploading to Gemini AI...",
  generating:  "Transcribing audio to SRT...",
  correcting:  "Auto-correcting errors (2nd AI pass)...",
  translating: "Translating subtitles (3rd AI pass)...",
  verifying:   "Verifying translation (4th AI pass)...",
  done:        "Subtitles ready!",
  error:       "Something went wrong",
  cancelled:   "Cancelled",
};

// URL mode includes "audio" step (YouTube download); file mode skips it
const BASE_STEPS_URL  = ["audio", "uploading", "generating", "correcting"];
const BASE_STEPS_FILE = ["uploading", "generating", "correcting"];
const TRANSLATE_STEPS = ["translating", "verifying"];

/** Rough time estimate: audioDuration * 0.15s per pass + overheads */
function estimateSeconds(durationSecs: number, hasTranslation: boolean): number {
  const perPassSecs = Math.ceil(durationSecs * 0.15);
  const twoPassSecs = perPassSecs * 2;
  const translationSecs = hasTranslation ? 90 : 0;
  return Math.max(30, twoPassSecs + translationSecs + 40);
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

export function GetSubtitles() {
  const [inputMode, setInputMode] = useState<InputMode>("url");
  const [url, setUrl] = useState("");
  const [language, setLanguage] = useState("auto");
  const [translateTo, setTranslateTo] = useState("none");
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobMessage, setJobMessage] = useState("");
  const [jobError, setJobError] = useState("");
  const [srtContent, setSrtContent] = useState<string | null>(null);
  const [srtFilename, setSrtFilename] = useState("subtitles.srt");
  const [originalSrt, setOriginalSrt] = useState<string | null>(null);
  const [originalFilename, setOriginalFilename] = useState<string | null>(null);
  // The source language that was actually used (for labelling "Download Original")
  const [jobSourceLang, setJobSourceLang] = useState<string>("auto");
  const [durationSecs, setDurationSecs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [history, setHistory] = useState<SubtitleHistoryEntry[]>(() => loadHistory());
  const [copied, setCopied] = useState(false);
  const [copiedOriginal, setCopiedOriginal] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedTextOriginal, setCopiedTextOriginal] = useState(false);
  // Smooth 1-second tick so the countdown updates every second, not every poll
  const [tick, setTick] = useState(0);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);

  // Track the last step that was actually active (for correct error/cancelled rendering)
  const lastGoodStepRef = useRef<string | null>(null);
  // Track which input mode was used for THIS job (not the current UI toggle)
  const jobInputModeRef = useRef<InputMode>("url");
  // Track translateTo used for THIS job (not the current UI state)
  const jobTranslateToRef = useRef<string>("none");
  // Set to true when cancel is clicked before the jobId has arrived
  const pendingCancelRef = useRef(false);

  // Store last submitted params for retry
  const lastUrlRef = useRef<string>("");
  const lastFileRef = useRef<File | null>(null);
  const lastLangRef = useRef<string>("auto");
  const lastTranslateRef = useRef<string>("none");
  const lastModeRef = useRef<InputMode>("url");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refs for click-outside detection on dropdowns
  const langDropdownRef = useRef<HTMLDivElement>(null);
  const translateDropdownRef = useRef<HTMLDivElement>(null);

  const { toast } = useToast();

  // Build step order using the JOB's actual mode/translateTo, not current UI state
  const jobStepBase = jobInputModeRef.current === "url" ? BASE_STEPS_URL : BASE_STEPS_FILE;
  const jobStepOrder = jobTranslateToRef.current !== "none"
    ? [...jobStepBase, ...TRANSLATE_STEPS, "done"]
    : [...jobStepBase, "done"];

  // Click-outside handler for both dropdowns
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (langOpen && langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setLangOpen(false);
      }
      if (translateOpen && translateDropdownRef.current && !translateDropdownRef.current.contains(e.target as Node)) {
        setTranslateOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [langOpen, translateOpen]);

  // Smooth 1-second tick while a job is running, for countdown display
  useEffect(() => {
    if (loading) {
      tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    } else {
      if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    }
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [loading]);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollStatus = useCallback((id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${BASE()}/api/subtitles/status/${id}`);
        const data = await res.json();

        if (data.durationSecs != null) setDurationSecs(data.durationSecs);
        if (data.progressPct != null) setProgressPct(data.progressPct);
        setJobStatus(data.status);
        setJobMessage(data.message ?? STEP_LABELS[data.status] ?? "");

        // Track last known good step for correct step-tracker rendering on error/cancel
        if (data.status && !["error", "cancelled", "done"].includes(data.status)) {
          lastGoodStepRef.current = data.status;
        }

        if (data.status === "done") {
          stopPolling();
          setLoading(false);
          setSrtContent(data.srt);
          setSrtFilename(data.filename ?? "subtitles.srt");
          setOriginalSrt(data.originalSrt ?? null);
          setOriginalFilename(data.originalFilename ?? null);

          // Persist result to device history (localStorage)
          const entry: SubtitleHistoryEntry = {
            id,
            createdAt: Date.now(),
            mode: jobInputModeRef.current,
            url: jobInputModeRef.current === "url" ? lastUrlRef.current : undefined,
            inputFilename: jobInputModeRef.current === "file" ? (lastFileRef.current?.name) : undefined,
            srtFilename: data.filename ?? "subtitles.srt",
            language: lastLangRef.current,
            translateTo: jobTranslateToRef.current,
            srt: data.srt ?? "",
            originalSrt: data.originalSrt ?? undefined,
            originalFilename: data.originalFilename ?? undefined,
            entryCount: (data.srt ?? "").trim().split(/\n\n+/).filter(Boolean).length,
          };
          saveToHistory(entry);
          setHistory(loadHistory());
        } else if (data.status === "error") {
          stopPolling();
          setLoading(false);
          setJobError(data.error ?? "Unknown error");
          toast({ title: "Failed", description: data.error, variant: "destructive" });
        } else if (data.status === "cancelled") {
          stopPolling();
          setLoading(false);
        }
      } catch {
        // keep polling on transient network errors
      }
    }, 2500);
  }, [toast]);

  const startJob = async (mode: InputMode, urlVal: string, fileVal: File | null, lang: string, trans: string) => {
    pendingCancelRef.current = false;
    setLoading(true);
    setSrtContent(null);
    setOriginalSrt(null);
    setOriginalFilename(null);
    setDurationSecs(null);
    setProgressPct(5);
    setTick(0);
    const initialStatus = mode === "url" ? "audio" : "uploading";
    setJobStatus(initialStatus);
    setJobMessage(mode === "url" ? "Downloading audio from YouTube..." : "Uploading to AI...");
    setJobError("");
    setJobId(null);
    setJobStartedAt(Date.now());
    setJobSourceLang(lang);
    lastGoodStepRef.current = initialStatus;

    // Snapshot the job's mode and translateTo for step tracker
    jobInputModeRef.current = mode;
    jobTranslateToRef.current = trans;

    // Save for retry
    lastUrlRef.current = urlVal;
    lastFileRef.current = fileVal;
    lastLangRef.current = lang;
    lastTranslateRef.current = trans;
    lastModeRef.current = mode;

    try {
      let res: Response;
      if (mode === "url") {
        res = await fetch(`${BASE()}/api/subtitles/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: urlVal.trim(), language: lang, translateTo: trans }),
        });
      } else {
        const form = new FormData();
        form.append("file", fileVal!);
        form.append("language", lang);
        form.append("translateTo", trans);
        res = await fetch(`${BASE()}/api/subtitles/upload`, { method: "POST", body: form });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start job");

      setJobId(data.jobId);

      // If cancel was clicked while the initial fetch was in-flight, cancel the server job now
      if (pendingCancelRef.current) {
        try { await fetch(`${BASE()}/api/subtitles/cancel/${data.jobId}`, { method: "POST" }); } catch {}
        return; // UI already shows "cancelled" from handleCancel
      }

      pollStatus(data.jobId);
    } catch (err: any) {
      if (pendingCancelRef.current) return; // suppress error if cancelled
      setLoading(false);
      setJobStatus("error");
      setJobError(err.message);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    startJob("url", url, null, language, translateTo);
  };

  const handleFileUpload = () => {
    if (!file) return;
    startJob("file", "", file, language, translateTo);
  };

  const handleRetry = () => {
    startJob(
      lastModeRef.current,
      lastUrlRef.current,
      lastFileRef.current,
      lastLangRef.current,
      lastTranslateRef.current,
    );
  };

  const handleCancel = async () => {
    pendingCancelRef.current = true;
    stopPolling();
    setJobStatus("cancelled");
    setJobMessage("Cancelled by user");
    setLoading(false);
    // If we already have a jobId, tell the server immediately
    if (jobId) {
      try { await fetch(`${BASE()}/api/subtitles/cancel/${jobId}`, { method: "POST" }); } catch {}
    }
    // If jobId is not yet set, startJob will detect pendingCancelRef and cancel after it arrives
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  const copyToClipboard = async () => {
    if (!srtContent) return;
    try {
      await navigator.clipboard.writeText(srtContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Could not access clipboard", variant: "destructive" });
    }
  };

  const copyOriginalToClipboard = async () => {
    if (!originalSrt) return;
    try {
      await navigator.clipboard.writeText(originalSrt);
      setCopiedOriginal(true);
      setTimeout(() => setCopiedOriginal(false), 2000);
    } catch {
      toast({ title: "Copy failed", description: "Could not access clipboard", variant: "destructive" });
    }
  };

  const reset = () => {
    stopPolling();
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    setJobId(null); setJobStatus(null); setJobMessage(""); setJobError("");
    setSrtContent(null); setOriginalSrt(null); setOriginalFilename(null);
    setDurationSecs(null); setLoading(false); setJobStartedAt(null); setTick(0);
    setProgressPct(0);
    lastGoodStepRef.current = null;
  };

  const selectedLang = LANGUAGES.find((l) => l.value === language);
  const isRunning = loading && jobStatus && !["done", "error", "cancelled"].includes(jobStatus);

  // Time estimate — uses `tick` so it updates every second smoothly
  const estimatedTotal = durationSecs != null ? estimateSeconds(durationSecs, jobTranslateToRef.current !== "none") : null;
  const elapsed = jobStartedAt ? Math.floor((Date.now() - jobStartedAt) / 1000) : 0;
  // suppress tick warning — it's intentionally used to trigger re-render
  void tick;
  const remaining = estimatedTotal != null ? estimatedTotal - elapsed : null;

  const durationLabel = durationSecs != null ? `Audio: ${formatDuration(durationSecs)}` : null;
  const remainingLabel = (() => {
    if (!isRunning || remaining === null || elapsed < 5) return null;
    if (remaining <= 5) return "Almost done...";
    return `~${formatDuration(remaining)} remaining`;
  })();

  const entryCount = srtContent?.split("\n\n").filter(Boolean).length ?? 0;

  // Original language label for download button (e.g. "Download Odia Original")
  const sourceLangLabel = jobSourceLang === "auto"
    ? "Original"
    : `${jobSourceLang} Original`;

  // ── Step tracker rendering ────────────────────────────────────────────────
  // Always use the job's frozen stepOrder (not live translateTo/inputMode)
  // When status is error/cancelled, use lastGoodStep to show which steps completed
  const effectiveStatus = ["error", "cancelled"].includes(jobStatus ?? "")
    ? lastGoodStepRef.current ?? jobStepOrder[0]
    : jobStatus;

  const currentStepIdx = jobStepOrder.indexOf(effectiveStatus ?? "");

  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col gap-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="bg-teal-500/20 p-2.5 rounded-xl border border-teal-500/30">
          <FileText className="w-5 h-5 text-teal-400" />
        </div>
        <div>
          <h2 className="text-xl font-display font-bold text-white">Get Subtitles</h2>
          <p className="text-white/50 text-sm">Generate accurate SRT subtitles using Gemini AI — supports Odia, Hindi, and 8 other languages</p>
        </div>
      </div>

      {/* Input mode toggle — locked while a job is running to prevent clearing live state */}
      <div className={cn("flex items-center gap-1 bg-white/5 border border-white/10 rounded-xl p-1 w-fit", isRunning && "opacity-50")}>
        <button
          onClick={() => { if (!isRunning) { setInputMode("url"); reset(); } }}
          disabled={!!isRunning}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all",
            inputMode === "url"
              ? "bg-teal-600 text-white shadow-[0_0_16px_rgba(20,184,166,0.3)]"
              : "text-white/50 hover:text-white/80",
            isRunning && "cursor-not-allowed"
          )}
        >
          <Youtube className="w-4 h-4" /> YouTube URL
        </button>
        <button
          onClick={() => { if (!isRunning) { setInputMode("file"); reset(); } }}
          disabled={!!isRunning}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all",
            inputMode === "file"
              ? "bg-teal-600 text-white shadow-[0_0_16px_rgba(20,184,166,0.3)]"
              : "text-white/50 hover:text-white/80",
            isRunning && "cursor-not-allowed"
          )}
        >
          <Upload className="w-4 h-4" /> Upload File
        </button>
      </div>

      {/* Language + Translation pickers row */}
      <div className="flex flex-col sm:flex-row gap-3">

        {/* Audio language picker — locked while job runs */}
        <div className="relative flex-1" ref={langDropdownRef}>
          <button
            onClick={() => { if (!isRunning) { setLangOpen((o) => !o); setTranslateOpen(false); } }}
            disabled={!!isRunning}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white/80 transition-all w-full",
              isRunning ? "opacity-50 cursor-not-allowed" : "hover:bg-white/8 hover:border-white/20 cursor-pointer"
            )}
          >
            <Globe className="w-4 h-4 text-teal-400 shrink-0" />
            <span className="flex-1 text-left">{selectedLang?.label ?? "Auto-detect"}</span>
            <ChevronDown className={cn("w-4 h-4 text-white/40 transition-transform", langOpen && "rotate-180")} />
          </button>
          <AnimatePresence>
            {langOpen && !isRunning && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
                className="absolute top-full left-0 mt-1 z-30 bg-zinc-900 border border-white/10 rounded-xl overflow-hidden shadow-2xl w-56"
              >
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.value}
                    onClick={() => { setLanguage(lang.value); setLangOpen(false); }}
                    className={cn(
                      "w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-white/8",
                      language === lang.value ? "text-teal-400 font-semibold" : "text-white/70"
                    )}
                  >
                    {lang.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Translation target picker — locked while job runs */}
        <div className="relative flex-1" ref={translateDropdownRef}>
          <button
            onClick={() => { if (!isRunning) { setTranslateOpen((o) => !o); setLangOpen(false); } }}
            disabled={!!isRunning}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 border rounded-xl text-sm transition-all w-full",
              isRunning
                ? "opacity-50 cursor-not-allowed bg-white/5 border-white/10 text-white/80"
                : translateTo !== "none"
                  ? "bg-violet-500/15 border-violet-500/40 text-violet-300 hover:bg-violet-500/20 cursor-pointer"
                  : "bg-white/5 border-white/10 text-white/80 hover:bg-white/8 hover:border-white/20 cursor-pointer"
            )}
          >
            <Globe className={cn("w-4 h-4 shrink-0", translateTo !== "none" && !isRunning ? "text-violet-400" : "text-white/30")} />
            <span className="flex-1 text-left">
              {TRANSLATE_LANGUAGES.find((l) => l.value === translateTo)?.label ?? "No translation"}
            </span>
            <ChevronDown className={cn("w-4 h-4 text-white/40 transition-transform", translateOpen && "rotate-180")} />
          </button>
          <AnimatePresence>
            {translateOpen && !isRunning && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
                className="absolute top-full left-0 mt-1 z-30 bg-zinc-900 border border-white/10 rounded-xl overflow-hidden shadow-2xl w-60"
              >
                <div className="px-4 py-2 border-b border-white/8">
                  <p className="text-white/40 text-xs">Translate subtitles after correction</p>
                </div>
                {TRANSLATE_LANGUAGES.map((lang) => (
                  <button
                    key={lang.value}
                    onClick={() => { setTranslateTo(lang.value); setTranslateOpen(false); }}
                    className={cn(
                      "w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-white/8",
                      translateTo === lang.value ? "text-violet-400 font-semibold" : "text-white/70"
                    )}
                  >
                    {lang.label}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      </div>

      {/* Input area */}
      <AnimatePresence mode="wait">
        {inputMode === "url" ? (
          <motion.form
            key="url-form"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            onSubmit={handleUrlSubmit}
            className="flex flex-col sm:flex-row gap-3"
          >
            <div className="relative flex-1">
              <Youtube className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste YouTube URL..."
                disabled={!!isRunning}
                className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-white placeholder:text-white/30 text-sm focus:outline-none focus:border-teal-500/50 transition-colors disabled:opacity-50"
              />
            </div>
            <Button
              type="submit"
              disabled={!url.trim() || !!isRunning}
              className="bg-teal-600 hover:bg-teal-500 text-white rounded-xl px-6 shrink-0 shadow-[0_0_16px_rgba(20,184,166,0.25)]"
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate SRT"}
            </Button>
          </motion.form>
        ) : (
          <motion.div
            key="file-form"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex flex-col gap-3"
          >
            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleFileDrop}
              onClick={() => !isRunning && fileInputRef.current?.click()}
              className={cn(
                "relative border-2 border-dashed rounded-2xl p-8 text-center transition-all",
                isRunning ? "cursor-default opacity-60"
                  : "cursor-pointer",
                isDragging
                  ? "border-teal-500/70 bg-teal-500/10"
                  : file
                    ? "border-teal-500/40 bg-teal-500/5"
                    : "border-white/15 bg-white/3 hover:border-white/30 hover:bg-white/5"
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/*,.mp4,.mkv,.avi,.mov,.webm,.mp3,.m4a,.wav,.flac,.ogg,.opus"
                className="hidden"
                onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }}
              />
              {file ? (
                <div className="flex items-center justify-center gap-3">
                  {file.type.startsWith("video") ? (
                    <FileVideo className="w-8 h-8 text-teal-400 shrink-0" />
                  ) : (
                    <FileAudio className="w-8 h-8 text-teal-400 shrink-0" />
                  )}
                  <div className="text-left min-w-0">
                    <p className="text-white font-semibold text-sm truncate">{file.name}</p>
                    <p className="text-white/40 text-xs mt-0.5">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  {!isRunning && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setFile(null); reset(); }}
                      className="ml-auto p-1 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <Upload className="w-10 h-10 text-white/20 mx-auto mb-3" />
                  <p className="text-white/60 font-medium text-sm">Drop a video or audio file here</p>
                  <p className="text-white/30 text-xs mt-1">MP4, MKV, MOV, AVI, WebM, MP3, M4A, WAV, FLAC — up to 500MB</p>
                </>
              )}
            </div>

            <Button
              onClick={handleFileUpload}
              disabled={!file || !!isRunning}
              className="bg-teal-600 hover:bg-teal-500 text-white rounded-xl shadow-[0_0_16px_rgba(20,184,166,0.25)] w-full sm:w-auto sm:self-end"
            >
              {isRunning ? (
                <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Processing...</span>
              ) : (
                "Generate SRT"
              )}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Progress panel */}
      <AnimatePresence>
        {jobStatus && (
          <motion.div
            key="progress-panel"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="glass-panel rounded-2xl p-5 flex flex-col gap-4"
          >
            {/* Progress bar */}
            {isRunning && (
              <div className="w-full h-1.5 bg-white/8 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-teal-500 to-teal-400 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              </div>
            )}

            {/* Step indicators — uses job's frozen stepOrder + last known good step */}
            <div className="flex items-center gap-2">
              {jobStepOrder.map((step, i) => {
                const isErrorOrCancelled = ["error", "cancelled"].includes(jobStatus ?? "");
                const isDone = jobStatus === "done" || i < currentStepIdx;
                const isActive = !isErrorOrCancelled && i === currentStepIdx && jobStatus !== "done";
                const isFailed = isErrorOrCancelled && i === currentStepIdx;
                const isStoppedAt = jobStatus === "cancelled" && i === currentStepIdx;

                return (
                  <React.Fragment key={step}>
                    <div className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border transition-all",
                      isDone
                        ? "bg-teal-500/30 border-teal-500/50 text-teal-300"
                        : isActive
                          ? "bg-teal-600/20 border-teal-500/40 text-teal-400 animate-pulse"
                          : isFailed && !isStoppedAt
                            ? "bg-red-500/20 border-red-500/40 text-red-400"
                            : isStoppedAt
                              ? "bg-yellow-500/20 border-yellow-500/40 text-yellow-400"
                              : "bg-white/5 border-white/10 text-white/20"
                    )}>
                      {isDone
                        ? <CheckCircle2 className="w-3.5 h-3.5" />
                        : isFailed && !isStoppedAt
                          ? <AlertCircle className="w-3.5 h-3.5" />
                          : isStoppedAt
                            ? <StopCircle className="w-3.5 h-3.5" />
                            : i + 1
                      }
                    </div>
                    {i < jobStepOrder.length - 1 && (
                      <div className={cn(
                        "flex-1 h-[2px] rounded transition-all",
                        isDone ? "bg-teal-500/40" : "bg-white/8"
                      )} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>

            {/* Status message */}
            {jobStatus === "cancelled" ? (
              <div className="flex items-start gap-3 text-yellow-300">
                <StopCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Cancelled</p>
                  <p className="text-yellow-300/60 text-sm mt-0.5">Job was stopped.</p>
                </div>
              </div>
            ) : jobStatus === "error" ? (
              <div className="flex items-start gap-3 text-red-300">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Failed</p>
                  <p className="text-red-300/70 text-sm mt-0.5">{jobError}</p>
                </div>
              </div>
            ) : jobStatus === "done" ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-teal-400 shrink-0" />
                  <div className="flex-1">
                    <p className="text-teal-300 font-semibold text-sm">Subtitles generated successfully!</p>
                    <p className="text-white/40 text-xs mt-0.5">{entryCount} subtitle entries</p>
                  </div>
                </div>

                {/* Download + copy buttons */}
                {/* Primary SRT (translated when translation on, otherwise the corrected original) */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => downloadFile(srtContent!, srtFilename)}
                    className="bg-teal-600 hover:bg-teal-500 text-white rounded-xl px-5 shadow-[0_0_14px_rgba(20,184,166,0.3)]"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    {originalSrt ? `Download ${jobTranslateToRef.current}` : "Download SRT"}
                  </Button>
                  <Button
                    onClick={copyToClipboard}
                    variant="outline"
                    className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-4"
                    title="Copy full SRT with timestamps"
                  >
                    {copied ? <Check className="w-4 h-4 mr-1.5 text-teal-400" /> : <Copy className="w-4 h-4 mr-1.5" />}
                    {copied ? "Copied!" : "Copy SRT"}
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!srtContent) return;
                      try {
                        await navigator.clipboard.writeText(srtToText(srtContent));
                        setCopiedText(true);
                        setTimeout(() => setCopiedText(false), 2000);
                      } catch {
                        toast({ title: "Copy failed", description: "Could not access clipboard", variant: "destructive" });
                      }
                    }}
                    variant="outline"
                    className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-4"
                    title="Copy plain text only (no timestamps)"
                  >
                    {copiedText ? <Check className="w-4 h-4 mr-1.5 text-teal-400" /> : <AlignLeft className="w-4 h-4 mr-1.5" />}
                    {copiedText ? "Copied!" : "Copy text"}
                  </Button>
                </div>

                {/* Original-language SRT when translation was on */}
                {originalSrt && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => downloadFile(originalSrt, originalFilename ?? "original.srt")}
                      variant="outline"
                      className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-5"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Download {sourceLangLabel}
                    </Button>
                    <Button
                      onClick={copyOriginalToClipboard}
                      variant="outline"
                      className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-4"
                      title="Copy full original SRT with timestamps"
                    >
                      {copiedOriginal ? <Check className="w-4 h-4 mr-1.5 text-teal-400" /> : <Copy className="w-4 h-4 mr-1.5" />}
                      {copiedOriginal ? "Copied!" : "Copy SRT"}
                    </Button>
                    <Button
                      onClick={async () => {
                        if (!originalSrt) return;
                        try {
                          await navigator.clipboard.writeText(srtToText(originalSrt));
                          setCopiedTextOriginal(true);
                          setTimeout(() => setCopiedTextOriginal(false), 2000);
                        } catch {
                          toast({ title: "Copy failed", description: "Could not access clipboard", variant: "destructive" });
                        }
                      }}
                      variant="outline"
                      className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-4"
                      title="Copy plain text only (no timestamps)"
                    >
                      {copiedTextOriginal ? <Check className="w-4 h-4 mr-1.5 text-teal-400" /> : <AlignLeft className="w-4 h-4 mr-1.5" />}
                      {copiedTextOriginal ? "Copied!" : "Copy text"}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 text-teal-400 animate-spin shrink-0" />
                <div className="flex-1">
                  <p className="text-white/80 font-medium text-sm">{jobMessage || STEP_LABELS[jobStatus ?? "uploading"] || "Processing..."}</p>
                  <p className="text-white/30 text-xs mt-0.5">
                    {durationLabel && remainingLabel
                      ? `${durationLabel} · ${remainingLabel}`
                      : durationLabel
                        ? `${durationLabel} · Estimating time...`
                        : "Processing audio..."}
                  </p>
                </div>
                {/* Cancel button */}
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white/40 hover:text-red-400 hover:bg-red-500/10 border border-white/10 hover:border-red-500/30 transition-all shrink-0"
                >
                  <X className="w-3.5 h-3.5" /> Cancel
                </button>
              </div>
            )}

            {/* SRT preview — 25 entries, scrollable */}
            {srtContent && (
              <div className="rounded-xl bg-black/30 border border-white/8 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 border-b border-white/8">
                  <p className="text-white/30 text-xs font-medium">
                    Preview · {Math.min(25, entryCount)} of {entryCount} entries
                  </p>
                  {entryCount > 25 && <p className="text-white/20 text-xs">scroll to see more</p>}
                </div>
                <div className="p-4 max-h-64 overflow-y-auto">
                  <pre className="text-xs text-white/50 whitespace-pre-wrap font-mono leading-relaxed">
                    {srtContent.split("\n\n").filter(Boolean).slice(0, 25).join("\n\n")}
                    {entryCount > 25 && `\n\n... and ${entryCount - 25} more entries`}
                  </pre>
                </div>
              </div>
            )}

            {/* Footer actions */}
            {(jobStatus === "done" || jobStatus === "error" || jobStatus === "cancelled") && (
              <div className="flex items-center gap-3 pt-1">
                {(jobStatus === "error" || jobStatus === "cancelled") && (
                  <button
                    onClick={handleRetry}
                    className="flex items-center gap-1.5 text-xs text-teal-400/80 hover:text-teal-300 transition-colors"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry
                  </button>
                )}
                <button
                  onClick={reset}
                  className="text-xs text-white/30 hover:text-white/60 transition-colors ml-auto"
                >
                  Start over
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── History panel ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {history.length > 0 && (
          <motion.div
            key="history-panel"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex flex-col gap-3"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-white/40">
                <History className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider">History · saved on this device</span>
              </div>
              <button
                onClick={() => { clearHistory(); setHistory([]); }}
                className="flex items-center gap-1 text-xs text-white/25 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Clear all
              </button>
            </div>

            {/* Entry list */}
            <div className="flex flex-col gap-2">
              {history.map((entry) => {
                const sourceLang = LANGUAGES.find((l) => l.value === entry.language)?.label ?? entry.language;
                const targetLang = entry.translateTo !== "none"
                  ? TRANSLATE_LANGUAGES.find((l) => l.value === entry.translateTo)?.label?.replace("Translate → ", "") ?? entry.translateTo
                  : null;
                return (
                  <motion.div
                    key={entry.id}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    className="glass-panel rounded-xl px-4 py-3 flex items-start gap-3"
                  >
                    {/* Icon */}
                    <div className="mt-0.5 shrink-0">
                      {entry.mode === "url"
                        ? <Youtube className="w-4 h-4 text-red-400/70" />
                        : <FileAudio className="w-4 h-4 text-teal-400/70" />}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-white/70 text-sm font-medium truncate" title={entry.url ?? entry.inputFilename}>
                        {entry.srtFilename}
                      </p>
                      <p className="text-white/30 text-xs mt-0.5 truncate">
                        {sourceLang}{targetLang ? ` → ${targetLang}` : ""} · {entry.entryCount} entries · {formatRelativeTime(entry.createdAt)}
                      </p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => {
                          const blob = new Blob([entry.srt], { type: "text/plain;charset=utf-8" });
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(blob);
                          a.download = entry.srtFilename;
                          document.body.appendChild(a); a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(a.href);
                        }}
                        title="Download SRT"
                        className="p-1.5 rounded-lg hover:bg-teal-500/15 text-white/30 hover:text-teal-400 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(srtToText(entry.srt));
                            toast({ title: "Copied!", description: "Plain text copied to clipboard" });
                          } catch {
                            toast({ title: "Copy failed", variant: "destructive" });
                          }
                        }}
                        title="Copy plain text"
                        className="p-1.5 rounded-lg hover:bg-white/10 text-white/30 hover:text-white/70 transition-colors"
                      >
                        <AlignLeft className="w-3.5 h-3.5" />
                      </button>
                      {entry.originalSrt && (
                        <button
                          onClick={() => {
                            const blob = new Blob([entry.originalSrt!], { type: "text/plain;charset=utf-8" });
                            const a = document.createElement("a");
                            a.href = URL.createObjectURL(blob);
                            a.download = entry.originalFilename ?? "original.srt";
                            document.body.appendChild(a); a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(a.href);
                          }}
                          title="Download original language SRT"
                          className="p-1.5 rounded-lg hover:bg-violet-500/15 text-white/30 hover:text-violet-400 transition-colors"
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => setHistory(deleteFromHistory(entry.id))}
                        title="Remove from history"
                        className="p-1.5 rounded-lg hover:bg-red-500/15 text-white/20 hover:text-red-400 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
