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
const HISTORY_PAGE_SIZE = 7;
const PROGRESS_POLL_INTERVAL_MS = 4000;
const PROGRESS_REQUEST_TIMEOUT_MS = 8000;

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
  const raw = (text ?? "").trim();
  if (!raw) return null;

  const isValidId = (id: string | null | undefined): id is string =>
    !!id && /^[a-zA-Z0-9_-]{11}$/.test(id);

  // Pull the first URL-looking token out of the text, then parse it properly so
  // we support every YouTube URL shape: watch?v=, youtu.be/, /live/, /shorts/,
  // /embed/, /v/, and mobile/music hosts.
  const urlToken = raw.match(/(?:https?:\/\/)?[^\s]*(?:youtube\.com|youtu\.be)[^\s]*/i)?.[0];
  if (urlToken) {
    try {
      const u = new URL(/^https?:\/\//i.test(urlToken) ? urlToken : `https://${urlToken}`);
      const host = u.hostname.toLowerCase();
      if (host === "youtu.be") {
        const id = u.pathname.split("/").filter(Boolean)[0];
        if (isValidId(id)) return `https://www.youtube.com/watch?v=${id}`;
      } else if (host.includes("youtube.com")) {
        const v = u.searchParams.get("v");
        if (isValidId(v)) return `https://www.youtube.com/watch?v=${v}`;
        // /live/<id>, /shorts/<id>, /embed/<id>, /v/<id>
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length >= 2 && /^(live|shorts|embed|v)$/i.test(parts[0]) && isValidId(parts[1])) {
          return `https://www.youtube.com/watch?v=${parts[1]}`;
        }
      }
    } catch {
      // fall through to regex
    }
  }

  // Fallback: legacy regex (covers odd embeds without a clean URL token).
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|live|shorts)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = raw.match(ytRegex);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : null;
}

