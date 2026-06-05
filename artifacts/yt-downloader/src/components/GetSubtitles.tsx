import React, { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText, Youtube, Upload, Download, Loader2, CheckCircle2,
  AlertCircle, Globe, X, FileAudio, FileVideo, ChevronDown,
  Copy, Check, RefreshCw, StopCircle, AlignLeft, History, Trash2,
  Link2, Info, ArrowUp, Sparkles, Languages, MoreVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { LANGUAGES, TRANSLATE_LANGUAGES } from "@/lib/subtitle-languages";
import {
  type SubtitleHistoryEntry,
  type ActiveJobRecord,
  loadHistory,
  saveToHistory,
  deleteFromHistory,
  clearHistory,
  formatRelativeTime,
  saveActiveJob,
  loadActiveJob,
  clearActiveJob,
} from "@/lib/subtitle-history";

const BASE = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

/** Strip SRT index numbers and timestamps — returns plain readable text */
function srtToText(srt: string): string {
  return srt.trim().split(/\n\n+/).map((block) => {
    const lines = block.trim().split("\n");
    return lines.slice(2).join(" ").trim();
  }).filter(Boolean).join("\n");
}

function extractVideoId(url: string) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function parseCombinedInput(input: string) {
  const urlRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)[a-zA-Z0-9_-]{11}(?:\S+)?)/i;
  const match = input.match(urlRegex);
  if (!match) return { url: "", description: input.trim() };
  
  const url = match[1];
  const description = input.replace(url, "").replace(/\s+/g, " ").trim();
  return { url, description };
}

function getSrtDuration(srt: string): string {
  const matches = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2})[,.]\d{3}/g)];
  if (matches.length === 0) return "0m";
  const lastMatch = matches[matches.length - 1];
  const h = parseInt(lastMatch[1], 10);
  const m = parseInt(lastMatch[2], 10);
  const s = parseInt(lastMatch[3], 10);
  const totalSecs = h * 3600 + m * 60 + s;
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.round(totalSecs / 60);
  return `${mins} min`;
}

type InputMode = "url" | "file";

const STEP_LABELS: Record<string, string> = {
  audio:       "Checking video and preparing subtitles...",
  uploading:   "Uploading to Gemini AI...",
  generating:  "Gemini is writing SRT subtitles...",
  correcting:  "Auto-correcting errors (2nd AI pass)...",
  translating: "Translating subtitles (3rd AI pass)...",
  verifying:   "Verifying subtitles against the video...",
  done:        "Subtitles ready!",
  error:       "Something went wrong",
  cancelled:   "Cancelled",
};

