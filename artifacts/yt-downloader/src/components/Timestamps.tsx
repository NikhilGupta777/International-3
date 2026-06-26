import { useEffect, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlarmClock, CheckCircle2, AlertCircle, Loader2, Copy, Check,
  ChevronDown, ChevronUp, Sparkles, Clock, Link2, Info, ArrowUp, MoreVertical, Trash2, Youtube, X, Download, RefreshCw
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

interface ActiveTimestampJob {
  jobId: string;
  url: string;
  instructions?: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  percent: number;
  message: string;
  error?: string | null;
  result?: JobResult | null;
  startedAt: number;
  videoTitle?: string;
}

const ACTIVE_JOBS_KEY = "ytgrabber_active_timestamps_jobs";
const HISTORY_PAGE_SIZE = 7;

function loadActiveTimestampJobs(): ActiveTimestampJob[] {
  try {
    const raw = localStorage.getItem(ACTIVE_JOBS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ActiveTimestampJob[];
  } catch {
    return [];
  }
}

function saveActiveTimestampJobs(jobs: ActiveTimestampJob[]): void {
  try {
    localStorage.setItem(ACTIVE_JOBS_KEY, JSON.stringify(jobs));
  } catch {}
}

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

// StepRow has been removed since the unified TimestampJobCard is used instead

function extractVideoId(url: string) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:live\/|shorts\/|[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function normalizeYouTubeInputUrl(url: string): string {
  const videoId = extractVideoId(url);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
}

function parseCombinedInput(input: string) {
  const urlRegex = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:live\/|shorts\/|[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)[a-zA-Z0-9_-]{11}(?:\S+)?)/i;
  const match = input.match(urlRegex);
  if (!match) return { url: "", description: input.trim() };
  
  const rawUrl = match[1];
  const url = normalizeYouTubeInputUrl(rawUrl);
  const description = input.replace(rawUrl, "").replace(/\s+/g, " ").trim();
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

function replaceTimestampsPath(jobId?: string | null) {
  if (typeof window === "undefined") return;
  try {
    window.history.replaceState(
      null,
      "",
      jobId ? `/timestamps/job/${encodeURIComponent(jobId)}` : "/timestamps",
    );
  } catch { /* ignore */ }
}

export function Timestamps({ initialJobId = null }: { initialJobId?: string | null }) {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const { copied, copy } = useClipboard();
  const [command, setCommand] = useState("");
  const [instructions, setInstructions] = useState("");
  const [showInstructions, setShowInstructions] = useState(true); // Expanded by default to match mockup
  const [showHelper, setShowHelper] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ActiveTimestampJob[]>(() => loadActiveTimestampJobs());
  const [viewingJob, setViewingJob] = useState<ActiveTimestampJob | null>(null);

  const streamRefs = useRef<Map<string, EventSource>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  const jobsRef = useRef<ActiveTimestampJob[]>([]);
  jobsRef.current = jobs;

  const persistActiveJobs = useCallback((current: ActiveTimestampJob[]) => {
    saveActiveTimestampJobs(current);
  }, []);

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
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);

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

  const closeJobStream = useCallback((jobId: string) => {
    const stream = streamRefs.current.get(jobId);
    if (stream) {
      stream.close();
      streamRefs.current.delete(jobId);
    }
  }, []);

  const applyProgressUpdate = useCallback(
    (jobId: string, data: any) => {
      let historyEntry: TimestampHistoryEntry | null = null;

      setJobs((prev) => {
        const updated = prev.map((j) => {
          if (j.jobId !== jobId) return j;

          // Determine next status
          let nextStatus = j.status;
          if (data.type === "done" || (data.type !== "step" && data.status === "done")) {
            nextStatus = "done";
          } else if (data.type === "error" || (data.type !== "step" && data.status === "error")) {
            nextStatus = "error";
          } else if (data.status === "cancelled" || data.type === "cancelled") {
            nextStatus = "cancelled";
          } else if (data.status === "running" || data.type === "step") {
            nextStatus = "running";
          }

          // Calculate percent
          let percent = typeof data.progressPct === "number" ? data.progressPct : j.percent;
          if (data.type === "step" && data.step) {
            if (data.step === "metadata") percent = 15;
            else if (data.step === "transcript") percent = 45;
            else if (data.step === "ai") percent = 75;
          }
          if (nextStatus === "done") {
            percent = 100;
          }

          const message = data.message ?? j.message;
          const errorMsg = data.error ?? (nextStatus === "error" ? (data.message ?? "Analysis failed") : null);

          let resultData = j.result;
          if (nextStatus === "done") {
            resultData = {
              timestamps: data.timestamps ?? j.result?.timestamps ?? [],
              videoTitle: data.videoTitle ?? j.result?.videoTitle ?? j.videoTitle ?? "",
              videoDuration: data.videoDuration ?? j.result?.videoDuration ?? 0,
              hasTranscript: data.hasTranscript ?? j.result?.hasTranscript ?? false,
              transcriptSource: data.transcriptSource ?? j.result?.transcriptSource,
            };
          }

          const nextJob: ActiveTimestampJob = {
            ...j,
            status: nextStatus,
            percent,
            message,
            error: errorMsg,
            result: resultData,
            videoTitle: data.videoTitle ?? j.videoTitle,
          };

          // Save to history once we receive actual timestamps
          if (nextStatus === "done" && data.timestamps && data.timestamps.length > 0) {
            historyEntry = {
              id: j.jobId,
              createdAt: Date.now(),
              videoTitle: data.videoTitle ?? j.videoTitle ?? "YouTube Video",
              videoUrl: j.url,
              chapterCount: data.timestamps.length,
              videoDurationSecs: data.videoDuration ?? 0,
              timestamps: data.timestamps,
            };
          }

          return nextJob;
        });

        persistActiveJobs(updated);
        return updated;
      });

      if (historyEntry) {
        saveToTimestampHistory(historyEntry);
        setHistory(loadTimestampHistory());
        toast({
          title: "Timestamps ready!",
          description: `${(data.timestamps ?? []).length} chapters generated`,
        });
      }
    },
    [persistActiveJobs, toast]
  );

  const markJobLost = useCallback(
    (jobId: string, message: string) => {
      setJobs((prev) => {
        const updated = prev.map((j) =>
          j.jobId !== jobId
            ? j
            : {
                ...j,
                status: "error" as const,
                message,
                error: message,
              }
        );
        persistActiveJobs(updated);
        return updated;
      });
    },
    [persistActiveJobs]
  );

  const refreshJobStatusOnce = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`${BASE}/api/youtube/timestamps/status/${encodeURIComponent(jobId)}`);
        if (res.status === 404) {
          const current = jobsRef.current.find((j) => j.jobId === jobId);
          if (current && Date.now() - current.startedAt < 15 * 60 * 1000) {
            return;
          }
          markJobLost(jobId, "Server restarted — job was lost. Please retry.");
          return;
        }
        if (!res.ok) {
          throw new Error(`Status check failed (${res.status})`);
        }
        const data = await res.json();
        applyProgressUpdate(jobId, data);
      } catch (err) {
        setJobs((prev) =>
          prev.map((j) =>
            j.jobId !== jobId || j.status === "done" || j.status === "error" || j.status === "cancelled"
              ? j
              : {
                  ...j,
                  message: "Connection issue — retrying...",
                }
          )
        );
      }
    },
    [BASE, applyProgressUpdate, markJobLost]
  );

  const handleCancelJob = useCallback(
    (jobId: string) => {
      closeJobStream(jobId);
      setJobs((prev) => {
        const updated = prev.map((j) =>
          j.jobId !== jobId
            ? j
            : {
                ...j,
                status: "cancelled" as const,
                message: "Cancelled by user",
              }
        );
        persistActiveJobs(updated);
        return updated;
      });
    },
    [closeJobStream, persistActiveJobs]
  );

  const handleDismissJob = useCallback(
    (jobId: string) => {
      closeJobStream(jobId);
      setJobs((prev) => {
        const updated = prev.filter((j) => j.jobId !== jobId);
        persistActiveJobs(updated);
        return updated;
      });
      if (viewingJob?.jobId === jobId) {
        setViewingJob(null);
      }
    },
    [closeJobStream, persistActiveJobs, viewingJob]
  );

  // Polling loop for active jobs (backup in case EventSource is missing or drops)
  useEffect(() => {
    if (typeof EventSource !== "undefined") return;
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const active = jobsRef.current.filter(
          (j) => j.status === "pending" || j.status === "running"
        );
        if (active.length === 0) return;

        for (const job of active) {
          await refreshJobStatusOnce(job.jobId);
        }
      } finally {
        pollInFlightRef.current = false;
      }
    }, 4000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [refreshJobStatusOnce]);

  // SSE connection effect
  const activeJobIds = jobs
    .filter((j) => j.status === "pending" || j.status === "running")
    .map((j) => j.jobId)
    .sort()
    .join(",");

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const activeJobs = jobs.filter(
      (j) => j.status === "pending" || j.status === "running"
    );
    const activeIds = new Set(activeJobs.map((j) => j.jobId));

    // Close dropped streams
    for (const jobId of Array.from(streamRefs.current.keys())) {
      if (!activeIds.has(jobId)) {
        closeJobStream(jobId);
      }
    }

    // Connect to new streams
    for (const job of activeJobs) {
      if (streamRefs.current.has(job.jobId)) continue;

      const stream = new EventSource(
        `${BASE}/api/youtube/timestamps/stream/${encodeURIComponent(job.jobId)}`
      );
      streamRefs.current.set(job.jobId, stream);

      stream.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          applyProgressUpdate(job.jobId, data);

          if (data.type === "done" || data.type === "error") {
            closeJobStream(job.jobId);
          }
        } catch {}
      };

      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED) {
          closeJobStream(job.jobId);
          void refreshJobStatusOnce(job.jobId);
          return;
        }

        setJobs((prev) =>
          prev.map((j) =>
            j.jobId !== job.jobId || j.status === "done" || j.status === "error" || j.status === "cancelled"
              ? j
              : {
                  ...j,
                  message: "Connection issue — reconnecting...",
                }
          )
        );
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobIds, applyProgressUpdate, closeJobStream, refreshJobStatusOnce]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      for (const stream of streamRefs.current.values()) {
        stream.close();
      }
      streamRefs.current.clear();
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim() || submitting) return;

    const { url: parsedUrl, description } = parseCombinedInput(command);
    if (!parsedUrl) {
      toast({
        title: "Invalid URL",
        description: "Please enter a valid YouTube URL.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    const finalInstructions = [description, instructions].filter(Boolean).join("\n");
    const videoTitle = "Analyzing Video...";

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

      const newJob: ActiveTimestampJob = {
        jobId: data.jobId,
        url: parsedUrl,
        instructions: finalInstructions.trim() || undefined,
        status: "pending",
        percent: 5,
        message: "Queued for analysis...",
        startedAt: Date.now(),
        videoTitle,
      };

      setJobs((prev) => {
        const updated = [newJob, ...prev];
        persistActiveJobs(updated);
        return updated;
      });

      setCommand("");
      setInstructions("");

      toast({
        title: "Job submitted",
        description: "Video is now queuing in the background.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectHistoryEntry = (entry: TimestampHistoryEntry) => {
    replaceTimestampsPath(entry.id);
    if (entry.timestamps && entry.timestamps.length > 0) {
      setViewingJob({
        jobId: entry.id,
        url: entry.videoUrl,
        status: "done",
        percent: 100,
        message: "Completed",
        startedAt: entry.createdAt,
        videoTitle: entry.videoTitle,
        result: {
          timestamps: entry.timestamps,
          videoTitle: entry.videoTitle,
          videoDuration: entry.videoDurationSecs,
          hasTranscript: true,
        },
      });
    } else {
      // Fallback: poll server status
      const newJob: ActiveTimestampJob = {
        jobId: entry.id,
        url: entry.videoUrl,
        status: "pending",
        percent: 5,
        message: "Restoring status...",
        startedAt: entry.createdAt,
        videoTitle: entry.videoTitle,
      };

      setJobs((prev) => {
        if (prev.some((j) => j.jobId === entry.id)) return prev;
        const updated = [newJob, ...prev];
        persistActiveJobs(updated);
        return updated;
      });

      toast({
        title: "Restoring job",
        description: "Checking job status on server...",
      });
    }
  };

  useEffect(() => {
    if (!initialJobId) {
      setViewingJob(null);
      return;
    }
    const active = jobsRef.current.find((job) => job.jobId === initialJobId);
    if (active) {
      setViewingJob(active);
      return;
    }
    const entry = loadTimestampHistory().find((item) => item.id === initialJobId);
    if (entry) handleSelectHistoryEntry(entry);
  }, [initialJobId]);



  const ytBlock = viewingJob && viewingJob.result ? buildYtDescriptionBlock(viewingJob.result.timestamps) : "";
  const telegramBlock = viewingJob && viewingJob.result ? buildTelegramBlock(viewingJob.result.timestamps, viewingJob.result.videoDuration) : "";

  const transcriptSourceLabel =
    viewingJob && viewingJob.result?.transcriptSource === "assemblyai"
      ? "AssemblyAI transcription"
      : viewingJob && viewingJob.result?.transcriptSource === "chapters"
        ? "existing chapter markers"
        : viewingJob && viewingJob.result?.transcriptSource === "youtube"
          ? "YouTube subtitles"
          : null;

  return (
    <div className="max-w-3xl mx-auto w-full text-left flex flex-col gap-5 px-4 py-6 md:py-10">
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
          YouTube Timestamps
        </h1>
        <p className="mt-3 text-base text-zinc-400 leading-relaxed">
          Generate clean chapter markers from any YouTube video <br className="hidden sm:inline" />
          with AI precision.
        </p>
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="space-y-4 w-full">
        {/* Glow and outer border wrapper */}
        <div className="relative group w-full">
          {/* Glowing backdrop blur */}
          <div 
            className="absolute -inset-[5.5px] rounded-[12px] opacity-50 blur-[12px] transition-all duration-500 group-hover:opacity-70 group-focus-within:opacity-90"
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
            <div className="relative rounded-[11px] bg-[#09090b] py-2.5 px-4 shadow-[0_10px_35px_rgba(0,0,0,0.5)]">
              <div className="flex items-center gap-3">
                <Link2 className="h-5 w-5 text-zinc-500 shrink-0" />
                <textarea
                  ref={textareaRef}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  disabled={submitting}
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
                  disabled={submitting || !command.trim()}
                  type="submit"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-zinc-800 hover:bg-zinc-700 text-white disabled:bg-zinc-900/50 disabled:text-zinc-600 disabled:border-zinc-800/40 border border-zinc-700/30 transition shadow-sm"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                </button>
              </div>
            </div>
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
        <div className="border border-zinc-900/80 bg-[#09090b]/40 backdrop-blur-md rounded-xl p-3.5 w-full text-left">
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
                  disabled={submitting}
                  className="w-full px-4 py-3 rounded-xl text-sm text-white placeholder:text-zinc-600 bg-black/30 border border-zinc-900 focus:border-zinc-800 focus:outline-none focus:ring-1 focus:ring-zinc-800 transition-all duration-200 disabled:opacity-50 resize-none mt-3"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </form>

      {/* Active / Recent Job Cards */}
      {!viewingJob && jobs.length > 0 && (
        <div className="space-y-4 w-full">
          <div className="text-sm font-semibold text-zinc-400">Current Jobs</div>
          <div className="flex flex-col gap-4 w-full">
            {jobs
              .map((job) => (
                <TimestampJobCard
                  key={job.jobId}
                  job={job}
                  onView={() => {
                    setViewingJob(job);
                    replaceTimestampsPath(job.jobId);
                  }}
                  onCancel={() => handleCancelJob(job.jobId)}
                  onDismiss={() => handleDismissJob(job.jobId)}
                />
              ))}
          </div>
        </div>
      )}

      {/* Results */}
      <AnimatePresence>
        {viewingJob && viewingJob.status === "done" && viewingJob.result && viewingJob.result.timestamps.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="space-y-4 w-full text-left"
          >
            {/* Video info bar */}
            {viewingJob.result.videoTitle && (
              <div className="px-4 py-3 rounded-xl border border-indigo-500/20 bg-indigo-500/8 w-full">
                <p className="text-sm font-semibold text-white/90 leading-snug">{viewingJob.result.videoTitle}</p>
                <div className="flex items-center gap-3 mt-1">
                  {viewingJob.result.videoDuration > 0 && (
                    <span className="text-xs text-white/40">
                      <Clock className="w-3 h-3 inline mr-1 -mt-0.5" />
                      {formatTime(viewingJob.result.videoDuration)}
                    </span>
                  )}
                  <span className="text-xs text-white/40">
                    {viewingJob.result.timestamps.length} chapters
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
                      : "bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-md shadow-indigo-500/10 active:scale-[0.98]",
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
                {viewingJob.result.timestamps.map((ts, i) => {
                  const range = formatRange(ts, viewingJob.result!.timestamps[i + 1], viewingJob.result!.videoDuration);
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
                      {/* Copy single row */}
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
                      : "bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white shadow-md shadow-violet-500/10 active:scale-[0.98]",
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
                      : "bg-white/10 hover:bg-white/15 text-white/80 border border-white/5 shadow-sm active:scale-[0.98]",
                  )}
                >
                  {copied === "text" ? <><Check className="w-3.5 h-3.5 mr-1.5" />Copied!</> : <><Copy className="w-3.5 h-3.5 mr-1.5" />Copy</>}
                </Button>
              </div>
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto w-full">
                {ytBlock}
              </pre>
            </div>

            {/* Close viewer */}
            <div className="flex justify-center w-full">
              <Button
                variant="ghost"
                onClick={() => {
                  setViewingJob(null);
                  replaceTimestampsPath(null);
                }}
                className="text-xs text-zinc-400 hover:text-white hover:bg-white/5 gap-1.5 px-4 py-2 rounded-xl transition"
              >
                <X className="w-3.5 h-3.5" />
                Close Viewer
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recent timestamp sets */}
      {!viewingJob && history.length > 0 && (
        <div className="mt-6 w-full text-left">
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm font-semibold text-white">Recent timestamp sets</span>
          </div>

          <div className="flex flex-col gap-2.5 w-full">
            {[...history]
              .sort((a, b) => b.createdAt - a.createdAt)
              .slice(0, visibleHistoryCount)
              .map((entry) => (
                <RecentTimestampRow
                  key={entry.id}
                  entry={entry}
                  onSelect={() => handleSelectHistoryEntry(entry)}
                  onDelete={() => setHistory(deleteFromTimestampHistory(entry.id))}
                />
              ))}
            {history.length > visibleHistoryCount && (
              <button
                type="button"
                onClick={() => setVisibleHistoryCount((count) => count + HISTORY_PAGE_SIZE)}
                className="mt-1 h-10 rounded-xl border border-white/10 bg-white/[0.04] text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] hover:text-white"
              >
                Show more
              </button>
            )}
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
      className="bg-[#09090b]/30 border border-zinc-900/80 rounded-xl px-3.5 py-2.5 flex items-center gap-3.5 relative cursor-pointer hover:bg-white/[0.02] transition-colors w-full text-left"
    >
      <div className="relative h-[56px] w-[98px] shrink-0 overflow-hidden rounded-md bg-zinc-800 border border-white/5">
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

function TimestampJobCard({
  job,
  onView,
  onCancel,
  onDismiss,
}: {
  job: ActiveTimestampJob;
  onView: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const videoId = extractVideoId(job.url);
  const title = useVideoTitle(job.url, job.videoTitle ?? "Analyzing Video...");
  const [elapsed, setElapsed] = useState(0);

  const isTerminal = job.status === "done" || job.status === "error" || job.status === "cancelled";
  const isRunning = job.status === "running" || job.status === "pending";

  useEffect(() => {
    if (!isRunning) return;
    const start = job.startedAt || Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, job.startedAt]);

  const getThumbnailUrl = () => {
    if (job.jobId === "mock-productivity") {
      return "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=400&q=80";
    }
    if (job.jobId === "mock-ramcharitmanas") {
      return "https://images.unsplash.com/photo-1579033461380-adb47c3eb938?auto=format&fit=crop&w=400&q=80";
    }
    return videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;
  };
  const thumbnailUrl = getThumbnailUrl();

  const cardContent = (
    <div className="relative rounded-[11px] bg-[#09090b] py-3 px-4 shadow-[0_10px_35px_rgba(0,0,0,0.5)] flex flex-col gap-2.5">
      <div className="flex items-center gap-3.5 w-full">
        {/* Thumbnail Preview */}
        <div className="relative h-[56px] w-[98px] shrink-0 overflow-hidden rounded-md bg-zinc-900 border border-white/5 shadow-md">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              className={cn(
                "h-full w-full object-cover transition-transform duration-300",
                isRunning && "animate-pulse opacity-70"
              )}
              alt="Thumbnail"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-zinc-950">
              <Youtube className="h-4.5 w-4.5 text-white/20" />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-85" />
        </div>

        {/* Info details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {job.status === "pending" && (
              <Loader2 className="w-3.5 h-3.5 text-zinc-400 animate-spin shrink-0" />
            )}
            {job.status === "running" && (
              <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin shrink-0" />
            )}
            {job.status === "done" && (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            )}
            {job.status === "error" && (
              <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
            )}
            {job.status === "cancelled" && (
              <AlertCircle className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            )}
            <p className="text-white/95 text-sm font-semibold truncate leading-snug">
              {title}
            </p>
          </div>

          <p className="text-zinc-400 text-xs mt-1.5 truncate">
            {job.status === "pending" && "Queued..."}
            {job.status === "running" && `Generating Timestamps · Elapsed: ${formatElapsed(elapsed)}`}
            {job.status === "done" && `Completed · ${(job.result?.timestamps ?? []).length} chapters`}
            {job.status === "error" && "Generation failed"}
            {job.status === "cancelled" && "Cancelled"}
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {isRunning && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700/50 text-zinc-300 text-xs font-semibold transition-all active:scale-[0.98]"
            >
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
          )}

          {job.status === "done" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onView();
              }}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-xs font-bold transition-all active:scale-[0.98] shadow-md shadow-indigo-500/10"
            >
              <Check className="w-3.5 h-3.5" />
              View Chapters
            </button>
          )}

          {isTerminal && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
              title="Dismiss card"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar and details */}
      {(isRunning || job.status === "done") && (
        <div className="relative z-10 flex flex-col gap-1.5 px-0.5 mt-0.5">
          <div className="h-[4px] w-full bg-zinc-950 rounded-full relative overflow-visible shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
            <div
              className="h-full rounded-full transition-[width] duration-700 ease-out relative filter"
              style={{
                width: `${job.percent}%`,
                background: job.status === "done"
                  ? 'linear-gradient(to right, #10b981, #059669)'
                  : 'linear-gradient(to right, rgba(0, 0, 0, 0) 0%, rgba(0, 122, 255, 0.05) 15%, rgba(0, 122, 255, 0.2) 35%, rgba(175, 82, 222, 0.5) 60%, rgba(255, 45, 85, 0.8) 85%, rgba(255, 149, 0, 0.95) 95%, #ffffff 100%)',
                animation: job.status === "done" ? 'none' : 'rocketFire 0.4s ease-in-out infinite',
              }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5">
            <span className="truncate max-w-[80%]">{job.message}</span>
            <span className="font-mono">{job.percent > 0 ? `${job.percent.toFixed(0)}%` : ""}</span>
          </div>
        </div>
      )}

      {job.status === "error" && job.error && (
        <div className="text-xs text-red-400/90 bg-red-950/20 border border-red-900/30 rounded-lg p-2.5 mt-0.5">
          {job.error}
        </div>
      )}
    </div>
  );

  // If the job is active (running/pending), wrap it in the flowing RGB border glow!
  if (isRunning) {
    return (
      <div className="relative group w-full">
        {/* Glowing backdrop blur */}
        <div 
          className="absolute -inset-[5.5px] rounded-[12px] opacity-40 blur-[12px] transition-all duration-500 group-hover:opacity-60"
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
          {cardContent}
        </div>
      </div>
    );
  }

  // Non-running terminal card
  return (
    <div className="relative w-full rounded-[12px] p-[1px] bg-zinc-900 hover:bg-zinc-850 border border-zinc-800/80 transition-all duration-300">
      {cardContent}
    </div>
  );
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function useVideoTitle(url: string, currentTitle: string) {
  const [title, setTitle] = useState(currentTitle);

  useEffect(() => {
    if (currentTitle && currentTitle !== "Analyzing Video...") {
      setTitle(currentTitle);
      return;
    }

    const videoId = extractVideoId(url);
    if (!videoId) return;

    fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.title) {
          setTitle(data.title);
        }
      })
      .catch(() => {});
  }, [url, currentTitle]);

  return title;
}