export function ClipCutter() {
  const [command, setCommand] = useState("");
  const [quality, setQuality] = useState("best");
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [history, setHistory] = useState<ClipHistoryEntry[]>(() => loadClipHistory());
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const newHeight = Math.min(60, textarea.scrollHeight);
    textarea.style.height = `${newHeight}px`;
  }, [command]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  const jobsRef = useRef<ActiveJob[]>([]);
  jobsRef.current = jobs;

  const isTerminalJobStatus = (status: JobStatus) =>
    status === "done" || status === "error" || status === "cancelled";

  const isActiveJob = (job: ActiveJob) => !isTerminalJobStatus(job.status);

  const createHistoryEntry = (job: ActiveJob, data: ProgressPayload): ClipHistoryEntry => ({
    jobId: job.jobId,
    createdAt: Date.now(),
    label: job.label,
    url: job.url,
    quality: job.quality,
    filename: data.filename ?? job.filename ?? "clip.mp4",
    filesize: data.filesize ?? job.filesize,
    durationSecs: job.endSecs - job.startSecs,
  });

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
      // Restored jobs must not auto-trigger a download when they poll to
      // "done" — there is no user gesture, so browsers block or surprise the
      // user. The Save button handles it instead.
      downloaded: true,
      savedToHistory: false,
      startedAt: s.startedAt,
      reconnected: true,
    }));

    setJobs(restored);
  }, []);

  // Polling loop — runs continuously, picks up all active jobs
  useEffect(() => {
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        const current = jobsRef.current;
        const active = current.filter(isActiveJob);
        if (active.length === 0) return;

        await Promise.allSettled(active.map(async (job) => {
          try {
            const res = await fetch(`${BASE_URL}/api/youtube/progress/${job.jobId}`, {
              signal: AbortSignal.timeout(PROGRESS_REQUEST_TIMEOUT_MS),
            });

            // 404 means server restarted and the job is gone
            if (res.status === 404) {
              if (Date.now() - job.startedAt < JOB_NOT_FOUND_GRACE_MS) {
                return;
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
              return;
            }

            if (!res.ok) return;
            const data = await res.json();
            if (data.status === "not_found") {
              if (Date.now() - job.startedAt < JOB_NOT_FOUND_GRACE_MS) {
                return;
              }
              setJobs((prev) => {
                const updated = prev.map((j) =>
                  j.jobId !== job.jobId ? j : {
                    ...j,
                    status: "error" as JobStatus,
                    message: "Server restarted - job was lost. Please retry.",
                  },
                );
                persistActiveJobs(updated);
                return updated;
              });
              return;
            }

            setJobs((prev) => {
              const updated = prev.map((j) => {
                if (j.jobId !== job.jobId) return j;
                const nextStatus = normalizeJobStatus(data.status, j.status);

                const updatedJob: ActiveJob = {
                  ...j,
                  status: nextStatus,
                  percent: data.percent ?? j.percent,
                  speed: data.speed ?? null,
                  eta: data.eta ?? null,
                  filename: data.filename ?? j.filename,
                  filesize: data.filesize ?? j.filesize,
                  message: data.message ?? null,
                  progressLine: data.progressLine ?? j.progressLine,
                  progressSource: data.progressSource ?? j.progressSource,
                  queueUpdatedAt: data.queue?.updatedAt ?? j.queueUpdatedAt,
                  completedAt: data.completedAt ?? (nextStatus === "done" ? Date.now() : j.completedAt),
                  elapsedMs: data.elapsedMs ?? j.elapsedMs,
                  // A successful poll means we're back live — without this the
                  // "Reconnecting to live progress..." line sticks forever.
                  reconnected: false,
                };

                // Save to history when done
                if (nextStatus === "done" && !j.savedToHistory) {
                  const entry = createHistoryEntry(j, data);
                  saveToClipHistory(entry);
                  setHistory(loadClipHistory());
                  updatedJob.savedToHistory = true;
                }

                return updatedJob;
              });

              persistActiveJobs(updated);
              return updated;
            });
          } catch {
            setJobs((prev) =>
              prev.map((j) =>
                j.jobId !== job.jobId || isTerminalJobStatus(j.status)
                  ? j
                  : { ...j, message: "Connection issue - retrying...", reconnected: true },
              ),
            );
          }
        }));
      } finally {
        pollInFlightRef.current = false;
      }
    }, PROGRESS_POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [persistActiveJobs]);

  const buildActiveJob = (
    data: { jobId: string; status?: string; message?: string },
    url: string,
    startSecs: number,
    endSecs: number,
    customQuality: string,
  ): ActiveJob => {
    const label = `${secsToLabel(startSecs)} -> ${secsToLabel(endSecs)}`;
    return {
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
  };

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

  const startClipCutMultiple = async (
    url: string,
    clips: Array<{ startTime: number; endTime: number }>,
    customQuality: string,
  ) => {
    // One batch request = one rate-limit tick. Firing a request per clip
    // trips the 8/min per-IP limit and fails every clip after the eighth.
    const limited = clips.slice(0, 20); // server caps batches at 20
    const res = await fetch(`${BASE_URL}/api/youtube/clip-cut/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, clips: limited, quality: customQuality }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      jobs?: Array<{ jobId: string; status?: string; message?: string; clip: { startTime: number; endTime: number } }>;
      errors?: Array<{ clip: { startTime: number; endTime: number }; error: string }>;
      error?: string;
    };
    if (!res.ok && !(data.jobs && data.jobs.length > 0)) {
      throw new Error(data.error || "Failed to start clip cuts");
    }

    const startedJobs = data.jobs ?? [];
    for (const started of startedJobs) {
      const newJob = buildActiveJob(started, url, started.clip.startTime, started.clip.endTime, customQuality);
      setJobs((prev) => {
        const updated = [newJob, ...prev];
        persistActiveJobs(updated);
        return updated;
      });
    }

    const failures = data.errors ?? [];
    if (failures.length > 0) {
      setNotification({
        type: "error",
        message: `${startedJobs.length}/${limited.length} clips started. Failed: ${failures
          .map((f) => `${secsToLabel(f.clip.startTime)}→${secsToLabel(f.clip.endTime)}`)
          .join(", ")}`,
      });
    } else {
      setNotification({
        type: "success",
        message: `All ${startedJobs.length} clip cuts started successfully!`,
      });
    }
    return startedJobs.length;
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

      const { url, startTime, endTime, clips, message } = intentData as {
        url: string;
        startTime?: number;
        endTime?: number;
        clips?: Array<{ startTime: number; endTime: number }>;
        message: string;
      };

      if (clips && clips.length > 0) {
        setNotification({
          type: "success",
          message: `🚀 Starting ${clips.length} clip cuts: ${message}`,
        });
        await startClipCutMultiple(url, clips, quality);
      } else if (typeof startTime === "number" && typeof endTime === "number") {
        setNotification({
          type: "success",
          message: `🚀 Clip Cut started! Processing ${secsToLabel(startTime)} → ${secsToLabel(endTime)}...`,
        });
        await startClipCutJob(url, startTime, endTime, quality);
      } else {
        setNotification({
          type: "error",
          message: "AI returned no valid time range or clips to cut.",
        });
      }
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

  const handleManualCut = async (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault();

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
        message: `✂️ Manual Clip Cut started! Extracting ${secsToLabel(startSecs)} → ${secsToLabel(endSecs)}...`,
      });

      await startClipCutJob(parsedUrl, startSecs, endSecs, quality);
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
          const isExpired = String(progress.status).toLowerCase() === "expired";
          toast({
            title: isExpired ? "Clip has expired" : "Clip is not ready yet",
            description: isExpired
              ? "This file passed its 7-day retention and was deleted. Run the clip cut again."
              : progress.message ?? "Please wait for processing to finish.",
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

  // Attempt automatic download when clips become ready.
  // Browser policies may block popups for all but the first; Save button remains fallback.
  useEffect(() => {
    const readyJobs = jobs.filter((j) => j.status === "done" && !j.downloaded);
    if (readyJobs.length === 0) return;

    setJobs((prev) =>
      prev.map((j) =>
        readyJobs.some((r) => r.jobId === j.jobId) ? { ...j, downloaded: true } : j,
      ),
    );

    for (const job of readyJobs) {
      void downloadClip(job);
    }
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
      {/* Up Notification Style Card (Absolute Floating) */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-[540px] z-50 pointer-events-none">
        <AnimatePresence>
          {notification && (
            <motion.div
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.96 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="w-full pointer-events-auto"
            >
              <div className="w-full rounded-2xl border border-white/40 bg-white/80 backdrop-blur-xl p-3.5 flex items-center justify-between gap-3 shadow-[0_20px_40px_rgba(0,0,0,0.35),_0_0_24px_rgba(255,255,255,0.08)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.85)]">
                <div className="flex items-center gap-3 min-w-0">
                  {notification.type === "success" && (
                    <div className="p-1 rounded-full bg-green-500/10 text-green-600 shrink-0">
                      <CheckCircle2 className="h-4 w-4 stroke-[2.5]" />
                    </div>
                  )}
                  {notification.type === "error" && (
                    <div className="p-1 rounded-full bg-red-500/10 text-red-600 shrink-0">
                      <AlertCircle className="h-4 w-4 stroke-[2.5]" />
                    </div>
                  )}
                  {notification.type === "info" && (
                    <div className="p-1 rounded-full bg-blue-500/10 text-blue-600 shrink-0">
                      <Info className="h-4 w-4 stroke-[2.5]" />
                    </div>
                  )}
                  <span className="text-xs sm:text-sm font-semibold text-zinc-900 leading-normal">
                    {notification.message}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setNotification(null)}
                  className="p-1 rounded-full hover:bg-black/5 text-zinc-400 hover:text-zinc-700 transition-colors shrink-0"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

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
            @keyframes rocketFire {
              0%, 100% { 
                filter: drop-shadow(0 0 2px #ffffff) drop-shadow(0 0 5px #af52de) drop-shadow(0 0 9px #ff2d55) brightness(0.95);
              }
              50% { 
                filter: drop-shadow(0 0 3.5px #ffffff) drop-shadow(0 0 8px #af52de) drop-shadow(0 0 15px #ff2d55) brightness(1.2);
              }
            }
          `}</style>
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
            <div className="relative rounded-[11px] bg-[#09090b] py-3.5 px-5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
              <div className="flex items-center gap-3">
                <Link2 className="h-4.5 w-4.5 text-zinc-500 shrink-0" />
                <textarea
                  ref={textareaRef}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  disabled={submitting}
                  placeholder="Paste YouTube URL and describe the clip you want..."
                  rows={1}
                  className="h-5 min-h-0 flex-1 resize-none bg-transparent py-0 text-sm leading-5 text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
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


        
        <div className="w-full mt-1">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={cn(
              "flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all",
              showAdvanced
                ? "bg-zinc-800 text-white border border-zinc-700"
                : "bg-zinc-900/60 text-zinc-300 border border-zinc-800 hover:bg-zinc-800/80 hover:text-white hover:border-zinc-700"
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Advanced Options
            <svg
              className={cn("h-3.5 w-3.5 transition-transform duration-200", showAdvanced && "rotate-180")}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <AnimatePresence>
            {showAdvanced && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="mt-3 w-full rounded-2xl border border-zinc-800 bg-[#0d0d0d] p-4 flex flex-col gap-3.5">
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
                    <div className="flex flex-col gap-1.5 text-left">
                      <label className="text-[11px] font-semibold text-zinc-400">Start Time</label>
                      <input
                        type="text"
                        value={manualStart}
                        onChange={(e) => setManualStart(e.target.value)}
                        disabled={submitting}
                        placeholder="e.g. 0:30"
                        className="h-9 w-full rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50 transition-colors"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void handleManualCut(); }
                        }}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5 text-left">
                      <label className="text-[11px] font-semibold text-zinc-400">End Time</label>
                      <input
                        type="text"
                        value={manualEnd}
                        onChange={(e) => setManualEnd(e.target.value)}
                        disabled={submitting}
                        placeholder="e.g. 2:15"
                        className="h-9 w-full rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 text-xs text-white placeholder:text-zinc-600 outline-none focus:border-zinc-700 focus:ring-1 focus:ring-zinc-700 disabled:opacity-50 transition-colors"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void handleManualCut(); }
                        }}
                      />
                    </div>
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value)}
                      disabled={submitting}
                      className="h-9 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 text-xs text-white outline-none focus:border-zinc-700 disabled:opacity-50 transition-colors"
                    >
                      {QUALITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <Button
                    type="button"
                    onClick={handleManualCut}
                    disabled={submitting || !command.trim() || !manualStart.trim() || !manualEnd.trim()}
                    variant="outline"
                    className="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-white text-xs font-semibold text-black hover:bg-zinc-100 disabled:opacity-50 shadow-none border-none active:scale-[0.98] transition-transform"
                  >
                    {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />}
                    Cut
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </form>

      {/* ── Unified cuts panel ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 mt-6">
        <div className="w-full h-px bg-white/5 mb-2" />
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-white">Recent cuts</span>
        </div>

        <div className="flex flex-col gap-2.5">
          {/* Active / in-progress job cards */}
          <AnimatePresence initial={false}>
            {jobs
              .filter((job) => job.status !== "done")
              .map((job) => (
                <ClipJobCard
                  key={job.jobId}
                  job={job}
                  onRemove={removeJob}
                  onCancel={cancelJob}
                  onDownload={downloadClip}
                />
              ))}
          </AnimatePresence>

          {/* Completed History cuts */}
          <AnimatePresence initial={false}>
            {history.slice(0, visibleHistoryCount).map((entry) => (
              <RecentClipRow
                key={entry.jobId}
                entry={entry}
                onDownload={() => downloadHistoryClip(entry)}
                onDelete={() => setHistory(deleteFromClipHistory(entry.jobId))}
              />
            ))}
          </AnimatePresence>

          {history.length > visibleHistoryCount && (
            <button
              type="button"
              onClick={() => setVisibleHistoryCount((count) => count + HISTORY_PAGE_SIZE)}
              className="mt-2 h-10 rounded-xl border border-white/10 bg-white/[0.04] text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] hover:text-white"
            >
              Show more
            </button>
          )}

          {jobs.filter((j) => j.status !== "done").length === 0 && history.length === 0 && (
            <p className="text-xs text-zinc-500 text-center py-6 font-medium">
              No recent cuts yet.
            </p>
          )}
        </div>
      </div>
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
  const elapsed = useElapsed(job.startedAt, isProcessing);
  const progressView = getClipProgressView(job, elapsed);

  const videoId = extractVideoId(job.url);
  const title = useVideoTitle(job.url, job.label);

  return (
    <div className="relative w-full">
      {/* Background glow shadow behind card */}
      {isProcessing && (
        <div
          className="absolute -inset-2 rounded-2xl blur-[20px] pointer-events-none z-0"
          style={{
            opacity: 0.52,
            background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
            backgroundSize: '300% 300%',
            animation: 'rgbGlow 10s ease-in-out infinite',
          }}
        />
      )}

      <motion.div
        layout
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10, height: 0 }}
        transition={{ duration: 0.25 }}
        className={cn(
          "relative z-10 w-full rounded-2xl bg-[#0c0c0e] hover:bg-[#121215] border px-4 py-3 flex flex-col gap-2 group transition-all duration-300",
          isError ? "border-red-900/40" : isCancelled ? "border-zinc-800/40" : "border-zinc-900 hover:border-zinc-800/80"
        )}
      >
        <div className="flex items-center gap-3.5 w-full">
          {/* Thumbnail Preview */}
          <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/5 shadow-md">
            {videoId ? (
              <img
                src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
                className={cn(
                  "h-full w-full object-cover transition-transform duration-350 group-hover:scale-105",
                  isProcessing && "animate-pulse opacity-70"
                )}
                alt="Thumbnail"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-zinc-900">
                <Youtube className="h-4.5 w-4.5 text-white/20" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-85" />
            
            {/* Duration text badge overlay */}
            <span className="absolute bottom-1 right-1 bg-black/80 px-1 py-0.5 rounded text-[9px] font-bold text-white/95 font-mono leading-none tracking-wide">
              {formatDuration(job.endSecs - job.startSecs)}
            </span>
          </div>

          {/* Info details */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isProcessing && <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin shrink-0" />}
              {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />}
              {isError && <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
              {isCancelled && <X className="w-3.5 h-3.5 text-zinc-400 shrink-0" />}
              
              <p className="text-white/95 text-sm font-semibold truncate leading-snug group-hover:text-white transition-colors">
                {title}
              </p>
            </div>

            <p className="text-zinc-400 text-xs mt-1.5 truncate">
              {job.label} • {isProcessing ? (
                <span>
                  Elapsed: {fmtElapsed(elapsed)}
                  {job.eta ? ` • ETA: ${job.eta}` : " • Calculating..."}
                </span>
              ) : isDone ? (
                <span className="text-green-400/80 font-medium">Clip is ready!</span>
              ) : isError ? (
                <span className="text-red-400/80 font-medium">Clip cut failed</span>
              ) : (
                <span className="text-zinc-500 font-medium">Cancelled by user</span>
              )}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            {isProcessing && (
              <button
                onClick={() => onCancel(job.jobId)}
                disabled={isCancelling}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-300 text-xs font-semibold transition-all active:scale-[0.98]"
              >
                <X className="w-3.5 h-3.5" />
                {isCancelling ? "Cancelling..." : "Cancel"}
              </button>
            )}
            {isDone && (
              <button
                onClick={() => onDownload(job)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/25 border border-green-500/30 text-green-300 text-xs font-semibold transition-all active:scale-[0.98]"
              >
                <Download className="w-3.5 h-3.5" />
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

        {/* Progress bar and details */}
        {isProcessing && (
          <div className="relative z-10 flex flex-col gap-1 px-0.5">
            {progressView.determinate && (
              <div className="h-[3px] w-full bg-zinc-950/90 rounded-full relative overflow-visible shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
                <div
                  className="h-full rounded-full transition-[width] duration-700 ease-out relative filter"
                  style={{
                    width: `${progressView.percent}%`,
                    background: 'linear-gradient(to right, rgba(0, 0, 0, 0) 0%, rgba(0, 122, 255, 0.05) 15%, rgba(0, 122, 255, 0.2) 35%, rgba(175, 82, 222, 0.5) 60%, rgba(255, 45, 85, 0.8) 85%, rgba(255, 149, 0, 0.95) 95%, #ffffff 100%)',
                    animation: 'rocketFire 0.4s ease-in-out infinite',
                  }}
                />
              </div>
            )}
            <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5">
              <span>{job.message || (job.status === "downloading" ? "Downloading video..." : "Cutting and merging clip...")}</span>
              <span className="font-mono">
                {progressView.determinate ? `${progressView.percent.toFixed(0)}%` : ""}
              </span>
            </div>
          </div>
        )}

        {/* Error message */}
        {isError && (
          <p className="text-xs text-red-400/80 mt-1">
            {job.message ?? "Clip cut failed. Please try again."}
          </p>
        )}

        {/* Cancelled message */}
        {isCancelled && (
          <p className="text-xs text-amber-400/80 mt-1">
            {job.message ?? "Clip cut was cancelled."}
          </p>
        )}
      </motion.div>
    </div>
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

  const [isNewlyCompleted, setIsNewlyCompleted] = useState(() => {
    const ageMs = Date.now() - entry.createdAt;
    return ageMs >= 0 && ageMs < 50000;
  });

  useEffect(() => {
    if (!isNewlyCompleted) return;

    const ageMs = Date.now() - entry.createdAt;
    const remainingMs = 50000 - ageMs;

    if (remainingMs <= 0) {
      setIsNewlyCompleted(false);
      return;
    }

    const timer = setTimeout(() => {
      setIsNewlyCompleted(false);
    }, remainingMs);

    return () => clearTimeout(timer);
  }, [entry.createdAt, isNewlyCompleted]);

  return (
    <div className="relative w-full">
      {/* Background glow shadow behind card for 50 seconds */}
      <AnimatePresence>
        {isNewlyCompleted && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.40 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.8, ease: "easeInOut" }}
            className="absolute -inset-2.5 rounded-2xl blur-[24px] pointer-events-none z-0"
            style={{
              background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
              backgroundSize: '300% 300%',
              animation: 'rgbGlow 10s ease-in-out infinite',
            }}
          />
        )}
      </AnimatePresence>

      <motion.div
        layout
        initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 8 }}
      className="bg-[#0c0c0e] hover:bg-[#121215] border border-zinc-900 hover:border-zinc-800/80 rounded-2xl px-4.5 py-3.5 flex items-center gap-4 relative group transition-all duration-300"
    >
      <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/5 shadow-md">
        {videoId ? (
          <img
            src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            alt="Thumbnail"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
            <Youtube className="h-4.5 w-4.5 text-white/20" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-80 group-hover:opacity-60 transition-opacity" />
        


        {/* Duration badge overlay in bottom-right */}
        {entry.durationSecs > 0 && (
          <span className="absolute bottom-1 right-1 bg-black/80 px-1 py-0.5 rounded text-[9px] font-bold text-white/95 font-mono leading-none tracking-wide">
            {formatDuration(entry.durationSecs)}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-white/95 text-sm font-semibold truncate leading-snug group-hover:text-white transition-colors">{title}</p>
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
  </div>
  );
}
