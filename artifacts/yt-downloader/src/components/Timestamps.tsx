import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlarmClock, CheckCircle2, AlertCircle, Loader2, Copy, Check,
  ChevronDown, ChevronUp, Sparkles, Clock, Link2, Info, ArrowUp, MoreVertical, Trash2, Youtube
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  loadTimestampHistory,
  saveToTimestampHistory,
  deleteFromTimestampHistory,
  clearTimestampHistory,
  formatTimestampRelativeTime,
  TimestampHistoryEntry,
} from "@/lib/timestamps-history";

type TimestampEntry = { startSec: number; endSec?: number; label: string };

type StepStatus = "idle" | "running" | "done" | "warn";

type Step = {
  name: string;
  status: StepStatus;
  message: string;
};

type JobResult = {
  timestamps: TimestampEntry[];
  videoTitle: string;
  videoDuration: number;
  hasTranscript: boolean;
  transcriptSource?: "youtube" | "assemblyai" | "chapters";
};

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatRange(ts: TimestampEntry, next: TimestampEntry | undefined, videoDuration: number): string {
  const end = ts.endSec ?? next?.startSec ?? videoDuration;
  return `${formatTime(ts.startSec)} - ${formatTime(end)}`;
}

function buildYtDescriptionBlock(timestamps: TimestampEntry[]): string {
  return timestamps.map((t) => `${formatTime(t.startSec)} ${t.label}`).join("\n");
}

function buildTelegramBlock(timestamps: TimestampEntry[], videoDuration: number): string {
  return timestamps.map((t, i) => {
    const range = formatRange(t, timestamps[i + 1], videoDuration);
    return `${i + 1}. ${t.label}\nTIME STAMP ${range}`;
  }).join("\n\n");
}

function useClipboard(timeout = 1800) {
  const [copied, setCopied] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setCopied(key);
      timerRef.current = setTimeout(() => setCopied(null), timeout);
    }).catch(() => {});
  };
  return { copied, copy };
}

