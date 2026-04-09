import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Scissors,
  Youtube,
  Clock,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { ActiveDownload } from "@/components/ActiveDownload";

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
  if (h > 0)
    return `${h}h ${m}m ${s}s`;
  if (m > 0)
    return `${m}m ${s}s`;
  return `${s}s`;
}

export function ClipCutter() {
  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [quality, setQuality] = useState("best");
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const { toast } = useToast();

  const startSecs = parseTimeToSeconds(startTime);
  const endSecs = parseTimeToSeconds(endTime);
  const clipDuration =
    startSecs !== null && endSecs !== null && endSecs > startSecs
      ? endSecs - startSecs
      : null;

  const handleCut = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      toast({ title: "Enter a YouTube URL", variant: "destructive" });
      return;
    }
    if (startSecs === null) {
      toast({
        title: "Invalid start time",
        description: 'Use a format like 1:30 or 0:45',
        variant: "destructive",
      });
      return;
    }
    if (endSecs === null) {
      toast({
        title: "Invalid end time",
        description: 'Use a format like 2:00 or 1:30',
        variant: "destructive",
      });
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

    setLoading(true);
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
      setJobId(data.jobId);
    } catch (err) {
      toast({
        title: "Clip cut failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <AnimatePresence mode="wait">
        {!jobId ? (
          <motion.form
            key="form"
            onSubmit={handleCut}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
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
                  Paste a URL, set your start & end time — only that clip gets downloaded
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
                  autoFocus
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

            {clipDuration !== null && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-xl px-4 py-3"
              >
                <Scissors className="w-4 h-4 text-orange-400 shrink-0" />
                <span className="text-sm text-orange-300 font-medium">
                  Clip duration: <span className="font-bold">{formatDuration(clipDuration)}</span>
                </span>
              </motion.div>
            )}

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
                        : "bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20"
                    )}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>

            <Button
              type="submit"
              disabled={loading || !url.trim() || !startTime.trim() || !endTime.trim()}
              className="h-12 rounded-xl bg-orange-500 hover:bg-orange-400 text-white font-semibold text-base shadow-[0_0_25px_rgba(249,115,22,0.4)] disabled:opacity-50 disabled:shadow-none transition-all"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Starting...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Scissors className="w-4 h-4" />
                  Cut &amp; Download
                </span>
              )}
            </Button>
          </motion.form>
        ) : (
          <motion.div
            key="progress"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <ActiveDownload
              jobId={jobId}
              onReset={() => {
                setJobId(null);
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
