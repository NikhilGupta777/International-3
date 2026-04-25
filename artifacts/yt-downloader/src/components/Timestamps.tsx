import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlarmClock, CheckCircle2, AlertCircle, Loader2, Copy, Check,
  ChevronDown, ChevronUp, Sparkles, Clock, Link2, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

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
      "flex items-start gap-3 px-4 py-3 rounded-xl border transition-all duration-300",
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

export function Timestamps() {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const { copied, copy } = useClipboard();
  const sseRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [url, setUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const statusRef = useRef<"idle" | "running" | "done" | "error">("idle");
  const [steps, setSteps] = useState<Step[]>([]);
  const [result, setResult] = useState<JobResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isRunning = status === "running";
  const isDone = status === "done";
  const isError = status === "error";

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
    closeSSE();
    closePolling();
    statusRef.current = "done";
    setStatus("done");
    setResult({
      timestamps: data.timestamps ?? [],
      videoTitle: data.videoTitle ?? "",
      videoDuration: data.videoDuration ?? 0,
      hasTranscript: data.hasTranscript ?? false,
      transcriptSource: data.transcriptSource,
    });
    toast({
      title: "Timestamps ready!",
      description: `${data.timestamps?.length ?? 0} chapters generated`,
    });
  };

  const failWithMessage = (message: string) => {
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
    if (!url.trim() || isRunning) return;

    closeSSE();
    closePolling();
    statusRef.current = "running";
    setStatus("running");
    setResult(null);
    setError(null);
    // Show all 3 pipeline steps immediately so user sees progress from the first click
    setSteps([
      { name: "metadata",   status: "running", message: "Fetching video info..." },
      { name: "transcript", status: "idle",    message: "Waiting..." },
      { name: "ai",         status: "idle",    message: "Waiting..." },
    ]);

    let jobId: string;
    try {
      const res = await fetch(`${BASE}/api/youtube/timestamps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), instructions: instructions.trim() || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "Failed to start analysis");
      }
      const data = await res.json() as { jobId: string };
      jobId = data.jobId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start";
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

  const handleReset = () => {
    closeSSE();
    closePolling();
    setStatus("idle");
    setSteps([]);
    setResult(null);
    setError(null);
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
    <div className="w-full max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
          <AlarmClock className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-white">YouTube Timestamps</h2>
          <p className="text-sm text-white/50">AI-generated chapter markers from any video</p>
        </div>
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="space-y-3 mb-6">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={isRunning}
              className={cn(
                "w-full pl-9 pr-4 py-2.5 rounded-xl text-sm text-white placeholder-white/25",
                "bg-white/5 border border-white/10 focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/30",
                "transition-all duration-200 disabled:opacity-50",
              )}
            />
          </div>
          <Button
            type="submit"
            disabled={!url.trim() || isRunning}
            className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold px-5 rounded-xl shadow-lg shadow-indigo-500/20 disabled:opacity-40 shrink-0"
          >
            {isRunning ? (
              <><Loader2 className="w-4 h-4 animate-spin mr-2" />Analyzingâ€¦</>
            ) : (
              <><Sparkles className="w-4 h-4 mr-2" />Generate</>
            )}
          </Button>
        </div>

        {/* Custom instructions toggle */}
        <button
          type="button"
          onClick={() => setShowInstructions((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/60 transition-colors"
        >
          {showInstructions ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Custom instructions (optional)
        </button>

        <AnimatePresence>
          {showInstructions && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
            >
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="e.g. Focus on bhajans and main discourse topics. Skip short transitions."
                rows={3}
                disabled={isRunning}
                className={cn(
                  "w-full px-4 py-2.5 rounded-xl text-sm text-white placeholder-white/25 resize-none",
                  "bg-white/5 border border-white/10 focus:border-indigo-500/60 focus:outline-none focus:ring-1 focus:ring-indigo-500/30",
                  "transition-all duration-200 disabled:opacity-50",
                )}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </form>

      {/* Progress steps */}
      <AnimatePresence>
        {steps.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-2 mb-6"
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
            className="mb-6 p-4 rounded-xl border border-red-500/30 bg-red-500/10 flex gap-3"
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
            className="space-y-4"
          >
            {/* Video info bar */}
            {result.videoTitle && (
              <div className="px-4 py-3 rounded-xl border border-indigo-500/20 bg-indigo-500/8">
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
            <div className="glass-panel rounded-2xl border border-indigo-500/20 overflow-hidden">
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
            <div className="glass-panel rounded-2xl border border-violet-500/20 overflow-hidden">
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
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto">
                {telegramBlock}
              </pre>
            </div>

            {/* Plain-text block for YouTube description */}
            <div className="glass-panel rounded-2xl border border-white/8 overflow-hidden">
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
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto">
                {ytBlock}
              </pre>
            </div>

            {/* Generate again */}
            <div className="flex justify-center">
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
    </div>
  );
}

