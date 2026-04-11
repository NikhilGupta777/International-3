import { useEffect, useState, useRef } from "react";
import { motion } from "framer-motion";
import { useGetDownloadProgress } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Download, Loader2, CheckCircle2, AlertCircle, Clock, TimerOff } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { loadActiveDownload, saveCompletedDownload } from "@/lib/download-history";

const EXPIRY_SECONDS = 2 * 60 * 60; // 2 hours

interface ActiveDownloadProps {
  jobId: string;
  onReset: () => void;
  onExpired?: () => void;
}

interface DownloadProgressPayload {
  status?: string;
  percent?: number;
  speed?: string | null;
  eta?: string | null;
  filename?: string | null;
  filesize?: number | null;
  message?: string | null;
}

export function ActiveDownload({ jobId, onReset, onExpired }: ActiveDownloadProps) {
  const { toast } = useToast();
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [fileExpired, setFileExpired] = useState(false);
  const countdownStarted = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onExpiredCalledRef = useRef(false);
  const staleResetHandledRef = useRef(false);
  const errorToastShownRef = useRef(false);
  const [sseProgress, setSseProgress] = useState<DownloadProgressPayload | null>(
    null,
  );
  const [usePollingFallback, setUsePollingFallback] = useState(
    () => typeof EventSource === "undefined",
  );

  const {
    data: progress,
    isError: progressRequestFailed,
    error: progressError,
  } = useGetDownloadProgress(jobId, {
    query: {
      queryKey: ["download-progress", jobId],
      enabled: !!jobId && usePollingFallback,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "pending" || status === "downloading" || status === "merging" ? 1000 : false;
      },
    },
  });

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    setUsePollingFallback(false);
    setSseProgress(null);
    const stream = new EventSource(
      `${import.meta.env.BASE_URL}api/youtube/progress/stream/${jobId}`,
    );

    stream.onmessage = (event) => {
      let payload: DownloadProgressPayload;
      try {
        payload = JSON.parse(event.data) as DownloadProgressPayload;
      } catch {
        return;
      }
      setSseProgress(payload);
      if (
        payload.status === "done" ||
        payload.status === "error" ||
        payload.status === "expired" ||
        payload.status === "cancelled"
      ) {
        stream.close();
      }
    };

    stream.onerror = () => {
      stream.close();
      setUsePollingFallback(true);
    };

    return () => {
      stream.close();
    };
  }, [jobId]);

  const currentProgress = sseProgress ?? (progress as DownloadProgressPayload | null);
  const status = (currentProgress?.status as string) || "pending";
  const percent = currentProgress?.percent || 0;

  const savedCompletedRef = useRef(false);

  const markExpired = () => {
    setFileExpired(true);
    if (!onExpiredCalledRef.current) {
      onExpiredCalledRef.current = true;
      onExpired?.();
    }
  };

  useEffect(() => {
    countdownStarted.current = false;
    savedCompletedRef.current = false;
    onExpiredCalledRef.current = false;
    staleResetHandledRef.current = false;
    errorToastShownRef.current = false;
    setSecondsLeft(null);
    setFileExpired(false);
    setSseProgress(null);
  }, [jobId]);

  useEffect(() => {
    if (status === "done" && !countdownStarted.current) {
      countdownStarted.current = true;
      setSecondsLeft(EXPIRY_SECONDS);

      if (!savedCompletedRef.current && currentProgress?.filename) {
        savedCompletedRef.current = true;
        const activeDl = loadActiveDownload();
        saveCompletedDownload({
          jobId,
          url: activeDl?.url ?? "",
          filename: currentProgress.filename,
          filesize: currentProgress.filesize ?? null,
          createdAt: Date.now(),
        });
      }
      intervalRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(intervalRef.current!);
            markExpired();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    if (status === "expired") {
      markExpired();
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    if (status === "error") {
      if (!errorToastShownRef.current) {
        errorToastShownRef.current = true;
        toast({
          title: "Download Failed",
          description:
            currentProgress?.message ||
            "An unexpected error occurred during processing.",
          variant: "destructive",
        });
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, currentProgress, jobId, onExpired, toast]);

  const isDone = status === "done" && !fileExpired;
  const isError = status === "error";
  const isExpired = fileExpired || status === "expired";
  const isCancelled = status === "cancelled";
  const isProcessing = status === "pending" || status === "downloading" || status === "merging";

  useEffect(() => {
    if (!progressRequestFailed || staleResetHandledRef.current) return;
    const message =
      typeof progressError === "object" &&
      progressError !== null &&
      "message" in progressError &&
      typeof (progressError as { message?: unknown }).message === "string"
        ? (progressError as { message: string }).message
        : "";

    if (/404|job not found/i.test(message)) {
      staleResetHandledRef.current = true;
      toast({
        title: "Previous job no longer exists",
        description: "Cleared stale download card.",
      });
      onReset();
    }
  }, [progressRequestFailed, progressError, onReset, toast]);

  const handleStopAndClear = async () => {
    try {
      await fetch(`${import.meta.env.BASE_URL}api/youtube/cancel/${jobId}`, {
        method: "POST",
      });
    } catch {}
    onReset();
  };

  const formatCountdown = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const countdownUrgent = secondsLeft !== null && secondsLeft < 300; // last 5 minutes

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-3xl mx-auto mt-8 relative"
    >
      <div
        className={cn(
          "absolute -inset-1 rounded-3xl blur-xl opacity-20 transition-all duration-1000",
          isDone ? "bg-green-500 opacity-30" :
          isExpired ? "bg-orange-500 opacity-30" :
          isError ? "bg-red-600 opacity-40" :
          "bg-primary opacity-50"
        )}
      />

      <div className="glass-panel rounded-3xl p-6 sm:p-8 md:p-12 relative overflow-hidden flex flex-col items-center text-center">

        {/* Status Icon */}
        <div className="mb-6">
          {isDone ? (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="bg-green-500/20 p-4 rounded-full text-green-400">
              <CheckCircle2 className="w-12 h-12" />
            </motion.div>
          ) : isExpired ? (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="bg-orange-500/20 p-4 rounded-full text-orange-400">
              <TimerOff className="w-12 h-12" />
            </motion.div>
          ) : isError ? (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="bg-red-500/20 p-4 rounded-full text-red-400">
              <AlertCircle className="w-12 h-12" />
            </motion.div>
          ) : isCancelled ? (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} className="bg-yellow-500/20 p-4 rounded-full text-yellow-300">
              <TimerOff className="w-12 h-12" />
            </motion.div>
          ) : (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
              className="bg-primary/20 p-4 rounded-full text-primary"
            >
              <Loader2 className="w-12 h-12" />
            </motion.div>
          )}
        </div>

        {/* Status Text */}
        <h3 className="text-2xl sm:text-3xl font-display font-bold text-white mb-2">
          {status === "pending" && "Initializing..."}
          {status === "downloading" && "Downloading Video..."}
          {status === "merging" && "Processing & Merging..."}
          {isCancelled && "Download Cancelled"}
          {isDone && "Ready to Save!"}
          {isExpired && "File Expired"}
          {isError && "Processing Failed"}
        </h3>

        <p className="text-white/60 mb-6 max-w-md break-all text-sm sm:text-base">
          {isExpired
            ? "The 2-hour window has passed. Start a new download to get the file."
            : currentProgress?.filename || "Preparing your file, please wait..."}
        </p>

        {/* Countdown Timer */}
        {isDone && secondsLeft !== null && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className={cn(
              "flex items-center gap-2 px-4 py-3 rounded-2xl border mb-6 transition-colors duration-500 max-w-xs sm:max-w-none",
              countdownUrgent
                ? "bg-orange-500/15 border-orange-500/40 text-orange-300"
                : "bg-white/5 border-white/10 text-white/70"
            )}
          >
            <Clock className={cn("w-4 h-4 sm:w-5 sm:h-5 shrink-0", countdownUrgent ? "text-orange-400 animate-pulse" : "text-white/40")} />
            <span className="text-xs sm:text-sm font-medium">
              File deletes in{" "}
              <span className={cn("font-bold tabular-nums", countdownUrgent ? "text-orange-300" : "text-white")}>
                {formatCountdown(secondsLeft)}
              </span>
              {" "}— save now
            </span>
          </motion.div>
        )}

        {/* Progress Bar */}
        {isProcessing && (
          <div className="w-full max-w-md mx-auto mb-8">
            <div className="flex justify-between text-sm font-medium text-white/80 mb-3">
              <span>{currentProgress?.speed || "-- MB/s"}</span>
              <span className="text-primary">{percent.toFixed(1)}%</span>
            </div>

            <div className="h-3 w-full bg-black/50 rounded-full overflow-hidden border border-white/10 shadow-inner relative">
              {status === "merging" ? (
                <motion.div
                  className="h-full bg-primary/50"
                  animate={{ x: ["-100%", "100%"] }}
                  transition={{ repeat: Infinity, duration: 1.5, ease: "easeInOut" }}
                  style={{ width: "50%" }}
                />
              ) : (
                <motion.div
                  className="h-full bg-gradient-to-r from-primary to-rose-400 relative"
                  initial={{ width: 0 }}
                  animate={{ width: `${percent}%` }}
                  transition={{ ease: "linear", duration: 0.5 }}
                >
                  <div className="absolute inset-0 bg-white/20 w-full animate-pulse" />
                </motion.div>
              )}
            </div>

            <div className="flex justify-between text-xs text-white/50 mt-3">
              <span>Size: {currentProgress?.filesize ? formatBytes(currentProgress.filesize) : "Calculating..."}</span>
              <span>{currentProgress?.eta ? `ETA: ${currentProgress.eta}` : "--:--"}</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm justify-center">
          {isProcessing && (
            <Button variant="outline" size="lg" onClick={handleStopAndClear} className="w-full sm:w-auto">
              Stop & Clear
            </Button>
          )}

          {isDone && (
            <Button
              asChild
              size="lg"
              className="w-full sm:w-auto text-glow shadow-[0_0_30px_rgba(229,9,20,0.4)]"
            >
              <a href={`${import.meta.env.BASE_URL}api/youtube/file/${jobId}`} download>
                <Download className="w-5 h-5 mr-2" />
                Save File to Device
              </a>
            </Button>
          )}

          {(isDone || isError || isExpired) && (
            <Button variant="outline" size="lg" onClick={onReset} className="w-full sm:w-auto">
              {isExpired ? "Download Again" : "Download Another"}
            </Button>
          )}
          {isCancelled && (
            <Button variant="outline" size="lg" onClick={onReset} className="w-full sm:w-auto">
              Start New Download
            </Button>
          )}
        </div>

      </div>
    </motion.div>
  );
}
