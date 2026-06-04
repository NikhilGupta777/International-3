import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Scissors,
  Youtube,
  Clock,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  Download,
  History,
  Trash2,
  Film,
  Link2,
  Info,
  ArrowUp,
  SlidersHorizontal,
  MoreVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  type ClipHistoryEntry,
  type ActiveClipJob,
  loadClipHistory,
  saveToClipHistory,
  deleteFromClipHistory,
  clearClipHistory,
  saveActiveClipJobs,
  loadActiveClipJobs,
  formatClipRelativeTime,
  formatFilesize,
} from "@/lib/clip-history";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");
const JOB_NOT_FOUND_GRACE_MS = 15 * 60 * 1000;

const QUALITY_OPTIONS = [
  { label: "Best", value: "best" },
  { label: "1080p", value: "1080" },
  { label: "720p", value: "720" },
  { label: "480p", value: "480" },
  { label: "360p", value: "360" },
];

function parseTimeToSeconds(val: string): number | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":").map(Number);
  if (parts.some((p) => isNaN(p) || p < 0)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function secsToLabel(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

type JobStatus =
  | "pending"
  | "downloading"
  | "merging"
  | "done"
  | "error"
  | "cancelled";

function normalizeJobStatus(raw: string | undefined, current: JobStatus): JobStatus {
  if (!raw) return current;
  const s = raw.toLowerCase();
  if (s === "queued") return "pending";
  if (s === "running") return "downloading";
  if (
    s === "pending" ||
    s === "downloading" ||
    s === "merging" ||
    s === "done" ||
    s === "error" ||
    s === "cancelled"
  ) {
    return s;
  }
  if (s === "expired") return "error";
  return current;
}

interface ActiveJob {
  jobId: string;
  label: string;
  url: string;
  quality: string;
  startSecs: number;
  endSecs: number;
  status: JobStatus;
  percent: number;
  speed: string | null;
  eta: string | null;
  filename: string | null;
  filesize: number | null;
  message: string | null;
  progressLine: string | null;
  progressSource: string | null;
  queueUpdatedAt: string | null;
  completedAt: number | null;
  elapsedMs: number | null;
  downloaded: boolean;
  savedToHistory: boolean;
  startedAt: number;
  reconnected?: boolean;
}

interface ProgressPayload {
  status?: string;
  percent?: number | null;
  speed?: string | null;
  eta?: string | null;
  filename?: string | null;
  filesize?: number | null;
  message?: string | null;
  progressLine?: string | null;
  progressSource?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  elapsedMs?: number | null;
  queue?: {
    updatedAt?: string | null;
    batchJobId?: string | null;
    s3Key?: string | null;
  };
}

type DownloadableClip = Pick<ActiveJob, "jobId" | "filename" | "status">;


function extractYouTubeUrl(text: string): string | null {
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = text.match(ytRegex);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : null;
}

function extractTimes(text: string): { start: number | null; end: number | null } {
  const timeRegex = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/g;
  const matches = [...text.matchAll(timeRegex)];
  
  if (matches.length === 0) return { start: null, end: null };
  
  const parseTime = (match: RegExpMatchArray) => {
    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = parseInt(match[2]);
    const seconds = parseInt(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  };

  const start = parseTime(matches[0]);
  const end = matches.length > 1 ? parseTime(matches[1]) : null;

  return { start, end };
}

export function ClipCutter() {
  const [command, setCommand] = useState("");
  const [quality, setQuality] = useState("best");
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [history, setHistory] = useState<ClipHistoryEntry[]>(() => loadClipHistory());
  const { toast } = useToast();

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHelper, setShowHelper] = useState(false);
  const [manualStart, setManualStart] = useState("");
  const [manualEnd, setManualEnd] = useState("");
  const [notification, setNotification] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => {
      setNotification(null);
    }, 10000);
    return () => clearTimeout(timer);
  }, [notification]);
  const streamRefs = useRef<Map<string, EventSource>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  const jobsRef = useRef<ActiveJob[]>([]);
  jobsRef.current = jobs;



  // Persist active jobs to localStorage whenever the jobs list changes
  const persistActiveJobs = useCallback((current: ActiveJob[]) => {
    const active = current
      .filter(
        (j) =>
          j.status !== "done" &&
          j.status !== "error" &&
          j.status !== "cancelled",
      )
      .map((j): ActiveClipJob => ({
        jobId: j.jobId,
        label: j.label,
        url: j.url,
        quality: j.quality,
        startSecs: j.startSecs,
        endSecs: j.endSecs,
        startedAt: j.startedAt,
      }));
    saveActiveClipJobs(active);
  }, []);

  // On mount: restore any jobs that were running when user navigated away
  useEffect(() => {
    const saved = loadActiveClipJobs();
    if (saved.length === 0) return;

    const restored: ActiveJob[] = saved.map((s) => ({
      jobId: s.jobId,
      label: s.label,
      url: s.url,
      quality: s.quality,
      startSecs: s.startSecs,
      endSecs: s.endSecs,
      status: "pending" as JobStatus,
      percent: 0,
      speed: null,
      eta: null,
      filename: null,
      filesize: null,
      progressLine: null,
      progressSource: null,
      queueUpdatedAt: null,
      completedAt: null,
      elapsedMs: null,
      message: "Reconnecting…",
      downloaded: false,
      savedToHistory: false,
      startedAt: s.startedAt,
      reconnected: true,
    }));

    setJobs(restored);
  }, []);

  // Polling loop — runs continuously, picks up all active jobs
  useEffect(() => {
    if (typeof EventSource !== "undefined") return;
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
      const current = jobsRef.current;
        const active = current.filter(
        (j) =>
          j.status !== "done" &&
          j.status !== "error" &&
          j.status !== "cancelled",
      );
      if (active.length === 0) return;

      for (const job of active) {
          try {
            const res = await fetch(`${BASE_URL}/api/youtube/progress/${job.jobId}`);

            // 404 means server restarted and the job is gone
            if (res.status === 404) {
              if (Date.now() - job.startedAt < JOB_NOT_FOUND_GRACE_MS) {
                continue;
              }
              setJobs((prev) => {
                const updated = prev.map((j) =>
                  j.jobId !== job.jobId ? j : {
                    ...j,
                    status: "error" as JobStatus,
                    message: "Server restarted — job was lost. Please retry.",
                  },
                );
                persistActiveJobs(updated);
                return updated;
              });
              continue;
            }

            if (!res.ok) continue;
            const data = await res.json();

            setJobs((prev) => {
              const updated = prev.map((j) => {
                if (j.jobId !== job.jobId) return j;

                const updatedJob: ActiveJob = {
                  ...j,
                  status: normalizeJobStatus(data.status, j.status),
                  percent: data.percent ?? j.percent,
                  speed: data.speed ?? null,
                  eta: data.eta ?? null,
                  filename: data.filename ?? j.filename,
                  filesize: data.filesize ?? j.filesize,
                  message: data.message ?? null,
                  progressLine: data.progressLine ?? j.progressLine,
                  progressSource: data.progressSource ?? j.progressSource,
                  queueUpdatedAt: data.queue?.updatedAt ?? j.queueUpdatedAt,
                  completedAt: data.completedAt ?? (data.status === "done" ? Date.now() : j.completedAt),
                  elapsedMs: data.elapsedMs ?? j.elapsedMs,
                };

                // Save to history when done
                if (data.status === "done" && !j.savedToHistory) {
                  const entry: ClipHistoryEntry = {
                    jobId: j.jobId,
                    createdAt: Date.now(),
                    label: j.label,
                    url: j.url,
                    quality: j.quality,
                    filename: data.filename ?? j.filename ?? "clip.mp4",
                    filesize: data.filesize ?? j.filesize,
                    durationSecs: j.endSecs - j.startSecs,
                  };
                  saveToClipHistory(entry);
                  setHistory(loadClipHistory());
                  updatedJob.savedToHistory = true;
                }

                return updatedJob;
              });

              persistActiveJobs(updated);
              return updated;
            });
          } catch {}
        }
      } finally {
        pollInFlightRef.current = false;
      }
    }, 1500);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [persistActiveJobs]);

  const closeJobStream = useCallback((jobId: string) => {
    const stream = streamRefs.current.get(jobId);
    if (stream) {
      stream.close();
      streamRefs.current.delete(jobId);
    }
  }, []);

  const applyProgressUpdate = useCallback(
    (jobId: string, data: ProgressPayload) => {
      let historyEntry: ClipHistoryEntry | null = null;

      setJobs((prev) => {
        const updated = prev.map((j) => {
          if (j.jobId !== jobId) return j;

          const rawStatus = (data.status ?? j.status) as string;
          const nextStatus = normalizeJobStatus(rawStatus, j.status);

          const nextJob: ActiveJob = {
            ...j,
            status: nextStatus,
            percent: typeof data.percent === "number" ? data.percent : j.percent,
            speed: data.speed ?? null,
            eta: data.eta ?? null,
            filename: data.filename ?? j.filename,
            filesize: data.filesize ?? j.filesize,
            message:
              rawStatus === "expired"
                ? "File expired. Please run clip cut again."
                : (data.message ?? null),
            progressLine: data.progressLine ?? j.progressLine,
            progressSource: data.progressSource ?? j.progressSource,
            queueUpdatedAt: data.queue?.updatedAt ?? j.queueUpdatedAt,
            completedAt: data.completedAt ?? (nextStatus === "done" ? Date.now() : j.completedAt),
            elapsedMs: data.elapsedMs ?? j.elapsedMs,
            reconnected: false,
          };

          if (nextStatus === "done" && !j.savedToHistory) {
            historyEntry = {
              jobId: j.jobId,
              createdAt: Date.now(),
              label: j.label,
              url: j.url,
              quality: j.quality,
              filename: data.filename ?? j.filename ?? "clip.mp4",
              filesize: data.filesize ?? j.filesize,
              durationSecs: j.endSecs - j.startSecs,
            };
            nextJob.savedToHistory = true;
          }

          return nextJob;
        });

        persistActiveJobs(updated);
        return updated;
      });

      if (historyEntry) {
        saveToClipHistory(historyEntry);
        setHistory(loadClipHistory());
      }
    },
    [persistActiveJobs],
  );

  const markJobLost = useCallback(
    (jobId: string, message: string) => {
      setJobs((prev) => {
        const updated = prev.map((j) =>
          j.jobId !== jobId
            ? j
            : {
                ...j,
                status: "error" as JobStatus,
                message,
              },
        );
        persistActiveJobs(updated);
        return updated;
      });
    },
    [persistActiveJobs],
  );

  const refreshJobOnce = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`${BASE_URL}/api/youtube/progress/${jobId}`);
        if (res.status === 404) {
          const current = jobsRef.current.find((j) => j.jobId === jobId);
          if (current && Date.now() - current.startedAt < JOB_NOT_FOUND_GRACE_MS) {
            return;
          }
          markJobLost(jobId, "Server restarted - job was lost. Please retry.");
          return;
        }
        if (!res.ok) {
          throw new Error(`Progress request failed (${res.status})`);
        }
        const data = (await res.json()) as ProgressPayload;
        applyProgressUpdate(jobId, data);
      } catch {
        setJobs((prev) =>
          prev.map((j) =>
            j.jobId !== jobId || j.status === "done" || j.status === "error" || j.status === "cancelled"
              ? j
              : {
                  ...j,
                  message: "Connection issue - retrying...",
                  reconnected: true,
                },
          ),
        );
      }
    },
    [applyProgressUpdate, markJobLost],
  );

  // Track active job IDs for the SSE effect — only open/close streams when jobs are added/removed
  const activeJobIds = jobs
    .filter((j) => j.status !== "done" && j.status !== "error" && j.status !== "cancelled")
    .map((j) => j.jobId)
    .sort()
    .join(",");

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const activeJobs = jobs.filter(
      (j) => j.status !== "done" && j.status !== "error" && j.status !== "cancelled",
    );
    const activeIds = new Set(activeJobs.map((j) => j.jobId));

    for (const jobId of Array.from(streamRefs.current.keys())) {
      if (!activeIds.has(jobId)) closeJobStream(jobId);
    }

    for (const job of activeJobs) {
      if (streamRefs.current.has(job.jobId)) continue;

      const stream = new EventSource(
        `${BASE_URL}/api/youtube/progress/stream/${job.jobId}`,
      );
      streamRefs.current.set(job.jobId, stream);

      stream.onmessage = (event) => {
        let payload: ProgressPayload;
        try {
          payload = JSON.parse(event.data) as ProgressPayload;
        } catch {
          return;
        }

        applyProgressUpdate(job.jobId, payload);

        const terminal = payload.status;
        if (
          terminal === "done" ||
          terminal === "error" ||
          terminal === "expired" ||
          terminal === "cancelled"
        ) {
          closeJobStream(job.jobId);
        }
      };

      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED) {
          closeJobStream(job.jobId);
          void refreshJobOnce(job.jobId);
          return;
        }

        setJobs((prev) =>
          prev.map((j) =>
            j.jobId !== job.jobId || j.status === "done" || j.status === "error" || j.status === "cancelled"
              ? j
              : {
                  ...j,
                  message: "Connection issue - reconnecting...",
                  reconnected: true,
                },
          ),
        );
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobIds, applyProgressUpdate, closeJobStream, refreshJobOnce]);

  useEffect(() => {
    return () => {
      for (const stream of streamRefs.current.values()) {
        stream.close();
      }
      streamRefs.current.clear();
    };
  }, []);

  const startClipCutJob = async (url: string, startSecs: number, endSecs: number, customQuality: string) => {
    const res = await fetch(`${BASE_URL}/api/youtube/clip-cut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        startTime: startSecs,
        endTime: endSecs,
        quality: customQuality,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || "Failed to start clip cut");
    }

    const data = (await res.json()) as { jobId: string; status?: string; message?: string };
    const label = `${secsToLabel(startSecs)} → ${secsToLabel(endSecs)}`;

    const newJob: ActiveJob = {
      jobId: data.jobId,
      label,
      url,
      quality: customQuality,
      startSecs,
      endSecs,
      status: normalizeJobStatus(data.status, "pending"),
      percent: 0,
      speed: null,
      eta: null,
      filename: null,
      filesize: null,
      progressLine: null,
      progressSource: null,
      queueUpdatedAt: null,
      completedAt: null,
      elapsedMs: null,
      message: data.message ?? "Clip cut queued...",
      downloaded: false,
      savedToHistory: false,
      startedAt: Date.now(),
    };

    setJobs((prev) => {
      const updated = [newJob, ...prev];
      persistActiveJobs(updated);
      return updated;
    });
  };

  const handleCut = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!command.trim()) {
      setNotification({ type: "error", message: "Please enter a URL and describe the clip you want..." });
      return;
    }

    setSubmitting(true);
    try {
      const intentRes = await fetch(`${BASE_URL}/api/youtube/clip-cut/intent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: command }),
      });

      const intentData = await intentRes.json().catch(() => ({}));
      if (!intentRes.ok) {
        setNotification({
          type: "error",
          message: intentData.error || "AI could not interpret the clip request. Adjust prompt or use Advanced.",
        });
        return;
      }

      const { url, startTime, endTime, message } = intentData as {
        url: string;
        startTime: number;
        endTime: number;
        message: string;
      };

      setNotification({
        type: "success",
        message: message || `Clip accepted: ${secsToLabel(startTime)} → ${secsToLabel(endTime)}. Starting cut...`,
      });

      await startClipCutJob(url, startTime, endTime, quality);
      setCommand("");
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to start clip cut job.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleManualCut = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!command.trim()) {
      setNotification({ type: "error", message: "Please enter a YouTube URL in the input area above." });
      return;
    }

    const parsedUrl = extractYouTubeUrl(command);
    if (!parsedUrl) {
      setNotification({ type: "error", message: "No valid YouTube URL found in the input area above." });
      return;
    }

    const startSecs = parseTimeToSeconds(manualStart);
    const endSecs = parseTimeToSeconds(manualEnd);

    if (startSecs === null) {
      setNotification({ type: "error", message: "Invalid manual start time. Use format like 1:30 or 90." });
      return;
    }
    if (endSecs === null) {
      setNotification({ type: "error", message: "Invalid manual end time. Use format like 2:00 or 120." });
      return;
    }
    if (endSecs <= startSecs) {
      setNotification({ type: "error", message: "End time must be after start time." });
      return;
    }
    if (endSecs - startSecs > 3600) {
      setNotification({ type: "error", message: "Clip duration cannot exceed 60 minutes." });
      return;
    }

    setSubmitting(true);
    try {
      setNotification({
        type: "success",
        message: `Manual clip cut starting: ${secsToLabel(startSecs)} → ${secsToLabel(endSecs)}...`,
      });

      await startClipCutJob(parsedUrl, startSecs, endSecs, quality);

      setCommand("");
      setManualStart("");
      setManualEnd("");
      setShowAdvanced(false);
    } catch (err) {
      setNotification({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to start manual clip cut.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const removeJob = (jobId: string) => {
    closeJobStream(jobId);
    setJobs((prev) => {
      const updated = prev.filter((j) => j.jobId !== jobId);
      persistActiveJobs(updated);
      return updated;
    });
  };

  const downloadClip = useCallback(async (job: DownloadableClip) => {
    try {
      const progressRes = await fetch(`${BASE_URL}/api/youtube/progress/${job.jobId}`, { cache: "no-store" });
      if (progressRes.ok) {
        const progress = (await progressRes.json().catch(() => null)) as ProgressPayload & { queue?: { s3Key?: string | null } } | null;
        if (progress?.status && normalizeJobStatus(progress.status, job.status) !== "done") {
          toast({
            title: "Clip is not ready yet",
            description: progress.message ?? "Please wait for processing to finish.",
            variant: "destructive",
          });
          return;
        }
        if (progress?.queue && !progress.queue.s3Key) {
          toast({
            title: "Clip output missing",
            description: "The worker finished without a downloadable file. Please run the clip again.",
            variant: "destructive",
          });
          return;
        }
      }

      const a = document.createElement("a");
      a.href = `${BASE_URL}/api/youtube/file/${job.jobId}`;
      a.download = job.filename ?? "clip.mp4";
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      toast({
        title: "Download failed",
        description: err instanceof Error ? err.message : "Unable to start clip download",
        variant: "destructive",
      });
    }
  }, [toast]);

  // Attempt one automatic download when the clip becomes ready.
  // Browser policies may still block it; Save button remains fallback.
  useEffect(() => {
    const ready = jobs.find((j) => j.status === "done" && !j.downloaded);
    if (!ready) return;

    // Mark as downloaded immediately to prevent duplicate triggers from re-renders
    setJobs((prev) =>
      prev.map((j) =>
        j.jobId === ready.jobId ? { ...j, downloaded: true } : j,
      ),
    );

    void downloadClip(ready);
  }, [downloadClip, jobs]);

  const downloadHistoryClip = useCallback((entry: ClipHistoryEntry) => {
    void downloadClip({
      jobId: entry.jobId,
      filename: entry.filename,
      status: "done",
    });
  }, [downloadClip]);

  const cancelJob = async (jobId: string) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.jobId !== jobId || j.status === "done" || j.status === "error" || j.status === "cancelled"
          ? j
          : {
              ...j,
              message: "Cancelling...",
            },
      ),
    );

    try {
      const res = await fetch(`${BASE_URL}/api/youtube/cancel/${jobId}`, {
        method: "POST",
      });
      const data = await res
        .json()
        .catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to cancel clip");
      }
    } catch (err) {
      setJobs((prev) =>
        prev.map((j) =>
          j.jobId !== jobId || j.status === "done" || j.status === "error" || j.status === "cancelled"
            ? j
            : {
                ...j,
                message:
                  err instanceof Error
                    ? `Cancel failed: ${err.message}`
                    : "Cancel failed. Retry in a moment.",
              },
        ),
      );
      toast({
        title: "Cancel failed",
        description:
          err instanceof Error ? err.message : "Unable to cancel clip download",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col gap-5 relative max-w-[720px] mx-auto w-full pt-8 sm:pt-14">
      {/* Up Notification Style Card */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: -20, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -20, height: 0 }}
            className="w-full z-30 overflow-hidden"
          >
            <div className={cn(
              "w-full rounded-xl border p-3 flex items-center justify-between gap-3 shadow-[0_4px_20px_rgba(0,0,0,0.45)] backdrop-blur-md mb-4",
              notification.type === "success" && "bg-green-500/10 border-green-500/20 text-green-200",
              notification.type === "error" && "bg-red-500/10 border-red-500/20 text-red-200",
              notification.type === "info" && "bg-blue-500/10 border-blue-500/20 text-blue-200"
            )}>
              <div className="flex items-center gap-2.5 min-w-0">
                {notification.type === "success" && <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />}
                {notification.type === "error" && <AlertCircle className="h-4 w-4 text-red-400 shrink-0" />}
                {notification.type === "info" && <Info className="h-4 w-4 text-blue-400 shrink-0" />}
                <span className="text-xs sm:text-sm font-semibold truncate leading-relaxed">
                  {notification.message}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setNotification(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mb-5 max-w-none sm:mb-6">
        <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-[38px]">Clip Cut</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400 sm:text-base lg:text-[15px]">
          Cut, trim, and extract the perfect clips from any YouTube video with <strong className="font-semibold text-white/90">AI precision</strong>.
        </p>
      </div>

      <form onSubmit={handleCut} className="flex flex-col gap-6 relative">
        <div className="relative group w-full">
          <style>{`
            @keyframes rgbGlow {
              0% { background-position: 0% 50%; }
              15% { background-position: 20% 50%; }
              35% { background-position: 80% 50%; }
              50% { background-position: 100% 50%; }
              65% { background-position: 80% 50%; }
              85% { background-position: 20% 50%; }
              100% { background-position: 0% 50%; }
            }
          `}</style>
          {/* Glowing backdrop blur */}
          <div 
            className="absolute -inset-[5.5px] rounded-[12px] opacity-50 blur-[10px] transition-all duration-500 group-hover:opacity-70 group-focus-within:opacity-90"
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
            <div className="relative rounded-[11px] bg-[#09090b] py-3.5 px-5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
              <div className="flex items-center gap-3">
                <Link2 className="h-4.5 w-4.5 text-zinc-500 shrink-0" />
                <textarea
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  disabled={submitting}
                  rows={1}
                  placeholder="Paste YouTube URL and describe the clip you want..."
                  className="h-7 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-sm leading-5 text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleCut(e);
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
                  <Info className="h-4.5 w-4.5" />
                </button>
                {/* Submit arrow button inside the input area */}
                <button
                  disabled={submitting || !command.trim()}
                  type="submit"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                </button>
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
                    <div className="flex items-center gap-2">
                      <Info className="h-4 w-4 text-orange-400" />
                      <span className="text-sm font-bold text-white">How Clip Cut Works</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowHelper(false)}
                      className="p-1 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-white transition"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Paste a YouTube URL and describe the range to cut. AI will automatically interpret it, or you can input start & end times manually in Advanced options.
                  </p>
                  
                  {/* Tutorial image placeholder */}
                  <div className="relative aspect-video rounded-lg overflow-hidden border border-zinc-800 bg-zinc-950 flex flex-col items-center justify-center">
                    <img
                      src="/clip_cut_tutorial_placeholder.png"
                      alt="Clip Cut Tutorial"
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-0 bg-black/45 flex flex-col items-center justify-center gap-1.5 p-2 text-center pointer-events-none">
                      <div className="rounded-full bg-white/10 p-2 backdrop-blur-sm border border-white/20">
                        <Film className="h-4 w-4 text-white" />
                      </div>
                      <span className="text-[10px] font-semibold text-white/90">Tutorial Video (Placeholder)</span>
                    </div>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Advanced Options small tab inside the same form */}
        <AnimatePresence>
          {showAdvanced && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden w-full"
            >
              <div className="rounded-2xl border border-zinc-800/80 bg-[#070709] p-4 flex flex-col gap-4 shadow-inner">
                <div className="flex items-center justify-between border-b border-zinc-800/30 pb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Manual Trim Options</span>
                  <span className="text-[10px] text-zinc-500">Skip AI intent parsing</span>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold text-zinc-400">Start Time</label>
                    <input
                      type="text"
                      value={manualStart}
                      onChange={(e) => setManualStart(e.target.value)}
                      disabled={submitting}
                      placeholder="e.g. 0:30 or 30"
                      className="h-10 rounded-xl border border-zinc-850 bg-[#0f0f11] px-3.5 text-sm text-white placeholder:text-zinc-650 outline-none focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold text-zinc-400">End Time</label>
                    <input
                      type="text"
                      value={manualEnd}
                      onChange={(e) => setManualEnd(e.target.value)}
                      disabled={submitting}
                      placeholder="e.g. 2:15 or 135"
                      className="h-10 rounded-xl border border-zinc-850 bg-[#0f0f11] px-3.5 text-sm text-white placeholder:text-zinc-650 outline-none focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold text-zinc-400">Video Quality</label>
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value)}
                      disabled={submitting}
                      className="h-10 rounded-xl border border-zinc-850 bg-[#0f0f11] px-3 text-sm text-white outline-none focus:border-zinc-700 disabled:opacity-50"
                    >
                      {QUALITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    onClick={handleManualCut}
                    disabled={submitting || !command.trim() || !manualStart.trim() || !manualEnd.trim()}
                    variant="outline"
                    className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-zinc-200 text-xs font-semibold text-black hover:bg-zinc-100 disabled:opacity-50 shadow-none border-none active:scale-[0.98]"
                  >
                    <Scissors className="h-3.5 w-3.5" />
                    Cut Manually
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button
            type="submit"
            disabled={submitting || !command.trim()}
            variant="outline"
            className="flex h-11 w-full max-w-[200px] items-center justify-center gap-2 rounded-full bg-white text-[14px] font-semibold text-black hover:bg-white/90 sm:w-auto disabled:opacity-50 shadow-none border-none"
          >
            <Scissors className="h-4 w-4" />
            Cut Clip
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={cn(
              "flex h-11 w-full max-w-[200px] items-center justify-center gap-2 rounded-full border border-zinc-800 text-[14px] font-semibold text-white hover:bg-zinc-800/80 sm:w-auto shadow-none transition-all",
              showAdvanced ? "bg-zinc-800/80 border-zinc-700" : "bg-[#0d0d0d]"
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Advanced
          </Button>
        </div>
      </form>

      {/* Active / in-progress job cards */}
      <AnimatePresence initial={false}>
        {jobs.map((job) => (
          <ClipJobCard
            key={job.jobId}
            job={job}
            onRemove={removeJob}
            onCancel={cancelJob}
            onDownload={downloadClip}
          />
        ))}
      </AnimatePresence>

      {/* ── History panel ──────────────────────────────────────────────────── */}
      <AnimatePresence>
        {history.length > 0 && (
          <motion.div
            key="clip-history"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex flex-col gap-4 mt-6"
          >
            <div className="w-full h-px bg-white/5 mb-2" />
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">Recent cuts</span>
            </div>

            <div className="flex flex-col gap-2">
              {history.map((entry) => (
                <RecentClipRow
                  key={entry.jobId}
                  entry={entry}
                  onDownload={() => downloadHistoryClip(entry)}
                  onDelete={() => setHistory(deleteFromClipHistory(entry.jobId))}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function useElapsed(startedAt: number, active: boolean) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  return elapsed;
}

function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtMs(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  return fmtElapsed(Math.round(ms / 1000));
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

function formatQueueUpdateAge(updatedAt: string | null): string | null {
  if (!updatedAt) return null;
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) return null;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - updatedMs) / 1000));
  return `updated ${fmtElapsed(ageSeconds)} ago`;
}

function isGenericClipMessage(message: string | null): boolean {
  const normalized = (message ?? "").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "cutting clip..." ||
    normalized === "cutting selected section..." ||
    normalized === "downloading..." ||
    normalized === "clip cut queued..." ||
    normalized === "processing..."
  );
}

function getClipProgressView(job: ActiveJob, elapsed: number) {
  const percent = clampPercent(job.percent);
  const hasDownloaderDetails = Boolean(job.speed || job.eta || job.filename || job.filesize);
  const hasRealPercent = percent > 5 || (percent > 0 && hasDownloaderDetails);
  const queueAge = formatQueueUpdateAge(job.queueUpdatedAt);
  const elapsedLabel = fmtElapsed(elapsed);
  const tookLabel = fmtMs(job.elapsedMs ?? (job.completedAt ? job.completedAt - job.startedAt : null));

  const details = [
    job.speed ? `speed ${job.speed}` : null,
    job.eta ? `ETA ${job.eta}` : null,
    job.filesize ? formatFilesize(job.filesize) : null,
    `elapsed ${elapsedLabel}`,
    queueAge,
  ].filter(Boolean);

  let primary: string;
  if (job.reconnected) {
    primary = "Reconnecting to live progress...";
  } else if (job.progressLine) {
    primary = job.progressLine;
  } else if (!isGenericClipMessage(job.message)) {
    primary = job.message as string;
  } else if (hasDownloaderDetails || hasRealPercent) {
    primary = "Downloader has not emitted a detailed line yet";
  } else {
    primary = "No yt-dlp/ffmpeg output received yet";
  }

  return {
    primary,
    details: details.join(" | "),
    right: tookLabel ? `took ${tookLabel}` : hasRealPercent ? `${percent.toFixed(0)}%` : elapsedLabel,
    percent,
    determinate: hasRealPercent,
  };
}

function ClipJobCard({
  job,
  onRemove,
  onCancel,
  onDownload,
}: {
  job: ActiveJob;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
  onDownload: (job: ActiveJob) => void;
}) {
  const isDone = job.status === "done";
  const isError = job.status === "error";
  const isCancelled = job.status === "cancelled";
  const isProcessing =
    job.status === "pending" ||
    job.status === "downloading" ||
    job.status === "merging";

  const isCancelling = isProcessing && (job.message ?? "").toLowerCase().includes("cancel");
  const queuePositionMatch = job.message?.match(/queued\s*\(#(\d+)\)/i);
  const queuePosition = queuePositionMatch ? Number.parseInt(queuePositionMatch[1], 10) : null;
  const isQueued = job.status === "pending" && (job.message ?? "").toLowerCase().includes("queued");

  const elapsed = useElapsed(job.startedAt, isProcessing);
  const progressView = getClipProgressView(job, elapsed);
  const doneTimeLabel = fmtMs(job.elapsedMs ?? (job.completedAt ? job.completedAt - job.startedAt : null));

  return (
    <motion.div
      key={job.jobId}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, height: 0 }}
      transition={{ duration: 0.25 }}
      className={cn(
        "glass-panel rounded-2xl px-5 py-4 flex flex-col gap-3 relative overflow-hidden border",
        isDone && "border-green-500/20",
        isError && "border-red-500/20",
        isCancelled && "border-amber-500/20",
        isProcessing && "border-orange-500/15",
      )}
    >
      {/* Glow */}
      <div
        className={cn(
          "absolute top-0 right-0 w-40 h-40 blur-[60px] rounded-full pointer-events-none opacity-20",
          isDone && "bg-green-500",
          isError && "bg-red-500",
          isCancelled && "bg-amber-500",
          isProcessing && "bg-orange-500",
        )}
      />

      <div className="flex items-center justify-between gap-3 relative z-10">
        <div className="flex items-center gap-2.5 min-w-0">
          {isDone ? (
            <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
          ) : isError ? (
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          ) : isCancelled ? (
            <X className="w-4 h-4 text-amber-400 shrink-0" />
          ) : (
            <Loader2 className="w-4 h-4 text-orange-400 animate-spin shrink-0" />
          )}
          <span className="text-sm font-semibold text-white font-mono truncate">
            {job.label}
          </span>
          {isQueued && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-amber-500/20 border border-amber-500/40 text-amber-300 shrink-0">
              {queuePosition ? `Queued #${queuePosition}` : "Queued"}
            </span>
          )}
          {job.filename && (
            <span className="text-xs text-white/35 truncate hidden sm:block">
              {job.filename}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isProcessing && (
            <button
              onClick={() => onCancel(job.jobId)}
              disabled={isCancelling}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all",
                "border-amber-500/40 text-amber-300",
                isCancelling
                  ? "bg-amber-500/10 opacity-70 cursor-not-allowed"
                  : "bg-amber-500/15 hover:bg-amber-500/25",
              )}
            >
              <X className="w-3 h-3" />
              {isCancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
          {isDone && (
            <button
              onClick={() => onDownload(job)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/25 border border-green-500/30 text-green-300 text-xs font-semibold transition-all"
            >
              <Download className="w-3 h-3" />
              Save
            </button>
          )}
          {(isDone || isError || isCancelled) && (
            <button
              onClick={() => onRemove(job.jobId)}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/30 hover:text-white/70 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isProcessing && (
        <div className="relative z-10 flex flex-col gap-1.5">
          <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
            {!progressView.determinate ? (
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-transparent via-orange-400/70 to-transparent"
                animate={{ x: ["-100%", "200%"] }}
                transition={{
                  repeat: Infinity,
                  duration: 1.8,
                  ease: "easeInOut",
                }}
                style={{ width: "45%" }}
              />
            ) : (
              <motion.div
                className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full"
                animate={{ width: `${progressView.percent}%` }}
                transition={{ ease: "linear", duration: 0.5 }}
                style={{ width: `${progressView.percent}%` }}
              />
            )}
          </div>
          <div className="flex justify-between gap-3 text-[11px] text-white/40">
            <span
              className="min-w-0 truncate"
              title={progressView.details || progressView.primary}
            >
              {progressView.primary}
              {progressView.details ? ` | ${progressView.details}` : ""}
            </span>
            <span className="font-mono shrink-0 pl-3">
              {progressView.right}
            </span>
          </div>
        </div>
      )}

      {isError && (
        <p className="text-xs text-red-400/80 relative z-10">
          {job.message ?? "Clip cut failed. Please try again."}
        </p>
      )}

      {isCancelled && (
        <p className="text-xs text-amber-400/80 relative z-10">
          {job.message ?? "Clip cut was cancelled."}
        </p>
      )}

      {isDone && (
        <p className="text-xs text-green-400/70 relative z-10">
          Clip is ready{doneTimeLabel ? ` in ${doneTimeLabel}` : ""}. Use Save to download.
        </p>
      )}
    </motion.div>
  );
}


function extractVideoId(url: string) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function useVideoTitle(url: string, defaultTitle: string) {
  const [title, setTitle] = useState(defaultTitle);

  useEffect(() => {
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
  }, [url]);

  return title;
}

function RecentClipRow({ entry, onDownload, onDelete }: { entry: ClipHistoryEntry; onDownload: (entry: ClipHistoryEntry) => void; onDelete: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const videoId = extractVideoId(entry.url);
  const title = useVideoTitle(entry.url, entry.label);

  return (
    <motion.div layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} className="bg-[#0c0c0e] border border-zinc-900 rounded-2xl px-4.5 py-3.5 flex items-center gap-4 relative">
      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/5">
        {videoId ? (
          <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} className="h-full w-full object-cover" alt="Thumbnail" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
            <Youtube className="h-4 w-4 text-white/20" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-white/95 text-sm font-semibold truncate leading-snug">{title}</p>
        <p className="text-zinc-400 text-xs mt-1.5 truncate">
          {entry.label} • {formatDuration(entry.durationSecs)} total
        </p>
      </div>

      <div className="flex items-center shrink-0">
        <span className="text-xs text-zinc-500 hidden sm:block mr-4">
          {formatClipRelativeTime(entry.createdAt)}
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
                      onDownload(entry);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition"
                  >
                    <Download className="w-3.5 h-3.5" /> Save
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
