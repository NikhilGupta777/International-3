import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Clock, Loader2, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type SceneMatch = {
  title: string;
  startSec: number | null;
  endSec: number | null;
  confidence: number;
  reason: string;
  quote: string;
};

type SceneFinderResult = {
  summary: string;
  scenes: SceneMatch[];
};

type SceneStatus = {
  status?: string;
  message?: string;
  progressPct?: number | null;
  result?: SceneFinderResult | null;
};

function formatTime(sec: number | null) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "--:--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function KathaSceneFinder() {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { toast } = useToast();
  const pollRef = useRef<number | null>(null);

  const [query, setQuery] = useState("");
  const [transcript, setTranscript] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "queued" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SceneFinderResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopPolling = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollStatus = async (nextJobId: string) => {
    const res = await fetch(`${BASE}/api/scene-finder/status/${encodeURIComponent(nextJobId)}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Could not read job status");
    const data = (await res.json()) as SceneStatus;
    const nextStatus = data.status === "done" || data.status === "error"
      ? data.status
      : data.status === "queued"
        ? "queued"
        : "running";
    setStatus(nextStatus);
    setMessage(data.message ?? "");
    setProgress(typeof data.progressPct === "number" ? data.progressPct : nextStatus === "queued" ? 5 : 40);

    if (nextStatus === "done") {
      stopPolling();
      setResult(data.result ?? { summary: "", scenes: [] });
      setProgress(100);
      toast({ title: "Scene Finder complete", description: "Matching scenes are ready." });
    } else if (nextStatus === "error") {
      stopPolling();
      setError(data.message ?? "Scene matching failed");
    }
  };

  const start = async () => {
    stopPolling();
    setError(null);
    setResult(null);
    setProgress(0);

    const cleanQuery = query.trim();
    const cleanTranscript = transcript.trim();
    if (!cleanQuery || cleanTranscript.length < 20) {
      setError("Add what to find and paste the transcript/source text.");
      return;
    }

    setStatus("queued");
    setMessage("Starting...");
    try {
      const res = await fetch(`${BASE}/api/scene-finder/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: cleanQuery, transcript: cleanTranscript }),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) throw new Error(data.error ?? "Failed to start Scene Finder");
      setJobId(data.jobId);
      setMessage("Queued - starting soon...");
      await pollStatus(data.jobId);
      pollRef.current = window.setInterval(() => {
        void pollStatus(data.jobId!).catch((err) => {
          setError(err instanceof Error ? err.message : "Status check failed");
        });
      }, 2500);
    } catch (err) {
      stopPolling();
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to start Scene Finder");
    }
  };

  const busy = status === "queued" || status === "running";

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="w-full max-w-5xl mx-auto"
    >
      <div className="glass-panel rounded-3xl border border-cyan-500/20 overflow-hidden">
        <div className="p-5 sm:p-6 border-b border-white/10 flex items-start gap-3">
          <div className="w-11 h-11 rounded-2xl bg-cyan-500/15 border border-cyan-400/30 flex items-center justify-center">
            <Search className="w-5 h-5 text-cyan-200" />
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-display font-bold text-white">Katha Scene Finder</h2>
            <p className="text-sm text-white/55 mt-1">
              Paste transcript or timestamped notes, then ask what scene/topic to find.
            </p>
          </div>
        </div>

        <div className="p-5 sm:p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.22em] text-white/45 font-semibold">Find request</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Example: Find strong Kalki avatar prophecy scenes with clear emotional lines"
              className="w-full rounded-2xl bg-black/35 border border-white/10 px-4 py-3 text-white placeholder:text-white/30 outline-none focus:border-cyan-400/60"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs uppercase tracking-[0.22em] text-white/45 font-semibold">Transcript / source text</label>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder="Paste SRT, transcript, timestamped notes, or scene text here..."
              className="w-full min-h-[260px] rounded-2xl bg-black/35 border border-white/10 px-4 py-3 text-white placeholder:text-white/30 outline-none focus:border-cyan-400/60 resize-y"
            />
            <p className="text-xs text-white/35">{transcript.length.toLocaleString()} characters</p>
          </div>

          <Button
            type="button"
            onClick={start}
            disabled={busy || !query.trim() || transcript.trim().length < 20}
            className="w-full h-12 rounded-2xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold"
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Processing
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Sparkles className="w-4 h-4" />
                Find Matching Scenes
              </span>
            )}
          </Button>

          {jobId && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-white/60 inline-flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  {message || status}
                </span>
                <span className="text-white/45">{progress}%</span>
              </div>
              <div className="mt-3 h-2 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-all duration-500"
                  style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-red-100 flex gap-3">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-emerald-100 flex gap-3">
                <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{result.summary || `${result.scenes.length} scenes found.`}</span>
              </div>

              <div className="grid grid-cols-1 gap-4">
                {result.scenes.map((scene, index) => (
                  <article key={`${scene.title}-${index}`} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <h3 className="text-white font-bold">{scene.title}</h3>
                      <span className="text-cyan-200 text-sm font-semibold">
                        {formatTime(scene.startSec)} - {formatTime(scene.endSec)}
                      </span>
                    </div>
                    <p className="text-white/60 text-sm mt-2">{scene.reason}</p>
                    {scene.quote && (
                      <p className="mt-3 rounded-xl bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white/75">
                        "{scene.quote}"
                      </p>
                    )}
                    <p className="text-xs text-white/35 mt-3">
                      Confidence: {Math.round(scene.confidence * 100)}%
                    </p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.section>
  );
}