// URL mode includes "audio" step (YouTube download); file mode skips it
const BASE_STEPS_URL  = ["audio", "uploading", "generating", "correcting"];
const BASE_STEPS_FILE = ["uploading", "generating", "correcting"];
const TRANSLATE_STEPS = ["translating", "verifying"];
const SUBTITLE_JOB_MISSING_GRACE_MS = 2 * 60 * 1000;

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
  const [command, setCommand] = useState("");
  const [showHelper, setShowHelper] = useState(false);
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
  const [copied, setCopied] = useState(false);
  const [copiedOriginal, setCopiedOriginal] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [copiedTextOriginal, setCopiedTextOriginal] = useState(false);
  const [tick, setTick] = useState(0);
  const [showTips, setShowTips] = useState(true);
  const [jobStartedAt, setJobStartedAt] = useState<number | null>(null);
  const [history, setHistory] = useState<SubtitleHistoryEntry[]>(() => {
    const loaded = loadHistory();
    if (loaded.length === 0) {
      const mockEntries: SubtitleHistoryEntry[] = [
        {
          id: "mock-bhagwat",
          createdAt: Date.now() - 2 * 3600 * 1000, // 2 hours ago
          mode: "url",
          url: "https://www.youtube.com/watch?v=yG8t4qH9JqY",
          srtFilename: "Bhagwat Katha Highlights.srt",
          language: "hi",
          translateTo: "none",
          srt: "1\n00:00:00,000 --> 00:00:15,000\nमंगलाचरण\n\n",
          entryCount: 234,
        },
        {
          id: "mock-productivity",
          createdAt: Date.now() - 24 * 3600 * 1000, // 1 day ago
          mode: "url",
          url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          srtFilename: "Productivity Tips for Creators.srt",
          language: "en",
          translateTo: "none",
          srt: "1\n00:00:00,000 --> 00:00:10,000\nIntroduction\n\n",
          entryCount: 156,
        },
      ];
      mockEntries.forEach(saveToHistory);
      return mockEntries;
    }
    return loaded;
  });

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
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollSessionRef = useRef(0);
  const pollIntervalMsRef = useRef(2500);
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

  // ── Reconnect to an active job on mount ────────────────────────────────────
  // If the user navigated away while a job was running, resume polling on return.
  useEffect(() => {
    const active = loadActiveJob();
    if (!active) return;

    // Restore refs so the done-handler can save the correct history entry
    jobInputModeRef.current = active.mode;
    jobTranslateToRef.current = active.translateTo;
    lastUrlRef.current = active.url ?? "";
    lastLangRef.current = active.language;
    lastTranslateRef.current = active.translateTo;
    lastModeRef.current = active.mode;

    // Restore visible state
    setJobId(active.jobId);
    setJobStartedAt(active.startedAt);
    setLoading(true);
    setJobStatus("generating");
    setJobMessage("Reconnecting to background job…");
    if (active.url) setUrl(active.url);

    pollStatus(active.jobId, active.startedAt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Stop status polling and any pending fetch when the component unmounts
  // (e.g. user switches tab). Without this, polling can continue forever
  // in the background after the component is gone.
  useEffect(() => {
    return () => {
      pollSessionRef.current += 1;
      if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
      if (pollAbortRef.current) {
        pollAbortRef.current.abort();
        pollAbortRef.current = null;
      }
    };
  }, []);

  const stopPolling = () => {
    pollSessionRef.current += 1;
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (pollAbortRef.current) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
  };

  const pollStatus = useCallback((id: string, startedAtHint?: number) => {
    stopPolling();
    const session = pollSessionRef.current;
    const startedAt = startedAtHint ?? Date.now();
    pollIntervalMsRef.current = 2500; // reset backoff for each new job

    const scheduleNext = (fn: () => Promise<void>) => {
      if (session !== pollSessionRef.current) return;
      const interval = pollIntervalMsRef.current;
      // Grow interval by 30% each poll, capped at 10 seconds
      pollIntervalMsRef.current = Math.min(Math.round(interval * 1.3), 10_000);
      pollRef.current = setTimeout(fn, interval);
    };

    const tick = async () => {
      if (session !== pollSessionRef.current) return;
      try {
        const controller = new AbortController();
        pollAbortRef.current = controller;
        const res = await fetch(`${BASE()}/api/subtitles/status/${id}`, {
          signal: controller.signal,
        });
        if (session !== pollSessionRef.current) return;
        pollAbortRef.current = null;

        // A transient 404 can happen during restart/deploy. Keep retrying briefly.
        if (res.status === 404) {
          if (Date.now() - startedAt < SUBTITLE_JOB_MISSING_GRACE_MS) {
            setJobStatus("pending");
            setJobMessage("Reconnecting to subtitle job...");
            scheduleNext(tick);
            return;
          }
          stopPolling();
          setLoading(false);
          setJobStatus("error");
          setJobError("The server was restarted and the job was lost. Please try again.");
          clearActiveJob();
          return;
        }

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
          clearActiveJob();
        } else if (data.status === "error") {
          stopPolling();
          setLoading(false);
          setJobError(data.error ?? "Unknown error");
          clearActiveJob();
          toast({ title: "Failed", description: data.error, variant: "destructive" });
        } else if (data.status === "cancelled") {
          stopPolling();
          setLoading(false);
          clearActiveJob();
        } else {
          // Still running — schedule next poll with backoff
          scheduleNext(tick);
        }
      } catch (err) {
        if (
          err instanceof DOMException &&
          err.name === "AbortError"
        ) {
          return;
        }
        // Transient network error — retry with backoff
        scheduleNext(tick);
      }
    };

    tick(); // kick off immediately
  }, [toast]);

  const startJobInFlightRef = useRef(false);
  const startJob = async (mode: InputMode, urlVal: string, fileVal: File | null, lang: string, trans: string) => {
    if (startJobInFlightRef.current) return; // prevent overlapping startJob calls
    startJobInFlightRef.current = true;
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
    setJobMessage(mode === "url" ? "Starting subtitle job..." : "Uploading to AI...");
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
      let data: { jobId: string };
      if (mode === "url") {
        const res = await fetch(`${BASE()}/api/subtitles/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: urlVal.trim(), language: lang, translateTo: trans }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Failed to start job");
        data = body;
      } else {
        const initRes = await fetch(`${BASE()}/api/subtitles/upload/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: fileVal!.name,
            contentType: fileVal!.type || "application/octet-stream",
            size: fileVal!.size,
          }),
        });
        const initBody = await initRes.json();
        if (!initRes.ok) throw new Error(initBody.error || "Failed to initialize upload");

        const uploadRes = await fetch(initBody.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": fileVal!.type || "application/octet-stream",
          },
          body: fileVal!,
        });
        if (!uploadRes.ok) {
          throw new Error("Failed to upload media file");
        }

        const startRes = await fetch(`${BASE()}/api/subtitles/upload/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploadKey: initBody.uploadKey,
            originalFilename: fileVal!.name,
            language: lang,
            translateTo: trans,
          }),
        });
        const startBody = await startRes.json();
        if (!startRes.ok) throw new Error(startBody.error || "Failed to start uploaded subtitle job");
        data = startBody;
      }

      setJobId(data.jobId);

      // Persist active job so the user can reconnect after navigating away
      saveActiveJob({
        jobId: data.jobId,
        mode,
        url: mode === "url" ? urlVal : undefined,
        inputFilename: mode === "file" ? fileVal?.name : undefined,
        language: lang,
        translateTo: trans,
        startedAt: Date.now(),
      });

      // If cancel was clicked while the initial fetch was in-flight, cancel the server job now
      if (pendingCancelRef.current) {
        try { await fetch(`${BASE()}/api/subtitles/cancel/${data.jobId}`, { method: "POST" }); } catch {}
        clearActiveJob();
        return; // UI already shows "cancelled" from handleCancel
      }

      pollStatus(data.jobId, Date.now());
    } catch (err: any) {
      if (pendingCancelRef.current) { startJobInFlightRef.current = false; return; } // suppress error if cancelled
      setLoading(false);
      setJobStatus("error");
      setJobError(err.message);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      startJobInFlightRef.current = false;
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
    if (lastModeRef.current === "file" && !lastFileRef.current) {
      setInputMode("file");
      toast({
        title: "Select file to retry",
        description: "The previous upload is no longer available. Please pick the file again.",
      });
      return;
    }
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
    clearActiveJob();
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
    clearActiveJob();
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
  const jobSourceLabel = LANGUAGES.find((l) => l.value === jobSourceLang)?.label ?? jobSourceLang;
  const sourceLangLabel = jobSourceLang === "auto"
    ? "Original"
    : jobSourceLabel;

  const effectiveStatus = ["error", "cancelled"].includes(jobStatus ?? "")
    ? lastGoodStepRef.current ?? jobStepOrder[0]
    : jobStatus;

  const currentStepIdx = jobStepOrder.indexOf(effectiveStatus ?? "");

  const handleGenerateSubtitles = () => {
    if (file) {
      startJob("file", "", file, language, translateTo);
    } else if (command.trim()) {
      startJob("url", command, null, language, translateTo);
    }
  };

  return (
    <div className="w-full flex flex-col gap-5 px-2 py-6 md:py-10 text-left">
      <style>{`
        @keyframes rgbGlow {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        @keyframes rocketFire {
          0%, 100% { 
            filter: drop-shadow(0 0 2px #ffffff) drop-shadow(0 0 5px #af52de) drop-shadow(0 0 9px #ff2d55) brightness(0.95);
          }
          50% { 
            filter: drop-shadow(0 0 3.5px #ffffff) drop-shadow(0 0 8px #af52de) drop-shadow(0 0 15px #ff2d55) brightness(1.2);
          }
        }
      `}</style>

      {/* Header */}
      <div className="flex flex-col items-start text-left mb-2">
        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          Get Subtitles
        </h1>
        <p className="mt-3 text-base text-zinc-400 leading-relaxed">
          Generate accurate SRT subtitles from YouTube links, videos, or audio.
        </p>
      </div>

      {/* Unified Input Card with RGB Glow */}
      <div 
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleFileDrop}
        className="relative group w-full"
      >
        {/* Glowing backdrop blur */}
        <div 
          className="absolute -inset-[5.5px] rounded-[12px] opacity-40 blur-[12px] transition-all duration-500 group-hover:opacity-60 group-focus-within:opacity-85"
          style={{
            background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
            backgroundSize: '300% 300%',
            animation: 'rgbGlow 10s ease-in-out infinite',
          }}
        />
        {/* Outer border wrapper */}
        <div className="relative w-full rounded-[12px] p-[1.2px] overflow-hidden bg-zinc-800">
          {/* Border background gradient */}
          <div 
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
              backgroundSize: '300% 300%',
              animation: 'rgbGlow 10s ease-in-out infinite',
            }}
          />
          {/* Inner input container */}
          <div className="relative rounded-[11px] bg-[#09090b] py-4 px-5 shadow-[0_10px_35px_rgba(0,0,0,0.5)]">
            <div className="flex items-center gap-4">
              {/* Left icon: file indicator or link icon */}
              <div className="shrink-0 select-none">
                {file ? (
                  file.type.startsWith("video") ? (
                    <FileVideo className="h-6 w-6 text-teal-400" />
                  ) : (
                    <FileAudio className="h-6 w-6 text-teal-400" />
                  )
                ) : (
                  <Link2 className="h-6 w-6 text-zinc-500" />
                )}
              </div>
              
              {/* Middle content: Textarea + Floating file details */}
              <div className="flex-1 flex flex-col items-start min-w-0">
                {/* File Chip floating inside if file is uploaded */}
                {file && (
                  <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-300 text-xs font-semibold mb-2">
                    <span className="truncate max-w-[220px] select-all">{file.name}</span>
                    <span className="opacity-60 font-mono">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                        reset();
                      }}
                      className="p-0.5 rounded hover:bg-teal-500/25 text-teal-400 hover:text-white transition"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                <textarea
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  disabled={loading}
                  placeholder="Paste YouTube URL or upload a file..."
                  className="min-h-[24px] h-14 w-full resize-none bg-transparent py-0.5 text-sm text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleGenerateSubtitles();
                    }
                  }}
                />
                <span className="text-zinc-500 text-[11px] select-none leading-normal">
                  You can also describe what you want the subtitles to focus on.
                </span>
              </div>

              {/* Right options: Help (i) and Upload circle button */}
              <div className="flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowHelper(!showHelper)}
                  className="p-1.5 rounded-full hover:bg-white/5 text-zinc-400 hover:text-white transition"
                  title="Help info"
                >
                  <Info className="h-6 w-6" />
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => fileInputRef.current?.click()}
                  className="grid h-10 w-10 place-items-center rounded-full bg-zinc-800 hover:bg-zinc-700 text-white transition shadow-sm border border-zinc-700/40 disabled:opacity-50"
                  title="Upload audio/video file"
                >
                  <ArrowUp className="h-5 w-5" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,video/*,.mp4,.mkv,.avi,.mov,.webm,.mp3,.m4a,.wav,.flac"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.[0]) {
                      setFile(e.target.files[0]);
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Drag and drop overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-20 rounded-[12px] bg-teal-500/10 border-2 border-dashed border-teal-500/50 backdrop-blur-[2px] flex items-center justify-center pointer-events-none">
            <p className="text-teal-400 font-semibold text-sm">Drop file here to upload</p>
          </div>
        )}

        {/* Helper preview popover */}
        <AnimatePresence>
          {showHelper && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowHelper(false)} />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                className="absolute right-0 top-20 z-50 w-80 rounded-2xl border border-zinc-800 bg-[#0d0d0d] p-4 shadow-[0_12px_40px_rgba(0,0,0,0.65)] flex flex-col gap-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">How to use</span>
                  <button onClick={() => setShowHelper(false)} className="text-zinc-500 hover:text-zinc-300 text-xs">Close</button>
                </div>
                <div className="text-xs text-zinc-400 space-y-2 leading-relaxed text-left">
                  <p>Paste a YouTube URL or click the upload arrow button to upload a file (MP4, MP3, WAV, etc.).</p>
                  <p>You can also describe what you want the subtitles to focus on in the input box.</p>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Supports format info */}
      <div className="text-[11px] text-zinc-500 text-left -mt-2.5 pl-1 leading-normal select-none">
        Supports: YouTube links, MP4, MOV, MKV, AVI, MP3, M4A, WAV, FLAC (Max 500MB)
      </div>

      {/* Languages Columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 w-full mt-1">
        {/* From dropdown */}
        <div className="flex flex-col gap-1.5 text-left relative" ref={langDropdownRef}>
          <span className="text-xs font-semibold text-zinc-400 select-none pl-0.5">From</span>
          <button
            type="button"
            onClick={() => { if (!loading) { setLangOpen((o) => !o); setTranslateOpen(false); } }}
            disabled={loading}
            className="flex items-center gap-2.5 px-4 py-3 bg-[#09090b]/60 border border-zinc-800 rounded-xl text-sm text-white font-medium transition-all w-full hover:bg-white/[0.03] hover:border-zinc-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Globe className="w-4 h-4 text-zinc-500 shrink-0" />
            <span className="flex-1 text-left truncate">{selectedLang?.label ?? "Auto-detect"}</span>
            <ChevronDown className={cn("w-4 h-4 text-zinc-500 transition-transform duration-200", langOpen && "rotate-180")} />
          </button>
          <AnimatePresence>
            {langOpen && !loading && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setLangOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.96, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute left-0 top-full mt-1.5 z-40 bg-[#0d0d0d] border border-zinc-800 rounded-xl overflow-hidden shadow-[0_12px_30px_rgba(0,0,0,0.65)] w-56 p-1 max-h-60 overflow-y-auto scrollbar-thin"
                >
                  {LANGUAGES.map((lang) => (
                    <button
                      key={lang.value}
                      type="button"
                      onClick={() => { setLanguage(lang.value); setLangOpen(false); }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-xs font-semibold rounded-lg transition-colors hover:bg-white/5",
                        language === lang.value ? "text-teal-400 bg-teal-500/5 font-bold" : "text-zinc-400 hover:text-white"
                      )}
                    >
                      {lang.label}
                    </button>
                  ))}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Translate to dropdown */}
        <div className="flex flex-col gap-1.5 text-left relative" ref={translateDropdownRef}>
          <span className="text-xs font-semibold text-zinc-400 select-none pl-0.5">Translate to</span>
          <button
            type="button"
            onClick={() => { if (!loading) { setTranslateOpen((o) => !o); setLangOpen(false); } }}
            disabled={loading}
            className="flex items-center gap-2.5 px-4 py-3 bg-[#09090b]/60 border border-zinc-800 rounded-xl text-sm text-white font-medium transition-all w-full hover:bg-white/[0.03] hover:border-zinc-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Globe className="w-4 h-4 text-zinc-500 shrink-0" />
            <span className="flex-1 text-left truncate">
              {TRANSLATE_LANGUAGES.find((l) => l.value === translateTo)?.label ?? "No translation"}
            </span>
            <ChevronDown className={cn("w-4 h-4 text-zinc-500 transition-transform duration-200", translateOpen && "rotate-180")} />
          </button>
          <AnimatePresence>
            {translateOpen && !loading && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setTranslateOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.96, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 top-full mt-1.5 z-40 bg-[#0d0d0d] border border-zinc-800 rounded-xl overflow-hidden shadow-[0_12px_30px_rgba(0,0,0,0.65)] w-60 p-1 max-h-60 overflow-y-auto scrollbar-thin"
                >
                  <div className="px-3 py-1.5 border-b border-zinc-900 mb-1 select-none">
                    <p className="text-zinc-500 text-[10px] font-bold uppercase tracking-wider">Translate subtitles after correction</p>
                  </div>
                  {TRANSLATE_LANGUAGES.map((lang) => (
                    <button
                      key={lang.value}
                      type="button"
                      onClick={() => { setTranslateTo(lang.value); setTranslateOpen(false); }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-xs font-semibold rounded-lg transition-colors hover:bg-white/5",
                        translateTo === lang.value ? "text-violet-400 bg-violet-500/5 font-bold" : "text-zinc-400 hover:text-white"
                      )}
                    >
                      {lang.label}
                    </button>
                  ))}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>


      {/* Generate Subtitles Button */}
      <Button
        type="button"
        onClick={handleGenerateSubtitles}
        disabled={(!command.trim() && !file) || loading}
        className="w-full py-4 rounded-2xl bg-white hover:bg-zinc-100 text-black font-bold text-sm transition-all duration-200 active:scale-[0.98] shadow-[0_6px_24px_rgba(255,255,255,0.15)] flex items-center justify-center gap-2 mt-2 disabled:cursor-not-allowed disabled:pointer-events-none"
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin text-black" />
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-black shrink-0"
          >
            <rect width="20" height="16" x="2" y="4" rx="2" ry="2" />
            <path d="M7 10h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H7" />
            <path d="M13 10h2a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-2" />
          </svg>
        )}
        <span>Generate Subtitles</span>
      </Button>

      {/* Active Job Progress Card wrapped in glowing RGB border */}
      <AnimatePresence>
        {jobStatus && (
          <motion.div
            key="progress-panel"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="w-full mt-4"
          >
            {/* If the job is active, wrap it in a glowing RGB border */}
            {isRunning ? (
              <div className="relative group w-full">
                <div 
                  className="absolute -inset-[5.5px] rounded-[12px] opacity-30 blur-[12px] transition-all duration-500 group-hover:opacity-40"
                  style={{
                    background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
                    backgroundSize: '300% 300%',
                    animation: 'rgbGlow 10s ease-in-out infinite',
                  }}
                />
                <div className="relative w-full rounded-[12px] p-[1.2px] overflow-hidden bg-zinc-800">
                  <div 
                    className="absolute inset-0"
                    style={{
                      background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
                      backgroundSize: '300% 300%',
                      animation: 'rgbGlow 10s ease-in-out infinite',
                    }}
                  />
                  <div className="relative rounded-[11px] bg-[#09090b] py-3.5 px-4 shadow-[0_12px_40px_rgba(0,0,0,0.5)] flex flex-col gap-3 text-left">
                    {/* Active job layout */}
                    <div className="flex items-center gap-3">
                      <Loader2 className="w-5 h-5 text-teal-400 animate-spin shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-white/95 font-semibold text-sm truncate">{jobMessage || "Processing subtitles..."}</p>
                        <p className="text-zinc-500 text-xs mt-0.5">
                          {durationLabel && remainingLabel
                            ? `${durationLabel} · ${remainingLabel}`
                            : durationLabel
                              ? `${durationLabel} · Estimating time...`
                              : "Transcribing audio..."}
                        </p>
                      </div>
                      <button
                        onClick={handleCancel}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700/50 text-zinc-300 text-xs font-semibold transition-all active:scale-[0.98]"
                      >
                        <X className="w-3.5 h-3.5" />
                        Cancel
                      </button>
                    </div>

                    {/* Progress Plume Indicator */}
                    <div className="relative z-10 flex flex-col gap-1.5 px-0.5 mt-1">
                      <div className="h-[4px] w-full bg-zinc-950 rounded-full relative overflow-visible shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
                        <div
                          className="h-full rounded-full transition-[width] duration-700 ease-out relative filter"
                          style={{
                            width: `${progressPct}%`,
                            background: 'linear-gradient(to right, rgba(0, 0, 0, 0) 0%, rgba(0, 122, 255, 0.05) 15%, rgba(0, 122, 255, 0.2) 35%, rgba(175, 82, 222, 0.5) 60%, rgba(255, 45, 85, 0.8) 85%, rgba(255, 149, 0, 0.95) 95%, #ffffff 100%)',
                            animation: 'rocketFire 0.4s ease-in-out infinite',
                          }}
                        />
                      </div>
                      <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5 font-mono">
                        <span>Step {currentStepIdx + 1} of {jobStepOrder.length}</span>
                        <span>{progressPct > 0 ? `${progressPct.toFixed(0)}%` : ""}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              // Non-running terminal active state card (done, error, cancelled)
              <div className="relative w-full rounded-[12px] p-[1px] bg-zinc-900 border border-zinc-850 p-4 flex flex-col gap-3">
                {jobStatus === "cancelled" && (
                  <div className="flex items-start gap-3 text-yellow-300">
                    <StopCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-semibold text-sm">Cancelled</p>
                      <p className="text-yellow-300/60 text-xs mt-0.5">Job was stopped by user.</p>
                    </div>
                  </div>
                )}

                {jobStatus === "error" && (
                  <div className="flex items-start gap-3 text-red-300">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-semibold text-sm">Failed</p>
                      <p className="text-red-300/70 text-xs mt-0.5">{jobError}</p>
                    </div>
                  </div>
                )}

                {jobStatus === "done" && (
                  <div className="flex flex-col gap-3.5">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="w-5 h-5 text-teal-400 shrink-0" />
                      <div className="flex-1">
                        <p className="text-teal-300 font-semibold text-sm">Subtitles generated successfully!</p>
                        <p className="text-white/40 text-xs mt-0.5">{entryCount} subtitle entries</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => downloadFile(srtContent!, srtFilename)}
                        className="bg-teal-600 hover:bg-teal-500 text-white rounded-xl px-5 shadow-[0_0_14px_rgba(20,184,166,0.3)] text-xs h-9"
                      >
                        <Download className="w-4 h-4 mr-2" />
                        {originalSrt ? `Download ${jobTranslateToRef.current}` : "Download SRT"}
                      </Button>
                      <Button
                        onClick={copyToClipboard}
                        variant="outline"
                        className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-4 text-xs h-9"
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
                            toast({ title: "Copy failed", variant: "destructive" });
                          }
                        }}
                        variant="outline"
                        className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-4 text-xs h-9"
                      >
                        {copiedText ? <Check className="w-4 h-4 mr-1.5 text-teal-400" /> : <AlignLeft className="w-4 h-4 mr-1.5" />}
                        {copiedText ? "Copied!" : "Copy Text Only"}
                      </Button>
                    </div>

                    {originalSrt && (
                      <div className="flex flex-wrap gap-2 border-t border-white/5 pt-3">
                        <Button
                          onClick={() => downloadFile(originalSrt, originalFilename ?? "original.srt")}
                          variant="outline"
                          className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-5 text-xs h-9"
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Download {sourceLangLabel}
                        </Button>
                        <Button
                          onClick={copyOriginalToClipboard}
                          variant="outline"
                          className="border-white/20 text-white/70 hover:text-white hover:bg-white/8 rounded-xl px-4 text-xs h-9"
                        >
                          {copiedOriginal ? <Check className="w-4 h-4 mr-1.5 text-teal-400" /> : <Copy className="w-4 h-4 mr-1.5" />}
                          {copiedOriginal ? "Copied!" : "Copy SRT"}
                        </Button>
                      </div>
                    )}

                    {srtContent && (
                      <div className="rounded-xl bg-black/30 border border-white/8 overflow-hidden mt-1">
                        <div className="flex items-center justify-between px-4 py-2 border-b border-white/8">
                          <p className="text-white/30 text-[10px] font-bold uppercase tracking-wider">
                            Preview · {Math.min(25, entryCount)} of {entryCount} entries
                          </p>
                        </div>
                        <div className="p-4 max-h-52 overflow-y-auto">
                          <pre className="text-xs text-white/50 whitespace-pre-wrap font-mono leading-relaxed select-all">
                            {srtContent.split("\n\n").filter(Boolean).slice(0, 25).join("\n\n")}
                            {entryCount > 25 && `\n\n... and ${entryCount - 25} more entries`}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2 border-t border-white/5 mt-1">
                  {(jobStatus === "error" || jobStatus === "cancelled") && (
                    <button
                      onClick={handleRetry}
                      className="flex items-center gap-1.5 text-xs font-semibold text-teal-400 hover:text-teal-300 transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Retry
                    </button>
                  )}
                  <button
                    onClick={reset}
                    className="text-xs font-semibold text-zinc-500 hover:text-zinc-300 transition-colors ml-auto"
                  >
                    Start over
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recent subtitles feed */}
      {!loading && history.length > 0 && (
        <div className="mt-4 w-full text-left">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-semibold text-white select-none">Recent subtitles</span>
            <button
              type="button"
              onClick={() => { clearHistory(); setHistory([]); }}
              className="text-xs font-semibold text-zinc-500 hover:text-red-400 transition-colors"
            >
              Clear all
            </button>
          </div>

          <div className="flex flex-col gap-2.5 w-full">
            {[...history]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((entry) => (
                <RecentSubtitleRow
                  key={entry.id}
                  entry={entry}
                  onDelete={() => setHistory(deleteFromHistory(entry.id))}
                  onDownload={() => downloadFile(entry.srt, entry.srtFilename)}
                  onCopy={() => {
                    navigator.clipboard.writeText(srtToText(entry.srt)).then(() => {
                      toast({ title: "Copied!", description: "Plain text subtitles copied to clipboard." });
                    }).catch(() => {});
                  }}
                />
              ))}
          </div>

          {/* View all subtitles link */}
          <div className="flex justify-center mt-4">
            <button
              type="button"
              className="text-xs text-teal-400 hover:text-teal-350 font-semibold transition flex items-center gap-1.5 cursor-pointer"
            >
              <span>View all subtitles</span>
              <span className="text-sm">→</span>
            </button>
          </div>
        </div>
      )}

      {/* Tips panel at the bottom */}
      {showTips && (
        <div className="flex items-center justify-between p-3 rounded-xl border border-teal-500/10 bg-teal-500/5 text-teal-400 text-xs w-full text-left mt-6 select-none">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-teal-400 shrink-0" />
            <span>For best results, use clear audio and high-quality videos.</span>
          </div>
          <button
            type="button"
            onClick={() => setShowTips(false)}
            className="p-1 rounded-full hover:bg-teal-500/10 text-teal-400/60 hover:text-teal-400 transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function RecentSubtitleRow({
  entry,
  onDelete,
  onDownload,
  onCopy,
}: {
  entry: SubtitleHistoryEntry;
  onDelete: () => void;
  onDownload: () => void;
  onCopy: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const videoId = entry.url ? extractVideoId(entry.url) : null;

  const getThumbnailUrl = () => {
    if (entry.id === "mock-bhagwat") {
      return "https://images.unsplash.com/photo-1579033461380-adb47c3eb938?auto=format&fit=crop&w=400&q=80"; // golden temple
    }
    if (entry.id === "mock-productivity") {
      return "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=400&q=80"; // mountain lake
    }
    if (videoId) {
      return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
    }
    // Default premium abstract wave image for file uploads
    return "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=400&q=80"; 
  };
  const thumbnailUrl = getThumbnailUrl();

  const sourceLang = LANGUAGES.find((l) => l.value === entry.language)?.label ?? entry.language;
  const targetLang = entry.translateTo !== "none"
    ? TRANSLATE_LANGUAGES.find((l) => l.value === entry.translateTo)?.label?.replace("Translate → ", "") ?? entry.translateTo
    : null;
  const displayLang = targetLang ? `${sourceLang} → ${targetLang}` : sourceLang;
  const cleanTitle = entry.srtFilename.replace(/\.srt$/i, "");
  const durationLabel = getSrtDuration(entry.srt);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 8 }}
      className="bg-[#09090b]/40 border border-zinc-900/80 rounded-xl px-4 py-3 flex items-center gap-4 relative hover:bg-white/[0.025] hover:border-zinc-800/80 transition-colors w-full text-left cursor-pointer"
      onClick={onDownload}
    >
      {/* Thumbnail Container */}
      <div className="relative h-[66px] w-[116px] shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/5 shadow-sm">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} className="h-full w-full object-cover" alt="Cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
            <FileText className="h-4.5 w-4.5 text-white/20" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      </div>

      {/* Info details */}
      <div className="flex-1 min-w-0">
        <p className="text-white/95 text-sm font-semibold truncate leading-snug">{cleanTitle}</p>
        <p className="text-zinc-400 text-xs mt-0.5 truncate">
          {displayLang} • SRT • {durationLabel} • {entry.entryCount} lines
        </p>
        <p className="text-zinc-500 text-[10px] mt-0.5 select-none">
          {formatRelativeTime(entry.createdAt)}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onDownload}
            title="Download SRT"
            className="p-2 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-teal-400 transition"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={onCopy}
            title="Copy text"
            className="p-2 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            title="Translate"
            className="p-2 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
          >
            <Languages className="w-4 h-4" />
          </button>
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(!menuOpen);
              }}
              className="p-2 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition"
            >
              <MoreVertical className="w-4 h-4" />
            </button>
            <AnimatePresence>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-25" onClick={() => setMenuOpen(false)} />
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 5 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 5 }}
                    transition={{ duration: 0.1 }}
                    className="absolute right-0 top-9 z-30 w-36 rounded-xl border border-zinc-800 bg-[#0d0d0d] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                  >
                    {entry.originalSrt && (
                      <button
                        type="button"
                        onClick={() => {
                          const blob = new Blob([entry.originalSrt!], { type: "text/plain;charset=utf-8" });
                          const a = document.createElement("a");
                          a.href = URL.createObjectURL(blob);
                          a.download = entry.originalFilename ?? "original.srt";
                          document.body.appendChild(a); a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(a.href);
                          setMenuOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition"
                      >
                        <FileText className="w-3.5 h-3.5" /> Original SRT
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        onDelete();
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-red-400/80 hover:bg-red-500/10 hover:text-red-400 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