function StepRow({ step }: { step: Step }) {
  const icon =
    step.status === "running" ? <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" /> :
    step.status === "done"    ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> :
    step.status === "warn"    ? <AlertCircle className="w-4 h-4 text-amber-400" /> :
                                <Clock className="w-4 h-4 text-white/20" />;

  const stepLabel: Record<string, string> = {
    metadata: "Video Info",
    transcript: "Transcript",
    ai: "AI Generation",
  };

  return (
    <div className={cn(
      "flex items-start gap-3 px-4 py-3 rounded-xl border transition-all duration-300 w-full text-left",
      step.status === "running" ? "border-indigo-500/40 bg-indigo-500/8" :
      step.status === "done"    ? "border-emerald-500/20 bg-emerald-500/5" :
      step.status === "warn"    ? "border-amber-500/20 bg-amber-500/5" :
                                  "border-white/5 bg-white/2",
    )}>
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-0.5">
          {stepLabel[step.name] ?? step.name}
        </div>
        <div className="text-sm text-white/80 leading-relaxed">{step.message}</div>
      </div>
    </div>
  );
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

function formatDurationLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function Timestamps() {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const { copied, copy } = useClipboard();
  const sseRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [command, setCommand] = useState("");
  const [instructions, setInstructions] = useState("");
  const [showInstructions, setShowInstructions] = useState(true); // Expanded by default to match mockup
  const [showHelper, setShowHelper] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const statusRef = useRef<"idle" | "running" | "done" | "error">("idle");
  const [steps, setSteps] = useState<Step[]>([]);
  const [result, setResult] = useState<JobResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Load local timestamps history and seed mock data if empty
  const [history, setHistory] = useState<TimestampHistoryEntry[]>(() => {
    const loaded = loadTimestampHistory();
    if (loaded.length === 0) {
      const mockEntries: TimestampHistoryEntry[] = [
        {
          id: "mock-productivity",
          createdAt: Date.now() - 2 * 3600 * 1000, // 2 hours ago
          videoTitle: "Productivity Tips for Creators",
          videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          chapterCount: 16,
          videoDurationSecs: 165, // 2m 45s
          timestamps: [
            { startSec: 0, label: "Introduction" },
            { startSec: 10, label: "Planning your workflow" },
            { startSec: 25, label: "Time blocking techniques" },
          ],
        },
        {
          id: "mock-ramcharitmanas",
          createdAt: Date.now() - 24 * 3600 * 1000, // 1 day ago
          videoTitle: "Sri Ram Charit Manas – Bal Kand",
          videoUrl: "https://www.youtube.com/watch?v=yG8t4qH9JqY",
          chapterCount: 23,
          videoDurationSecs: 192, // 3m 12s
          timestamps: [
            { startSec: 0, label: "मंगलाचरण / Invocation" },
            { startSec: 15, label: "गुरु वंदना / Guru Vandana" },
            { startSec: 35, label: "ब्राह्मण वंदना / Brahmana Vandana" },
          ],
        },
      ];
      mockEntries.forEach(saveToTimestampHistory);
      return mockEntries;
    }
    return loaded;
  });

  const jobIdRef = useRef<string | null>(null);
  const urlRef = useRef<string>("");

  const isRunning = status === "running";
  const isDone = status === "done";
  const isError = status === "error";

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const sh = textarea.scrollHeight;
    if (sh > 45) {
      textarea.style.height = `${Math.min(72, sh)}px`;
    }
  }, [command]);

  const updateStep = (name: string, stepStatus: StepStatus, message: string) => {
    setSteps((prev) => {
      const existing = prev.findIndex((s) => s.name === name);
      const updated = { name, status: stepStatus, message };
      if (existing === -1) return [...prev, updated];
      const next = [...prev];
      next[existing] = updated;
      return next;
    });
  };

  const closeSSE = () => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
  };

  const closePolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const finishWithResult = (data: Partial<JobResult>) => {
    if (statusRef.current !== "running") return; // guard against double-finish
    closeSSE();
    closePolling();
    statusRef.current = "done";
    setStatus("done");
    
    const timestamps = data.timestamps ?? [];
    const videoTitle = data.videoTitle ?? "";
    const videoDuration = data.videoDuration ?? 0;
    
    setResult({
      timestamps,
      videoTitle,
      videoDuration,
      hasTranscript: data.hasTranscript ?? false,
      transcriptSource: data.transcriptSource,
    });

    // Save to history
    const historyEntry: TimestampHistoryEntry = {
      id: jobIdRef.current ?? String(Date.now()),
      createdAt: Date.now(),
      videoTitle,
      videoUrl: urlRef.current || "",
      chapterCount: timestamps.length,
      videoDurationSecs: videoDuration,
      timestamps,
    };
    saveToTimestampHistory(historyEntry);
    setHistory(loadTimestampHistory());

    toast({
      title: "Timestamps ready!",
      description: `${timestamps.length} chapters generated`,
    });
  };

  const failWithMessage = (message: string) => {
    if (statusRef.current !== "running") return; // guard against double-finish
    closeSSE();
    closePolling();
    statusRef.current = "error";
    setStatus("error");
    setError(message);
    toast({ title: "Error", description: message, variant: "destructive" });
  };

  const startPolling = (jobId: string) => {
    if (pollRef.current) return;
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}/api/youtube/timestamps/status/${encodeURIComponent(jobId)}`);
        const data = await res.json().catch(() => ({})) as Partial<JobResult> & {
          status?: string;
          message?: string;
          progressPct?: number;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "Failed to fetch status");
        if (data.status === "done") {
          finishWithResult(data);
          return;
        }
        if (data.status === "error" || data.status === "cancelled") {
          failWithMessage(data.error ?? data.message ?? "Analysis failed");
          return;
        }
        const pct = data.progressPct ?? 0;
        const stepName = pct >= 55 ? "ai" : pct >= 20 ? "transcript" : "metadata";
        updateStep(stepName, "running", data.message ?? "Processing...");
      } catch (err) {
        if (statusRef.current === "running") {
          updateStep("metadata", "warn", err instanceof Error ? err.message : "Waiting for server status...");
        }
      }
    };
    void poll();
    pollRef.current = setInterval(() => { void poll(); }, 3000);
  };

  // Close any open SSE connection when the component unmounts (e.g. tab change)
  useEffect(() => {
    return () => {
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
      closePolling();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim() || isRunning) return;

    const { url: parsedUrl, description } = parseCombinedInput(command);
    if (!parsedUrl) {
      toast({
        title: "Invalid URL",
        description: "Please enter a valid YouTube URL.",
        variant: "destructive",
      });
      return;
    }

    closeSSE();
    closePolling();
    statusRef.current = "running";
    setStatus("running");
    setResult(null);
    setError(null);
    setSteps([
      { name: "metadata",   status: "running", message: "Fetching video info..." },
      { name: "transcript", status: "idle",    message: "Waiting..." },
      { name: "ai",         status: "idle",    message: "Waiting..." },
    ]);

    const finalInstructions = [description, instructions].filter(Boolean).join("\n");
    urlRef.current = parsedUrl;

    let jobId: string;
    try {
      const res = await fetch(`${BASE}/api/youtube/timestamps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: parsedUrl,
          instructions: finalInstructions.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "Failed to start analysis");
      }
      const data = await res.json() as { jobId: string };
      jobId = data.jobId;
      jobIdRef.current = jobId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start";
      statusRef.current = "error";
      setStatus("error");
      setError(msg);
      toast({ title: "Error", description: msg, variant: "destructive" });
      return;
    }

    const sse = new EventSource(`${BASE}/api/youtube/timestamps/stream/${encodeURIComponent(jobId)}`);
    sseRef.current = sse;

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string;
          step?: string;
          status?: string;
          message?: string;
          timestamps?: TimestampEntry[];
          videoTitle?: string;
          videoDuration?: number;
          hasTranscript?: boolean;
          transcriptSource?: "youtube" | "assemblyai" | "chapters";
        };

        if (data.type === "step" && data.step) {
          updateStep(data.step, (data.status as StepStatus) ?? "running", data.message ?? "");
        } else if (data.type === "done") {
          finishWithResult(data);
        } else if (data.type === "error") {
          failWithMessage(data.message ?? "Analysis failed");
        }
      } catch {}
    };

    sse.onerror = () => {
      closeSSE();
      if (statusRef.current !== "done" && statusRef.current !== "error") {
        updateStep("metadata", "warn", "Live connection dropped; checking status...");
        startPolling(jobId);
      }
    };
  };

  const handleSelectHistoryEntry = (entry: TimestampHistoryEntry) => {
    if (entry.timestamps && entry.timestamps.length > 0) {
      setResult({
        timestamps: entry.timestamps,
        videoTitle: entry.videoTitle,
        videoDuration: entry.videoDurationSecs,
        hasTranscript: true,
      });
      setStatus("done");
      setCommand(entry.videoUrl);
      return;
    }

    // Fallback: poll server status
    setStatus("running");
    setResult(null);
    setError(null);
    setSteps([
      { name: "metadata",   status: "running", message: "Fetching video info..." },
      { name: "transcript", status: "idle",    message: "Waiting..." },
      { name: "ai",         status: "idle",    message: "Waiting..." },
    ]);
    
    urlRef.current = entry.videoUrl;
    jobIdRef.current = entry.id;

    const sse = new EventSource(`${BASE}/api/youtube/timestamps/stream/${encodeURIComponent(entry.id)}`);
    sseRef.current = sse;

    sse.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string;
          step?: string;
          status?: string;
          message?: string;
          timestamps?: TimestampEntry[];
          videoTitle?: string;
          videoDuration?: number;
          hasTranscript?: boolean;
          transcriptSource?: "youtube" | "assemblyai" | "chapters";
        };

        if (data.type === "step" && data.step) {
          updateStep(data.step, (data.status as StepStatus) ?? "running", data.message ?? "");
        } else if (data.type === "done") {
          finishWithResult(data);
        } else if (data.type === "error") {
          // If SSE fails with job not found, fall back to setting input URL
          setCommand(entry.videoUrl);
          setStatus("idle");
          toast({
            title: "Job data expired on server",
            description: "Populated URL so you can generate it again.",
          });
        }
      } catch {}
    };

    sse.onerror = () => {
      closeSSE();
      if (statusRef.current !== "done" && statusRef.current !== "error") {
        startPolling(entry.id);
      }
    };
  };

  const handleReset = () => {
    closeSSE();
    closePolling();
    setStatus("idle");
    setSteps([]);
    setResult(null);
    setError(null);
    setCommand("");
  };

  const ytBlock = result ? buildYtDescriptionBlock(result.timestamps) : "";
  const telegramBlock = result ? buildTelegramBlock(result.timestamps, result.videoDuration) : "";

  const transcriptSourceLabel =
    result?.transcriptSource === "assemblyai"
      ? "AssemblyAI transcription"
      : result?.transcriptSource === "chapters"
        ? "existing chapter markers"
        : result?.transcriptSource === "youtube"
          ? "YouTube subtitles"
          : null;

  return (
    <div className="max-w-3xl mx-auto w-full text-left flex flex-col gap-6 px-4 py-8 md:py-12">
      {/* Header */}
      <div className="flex flex-col items-start text-left mb-2">
        <h1 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
          YouTube Timestamps
        </h1>
        <p className="mt-3 text-base text-zinc-400 leading-relaxed">
          Generate clean chapter markers from any YouTube video <br className="hidden sm:inline" />
          with AI precision.
        </p>
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="space-y-4 w-full">
        <div className="relative w-full rounded-2xl border border-zinc-800/80 bg-[#09090b]/80 backdrop-blur-md py-3 px-4 shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
          <div className="flex items-center gap-3">
            <Link2 className="h-5 w-5 text-zinc-500 shrink-0" />
            <textarea
              ref={textareaRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={isRunning}
              placeholder="Paste YouTube URL and describe the timestamps you want..."
              className="min-h-[24px] h-6 flex-1 resize-none bg-transparent py-1 text-sm text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSubmit(e);
                }
              }}
            />
            {/* Clickable i icon */}
            <button
              type="button"
              onClick={() => setShowHelper(!showHelper)}
              className="p-1.5 rounded-full hover:bg-white/5 text-zinc-400 hover:text-white transition shrink-0"
              title="Help info"
            >
              <Info className="h-5 w-5" />
            </button>
            {/* Submit arrow button inside the input area */}
            <button
              disabled={isRunning || !command.trim()}
              type="submit"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-800 hover:bg-zinc-700 text-white disabled:bg-zinc-900/50 disabled:text-zinc-600 disabled:border-zinc-800/40 border border-zinc-700/30 transition shadow-sm"
            >
              {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Helper Preview Card (opens relative to input field) */}
        <AnimatePresence>
          {showHelper && (
            <>
              {/* Overlay backdrop to close */}
              <div className="fixed inset-0 z-40" onClick={() => setShowHelper(false)} />
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                className="absolute right-0 top-16 z-50 w-80 rounded-2xl border border-zinc-800 bg-[#0d0d0d] p-4 shadow-[0_12px_40px_rgba(0,0,0,0.65)] flex flex-col gap-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">How to use</span>
                  <button onClick={() => setShowHelper(false)} className="text-zinc-500 hover:text-zinc-300 text-xs">Close</button>
                </div>
                <div className="text-xs text-zinc-400 space-y-2 leading-relaxed text-left">
                  <p>Paste a YouTube URL and specify guidelines, or leave it blank for auto chapters.</p>
                  <div className="bg-white/5 p-2 rounded-lg border border-white/5 font-mono text-[10px] select-all">
                    https://youtube.com/watch?... Focus on the katha and skip bhajans.
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Custom instructions toggle card */}
        <div className="border border-zinc-900/80 bg-[#09090b]/40 backdrop-blur-md rounded-2xl p-4.5 w-full text-left">
          <button
            type="button"
            onClick={() => setShowInstructions((v) => !v)}
            className="flex items-center justify-between w-full text-sm font-semibold text-zinc-400 hover:text-zinc-300 transition-colors"
          >
            <span>Custom instructions (optional)</span>
            <ChevronDown className={cn("w-4 h-4 text-zinc-500 transition-transform duration-200", showInstructions && "rotate-180")} />
          </button>

          <AnimatePresence>
            {showInstructions && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginTop: 0 }}
                animate={{ opacity: 1, height: "auto", marginTop: 12 }}
                exit={{ opacity: 0, height: 0, marginTop: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g. Focus on bhajans and main discourse topics. Skip short transitions."
                  rows={3}
                  disabled={isRunning}
                  className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder:text-zinc-600 bg-black/30 border border-zinc-900 focus:border-zinc-800 focus:outline-none focus:ring-1 focus:ring-zinc-800 transition-all duration-200 disabled:opacity-50 resize-none mt-3"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </form>

      {/* Progress steps */}
      <AnimatePresence>
        {steps.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-2 w-full"
          >
            {steps.map((step) => (
              <StepRow key={step.name} step={step} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error state */}
      <AnimatePresence>
        {isError && error && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="w-full p-4 rounded-xl border border-red-500/30 bg-red-500/10 flex gap-3 text-left"
          >
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-red-200 leading-relaxed">{error}</p>
              <button onClick={handleReset} className="mt-2 text-xs text-red-400 hover:text-red-300 underline">
                Try again
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      <AnimatePresence>
        {isDone && result && result.timestamps.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="space-y-4 w-full text-left"
          >
            {/* Video info bar */}
            {result.videoTitle && (
              <div className="px-4 py-3 rounded-xl border border-indigo-500/20 bg-indigo-500/8 w-full">
                <p className="text-sm font-semibold text-white/90 leading-snug">{result.videoTitle}</p>
                <div className="flex items-center gap-3 mt-1">
                  {result.videoDuration > 0 && (
                    <span className="text-xs text-white/40">
                      <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />
                      {formatTime(result.videoDuration)}
                    </span>
                  )}
                  <span className="text-xs text-white/40">
                    {result.timestamps.length} chapters
                  </span>
                  {transcriptSourceLabel && (
                    <span className="text-xs text-indigo-300/60">
                      <Info className="w-3 h-3 inline mr-1 -mt-0.5" />
                      via {transcriptSourceLabel}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Copy all block */}
            <div className="glass-panel rounded-2xl border border-indigo-500/20 overflow-hidden w-full">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-xs font-semibold text-white/60 uppercase tracking-widest">
                  YouTube Chapter Timestamps
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => copy(telegramBlock, "all")}
                  className={cn(
                    "h-7 px-3 text-xs font-medium rounded-lg transition-all duration-200",
                    copied === "all"
                      ? "bg-emerald-600 text-white"
                      : "bg-indigo-600/60 hover:bg-indigo-600 text-white",
                  )}
                >
                  {copied === "all" ? (
                    <><Check className="w-3.5 h-3.5 mr-1.5" />Copied!</>
                  ) : (
                    <><Copy className="w-3.5 h-3.5 mr-1.5" />Copy All</>
                  )}
                </Button>
              </div>

              {/* Timestamp list */}
              <div className="divide-y divide-white/5">
                {result.timestamps.map((ts, i) => {
                  const range = formatRange(ts, result.timestamps[i + 1], result.videoDuration);
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.025, duration: 0.25 }}
                      className="flex items-start gap-3 px-4 py-3 group hover:bg-white/3 transition-colors"
                    >
                      {/* Index */}
                      <span className="font-mono text-xs font-bold text-indigo-400/50 shrink-0 w-5 text-right pt-1">
                        {i + 1}
                      </span>
                      {/* Time range: start on top, end below */}
                      <div className="shrink-0 text-right min-w-[3.5rem]">
                        <span className="font-mono text-xs font-bold text-indigo-400 block">{formatTime(ts.startSec)}</span>
                        <span className="font-mono text-[10px] text-indigo-400/45 block leading-tight">
                          {range.split(" - ")[1]}
                        </span>
                      </div>
                      {/* Label */}
                      <span className="flex-1 text-sm text-white/85 min-w-0 leading-snug">
                        {ts.label}
                      </span>
                      {/* Copy single row (Telegram format) */}
                      <button
                        onClick={() => copy(`${i + 1}. ${ts.label}\nTIME STAMP ${range}`, `row-${i}`)}
                        className={cn(
                          "shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-150",
                          copied === `row-${i}`
                            ? "bg-emerald-600/30 text-emerald-400 opacity-100"
                            : "bg-white/5 text-white/40 hover:text-white/80",
                        )}
                        title="Copy this timestamp"
                      >
                        {copied === `row-${i}` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </motion.div>
                  );
                })}
              </div>
            </div>

            {/* Telegram-style numbered range block */}
            <div className="glass-panel rounded-2xl border border-violet-500/20 overflow-hidden w-full">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-xs font-semibold text-violet-300/70 uppercase tracking-widest">
                  Telegram Format (numbered + ranges)
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => copy(telegramBlock, "telegram")}
                  className={cn(
                    "h-7 px-3 text-xs font-medium rounded-lg transition-all duration-200",
                    copied === "telegram"
                      ? "bg-emerald-600 text-white"
                      : "bg-violet-600/40 hover:bg-violet-600/70 text-white/70",
                  )}
                >
                  {copied === "telegram" ? <><Check className="w-3.5 h-3.5 mr-1.5" />Copied!</> : <><Copy className="w-3.5 h-3.5 mr-1.5" />Copy</>}
                </Button>
              </div>
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto w-full">
                {telegramBlock}
              </pre>
            </div>

            {/* Plain-text block for YouTube description */}
            <div className="glass-panel rounded-2xl border border-white/8 overflow-hidden w-full">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                  YouTube Description Format
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => copy(ytBlock, "text")}
                  className={cn(
                    "h-7 px-3 text-xs font-medium rounded-lg transition-all duration-200",
                    copied === "text"
                      ? "bg-emerald-600 text-white"
                      : "bg-white/8 hover:bg-white/15 text-white/60",
                  )}
                >
                  {copied === "text" ? <><Check className="w-3.5 h-3.5 mr-1.5" />Copied!</> : <><Copy className="w-3.5 h-3.5 mr-1.5" />Copy</>}
                </Button>
              </div>
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto w-full">
                {ytBlock}
              </pre>
            </div>

            {/* Generate again */}
            <div className="flex justify-center w-full">
              <button
                onClick={handleReset}
                className="text-xs text-white/30 hover:text-white/60 transition-colors underline"
              >
                Analyze another video
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recent timestamp sets */}
      {status === "idle" && history.length > 0 && (
        <div className="mt-6 w-full text-left">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-semibold text-white">Recent timestamp sets</span>
          </div>

          <div className="flex flex-col gap-2.5 w-full">
            {[...history]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((entry) => (
                <RecentTimestampRow
                  key={entry.id}
                  entry={entry}
                  onSelect={() => handleSelectHistoryEntry(entry)}
                  onDelete={() => setHistory(deleteFromTimestampHistory(entry.id))}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecentTimestampRow({
  entry,
  onSelect,
  onDelete,
}: {
  entry: TimestampHistoryEntry;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const videoId = extractVideoId(entry.videoUrl);

  const getThumbnailUrl = () => {
    if (entry.id === "mock-productivity") {
      return "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=400&q=80";
    }
    if (entry.id === "mock-ramcharitmanas") {
      return "https://images.unsplash.com/photo-1579033461380-adb47c3eb938?auto=format&fit=crop&w=400&q=80";
    }
    return videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;
  };
  const thumbnailUrl = getThumbnailUrl();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 8 }}
      onClick={onSelect}
      className="bg-[#09090b]/30 border border-zinc-900/80 rounded-2xl px-4 py-3.5 flex items-center gap-4 relative cursor-pointer hover:bg-white/[0.02] transition-colors w-full text-left"
    >
      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/5">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            className="h-full w-full object-cover"
            alt="Thumbnail"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
            <Youtube className="h-4 w-4 text-white/20" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-white/95 text-sm font-semibold truncate leading-snug">{entry.videoTitle}</p>
        <p className="text-zinc-400 text-xs mt-1 truncate">
          {entry.chapterCount} chapters • {formatDurationLabel(entry.videoDurationSecs)} total
        </p>
      </div>

      <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs text-zinc-500 mr-2 sm:mr-4">
          {formatTimestampRelativeTime(entry.createdAt)}
        </span>
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-white transition-colors"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 5 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 5 }}
                  transition={{ duration: 0.1 }}
                  className="absolute right-0 top-9 z-30 w-32 rounded-xl border border-zinc-800 bg-[#0d0d0d] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition"
                  >
                    <Clock className="w-3.5 h-3.5" /> View
                  </button>
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
    </motion.div>
  );
}
