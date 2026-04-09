import React, { useState, useEffect, useRef } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

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

type JobStatus = "pending" | "downloading" | "merging" | "done" | "error";

interface ActiveJob {
  jobId: string;
  label: string;
  status: JobStatus;
  percent: number;
  speed: string | null;
  eta: string | null;
  filename: string | null;
  filesize: number | null;
  message: string | null;
  downloaded: boolean;
}

export function ClipCutter() {
  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [quality, setQuality] = useState("best");
  const [submitting, setSubmitting] = useState(false);
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const { toast } = useToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobsRef = useRef<ActiveJob[]>([]);
  jobsRef.current = jobs;

  const startSecs = parseTimeToSeconds(startTime);
  const endSecs = parseTimeToSeconds(endTime);
  const clipDuration =
    startSecs !== null && endSecs !== null && endSecs > startSecs
      ? endSecs - startSecs
      : null;

  useEffect(() => {
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      const current = jobsRef.current;
      const active = current.filter(
        (j) => j.status !== "done" && j.status !== "error",
      );

      if (active.length === 0) return;

      await Promise.all(
        active.map(async (job) => {
          try {
            const res = await fetch(
              `${BASE_URL}/api/youtube/progress/${job.jobId}`,
            );
            if (!res.ok) return;
            const data = await res.json();

            setJobs((prev) =>
              prev.map((j) => {
                if (j.jobId !== job.jobId) return j;
                const updated: ActiveJob = {
                  ...j,
                  status: data.status as JobStatus,
                  percent: data.percent ?? j.percent,
                  speed: data.speed ?? null,
                  eta: data.eta ?? null,
                  filename: data.filename ?? j.filename,
                  filesize: data.filesize ?? j.filesize,
                  message: data.message ?? null,
                };

                if (data.status === "done" && !j.downloaded) {
                  updated.downloaded = true;
                  const link = document.createElement("a");
                  link.href = `${BASE_URL}/api/youtube/file/${j.jobId}`;
                  link.download = data.filename ?? "clip.mp4";
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                }

                return updated;
              }),
            );
          } catch {}
        }),
      );
    }, 1500);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
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

      const data = (await res.json()) as { jobId: string };
      const label = `${secsToLabel(startSecs)} → ${secsToLabel(endSecs)}`;

      const newJob: ActiveJob = {
        jobId: data.jobId,
        label,
        status: "pending",
        percent: 0,
        speed: null,
        eta: null,
        filename: null,
        filesize: null,
        message: null,
        downloaded: false,
      };

      setJobs((prev) => [newJob, ...prev]);
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
    setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
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
          <label className="text-[11px] font-bold uppercase tracking-widest text-white/35">
            YouTube URL
          </label>
          <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-orange-500/40 transition-colors">
            <Youtube className="w-4 h-4 text-white/30 shrink-0" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              className="bg-transparent flex-1 outline-none text-white placeholder:text-white/25 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-bold uppercase tracking-widest text-white/35">
              Start Time
            </label>
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-orange-500/40 transition-colors">
              <Clock className="w-4 h-4 text-white/30 shrink-0" />
              <input
                type="text"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                placeholder="0:00"
                className="bg-transparent flex-1 outline-none text-white placeholder:text-white/25 text-sm font-mono"
              />
            </div>
            <span className="text-[11px] text-white/30">e.g. 1:30 or 1:02:45</span>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-bold uppercase tracking-widest text-white/35">
              End Time
            </label>
            <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-orange-500/40 transition-colors">
              <Clock className="w-4 h-4 text-white/30 shrink-0" />
              <input
                type="text"
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

      {/* Inline download cards — one per active/completed job */}
      <AnimatePresence initial={false}>
        {jobs.map((job) => (
          <ClipJobCard key={job.jobId} job={job} onRemove={removeJob} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ClipJobCard({
  job,
  onRemove,
}: {
  job: ActiveJob;
  onRemove: (id: string) => void;
}) {
  const isDone = job.status === "done";
  const isError = job.status === "error";
  const isProcessing =
    job.status === "pending" ||
    job.status === "downloading" ||
    job.status === "merging";

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
        isProcessing && "border-orange-500/15",
      )}
    >
      {/* Glow */}
      <div
        className={cn(
          "absolute top-0 right-0 w-40 h-40 blur-[60px] rounded-full pointer-events-none opacity-20",
          isDone && "bg-green-500",
          isError && "bg-red-500",
          isProcessing && "bg-orange-500",
        )}
      />

      <div className="flex items-center justify-between gap-3 relative z-10">
        <div className="flex items-center gap-2.5 min-w-0">
          {isDone ? (
            <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
          ) : isError ? (
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          ) : (
            <Loader2 className="w-4 h-4 text-orange-400 animate-spin shrink-0" />
          )}
          <span className="text-sm font-semibold text-white font-mono truncate">
            {job.label}
          </span>
          {job.filename && (
            <span className="text-xs text-white/35 truncate hidden sm:block">
              {job.filename}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isDone && (
            <a
              href={`${BASE_URL}/api/youtube/file/${job.jobId}`}
              download={job.filename ?? "clip.mp4"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/25 border border-green-500/30 text-green-300 text-xs font-semibold transition-all"
            >
              <Download className="w-3 h-3" />
              Save
            </a>
          )}
          {(isDone || isError) && (
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
            {job.status === "merging" ? (
              <motion.div
                className="h-full bg-orange-500/60 rounded-full"
                animate={{ x: ["-100%", "100%"] }}
                transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
                style={{ width: "50%" }}
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
              {job.status === "merging"
                ? "Processing…"
                : job.status === "pending"
                  ? "Starting…"
                  : job.speed
                    ? job.speed
                    : "Connecting…"}
            </span>
            <span>
              {job.status === "downloading" && job.percent > 0
                ? `${job.percent.toFixed(0)}%`
                : job.eta
                  ? `ETA ${job.eta}`
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

      {isDone && (
        <p className="text-xs text-green-400/70 relative z-10">
          Downloaded automatically — use Save if it didn't open.
        </p>
      )}
    </motion.div>
  );
}
