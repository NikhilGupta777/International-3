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
}

export function ClipCutter() {
  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [quality, setQuality] = useState("best");
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [history, setHistory] = useState<ClipHistoryEntry[]>(() => loadClipHistory());
  const { toast } = useToast();
  const streamRefs = useRef<Map<string, EventSource>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollInFlightRef = useRef(false);
  const jobsRef = useRef<ActiveJob[]>([]);
  jobsRef.current = jobs;

  const startSecs = parseTimeToSeconds(startTime);
  const endSecs = parseTimeToSeconds(endTime);
  const clipDuration =
    startSecs !== null && endSecs !== null && endSecs > startSecs
      ? endSecs - startSecs
      : null;

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
  }, [jobs, applyProgressUpdate, closeJobStream, refreshJobOnce]);

  useEffect(() => {
    return () => {
      for (const stream of streamRefs.current.values()) {
        stream.close();
      }
      streamRefs.current.clear();
    };
  }, []);

  const handleCut = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      toast({ title: "Enter a YouTube URL", variant: "destructive" });
      return;
    }
    if (startSecs === null) {
      toast({ title: "Invalid start time", description: "Use 1:30 or 0:45", variant: "destructive" });
      return;
    }
    if (endSecs === null) {
      toast({ title: "Invalid end time", description: "Use 2:00 or 1:30", variant: "destructive" });
      return;
    }
    if (endSecs <= startSecs) {
      toast({ title: "End time must be after start time", variant: "destructive" });
      return;
    }
    if (endSecs - startSecs > 3600) {
      toast({ title: "Clip cannot exceed 60 minutes", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/youtube/clip-cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          startTime: startSecs,
          endTime: endSecs,
          quality,
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
        url: url.trim(),
        quality,
        startSecs,
        endSecs,
        status: normalizeJobStatus(data.status, "pending"),
        percent: 0,
        speed: null,
        eta: null,
        filename: null,
        filesize: null,
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
      setStartTime("");
      setEndTime("");
    } catch (err) {
      toast({
        title: "Failed to start clip",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
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

  const downloadClip = useCallback(async (job: ActiveJob) => {
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

    void downloadClip(ready).finally(() => {
      setJobs((prev) =>
        prev.map((j) =>
          j.jobId === ready.jobId ? { ...j, downloaded: true } : j,
        ),
      );
    });
  }, [downloadClip, jobs]);

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
    <div className="flex flex-col gap-5">
      {/* Form — always visible */}
      <motion.form
        onSubmit={handleCut}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="glass-panel rounded-3xl p-6 sm:p-8 flex flex-col gap-6 relative overflow-hidden"
      >
        <div className="absolute top-0 right-0 w-64 h-64 bg-orange-500/10 blur-[80px] rounded-full pointer-events-none" />

        <div className="flex items-center gap-3">
          <div className="bg-orange-500/20 p-2.5 rounded-xl border border-orange-500/30 shadow-[0_0_20px_rgba(249,115,22,0.2)]">
            <Scissors className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Clip Cutter</h2>
            <p className="text-sm text-white/45">
              Set start &amp; end time — only that section gets downloaded
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="clipcutter-url"
            className="text-[11px] font-bold uppercase tracking-widest text-white/35"
          >
            YouTube URL
          </label>
          <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-orange-500/40 transition-colors">
            <Youtube className="w-4 h-4 text-white/30 shrink-0" />
            <input
              id="clipcutter-url"
              name="clipcutter_url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-label="YouTube URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              className="bg-transparent flex-1 outline-none text-white placeholder:text-white/25 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="clipcutter-start-time"
              className="text-[11px] font-bold uppercase tracking-widest text-white/35"
            >
              Start Time
            </label>
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-orange-500/40 transition-colors">
              <Clock className="w-4 h-4 text-white/30 shrink-0" />
                <input
                  id="clipcutter-start-time"
                  name="clipcutter_start_time"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Clip start time"
                  value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                placeholder="0:00"
                className="bg-transparent flex-1 outline-none text-white placeholder:text-white/25 text-sm font-mono"
              />
            </div>
            <span className="text-[11px] text-white/30">e.g. 1:30 or 1:02:45</span>
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="clipcutter-end-time"
              className="text-[11px] font-bold uppercase tracking-widest text-white/35"
            >
              End Time
            </label>
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-orange-500/40 transition-colors">
              <Clock className="w-4 h-4 text-white/30 shrink-0" />
                <input
                  id="clipcutter-end-time"
                  name="clipcutter_end_time"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Clip end time"
                  value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                placeholder="0:30"
                className="bg-transparent flex-1 outline-none text-white placeholder:text-white/25 text-sm font-mono"
              />
            </div>
            <span className="text-[11px] text-white/30">e.g. 2:00 or 1:05:00</span>
          </div>
        </div>

        <AnimatePresence>
          {clipDuration !== null && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-xl px-4 py-3"
            >
              <Scissors className="w-4 h-4 text-orange-400 shrink-0" />
              <span className="text-sm text-orange-300 font-medium">
                Clip duration:{" "}
                <span className="font-bold">{formatDuration(clipDuration)}</span>
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex flex-col gap-2">
          <label className="text-[11px] font-bold uppercase tracking-widest text-white/35">
            Quality
          </label>
          <div className="flex flex-wrap gap-2">
            {QUALITY_OPTIONS.map((q) => (
              <button
                key={q.value}
                type="button"
                onClick={() => setQuality(q.value)}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-medium border transition-all",
                  quality === q.value
                    ? "bg-orange-500/20 border-orange-500/40 text-orange-300 shadow-[0_0_12px_rgba(249,115,22,0.2)]"
                    : "bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20",
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>

        <Button
          type="submit"
          disabled={submitting || !url.trim() || !startTime.trim() || !endTime.trim()}
          className="h-12 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-semibold text-base shadow-[0_0_25px_rgba(249,115,22,0.4)] disabled:opacity-50 disabled:shadow-none transition-all"
        >
          {submitting ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Starting…
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Scissors className="w-4 h-4" />
              Cut &amp; Download
            </span>
          )}
        </Button>
      </motion.form>

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
            className="flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-white/40">
                <History className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-wider">
                  Clip history · saved on this device
                </span>
              </div>
              <button
                onClick={() => {
                  const confirmed = window.confirm(
                    "Clear all clip history from this device?",
                  );
                  if (!confirmed) return;
                  clearClipHistory();
                  setHistory([]);
                }}
                className="flex items-center gap-1 text-xs text-white/25 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Clear all
              </button>
            </div>

            <div className="flex flex-col gap-2">
              {history.map((entry) => (
                <motion.div
                  key={entry.jobId}
                  layout
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  className="glass-panel rounded-xl px-4 py-3 flex items-center gap-3"
                >
                  <Film className="w-4 h-4 text-orange-400/70 shrink-0" />

                  <div className="flex-1 min-w-0">
                    <p className="text-white/70 text-sm font-medium font-mono truncate">
                      {entry.label}
                    </p>
                    <p className="text-white/30 text-xs mt-0.5 truncate">
                      {entry.quality === "best" ? "Best quality" : `${entry.quality}p`}
                      {" · "}{formatDuration(entry.durationSecs)}
                      {entry.filesize ? ` · ${formatFilesize(entry.filesize)}` : ""}
                      {" · "}{formatClipRelativeTime(entry.createdAt)}
                    </p>
                    <p className="text-white/20 text-xs truncate" title={entry.url}>
                      {entry.url}
                    </p>
                  </div>

                  <button
                    onClick={() => setHistory(deleteFromClipHistory(entry.jobId))}
                    title="Remove from history"
                    className="p-1.5 rounded-lg hover:bg-red-500/15 text-white/20 hover:text-red-400 transition-colors shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </motion.div>
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

  const isConnecting =
    (job.status === "pending" || job.status === "downloading") &&
    job.percent === 0;
  const isCancelling = isProcessing && (job.message ?? "").toLowerCase().includes("cancel");
  const queuePositionMatch = job.message?.match(/queued\s*\(#(\d+)\)/i);
  const queuePosition = queuePositionMatch ? Number.parseInt(queuePositionMatch[1], 10) : null;
  const isQueued = job.status === "pending" && (job.message ?? "").toLowerCase().includes("queued");

  const elapsed = useElapsed(job.startedAt, isProcessing);

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
            {isConnecting || job.status === "merging" ? (
              <motion.div
                className={cn(
                  "h-full rounded-full",
                  isConnecting
                    ? "bg-gradient-to-r from-transparent via-orange-400/70 to-transparent"
                    : "bg-orange-500/60",
                )}
                animate={{ x: ["-100%", "200%"] }}
                transition={{
                  repeat: Infinity,
                  duration: isConnecting ? 1.8 : 1.5,
                  ease: "easeInOut",
                }}
                style={{ width: "45%" }}
              />
            ) : (
              <motion.div
                className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full"
                animate={{ width: `${job.percent}%` }}
                transition={{ ease: "linear", duration: 0.5 }}
                style={{ width: `${job.percent}%` }}
              />
            )}
          </div>
          <div className="flex justify-between text-[11px] text-white/40">
            <span>
              {job.reconnected && job.status === "pending"
                ? "Reconnecting…"
                : isQueued
                  ? (job.message ?? "Queued - starting soon...")
                : job.status === "merging"
                  ? "Merging…"
                  : isConnecting
                    ? elapsed < 15
                      ? "Starting worker…"
                      : elapsed < 40
                        ? "Worker booting up…"
                        : "Downloading…"
                    : job.speed
                      ? job.speed
                      : "Downloading…"}
            </span>
            <span className="font-mono">
              {job.status === "downloading" && job.percent > 0
                ? `${job.percent.toFixed(0)}%`
                : job.eta
                  ? `ETA ${job.eta}`
                  : isProcessing
                    ? fmtElapsed(elapsed)
                    : ""}
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
          Clip is ready. Use Save to download.
        </p>
      )}
    </motion.div>
  );
}
