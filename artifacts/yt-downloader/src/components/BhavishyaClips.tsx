import React, { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles, Download, Play, Loader2, AlertCircle, Clock, CheckCircle2,
  Swords, Biohazard, Wind, Landmark, ChevronDown, ChevronUp, X
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface BestClip {
  title: string;
  startSec: number;
  endSec: number;
  description: string;
  reason: string;
}

interface TopicPreset {
  id: string;
  Icon: React.ElementType;
  label: string;
  labelHindi: string;
  description: string;
  accentColor: string;
  borderColor: string;
  bgColor: string;
  glowColor: string;
  instructions: string;
}

const PRESETS: TopicPreset[] = [
  {
    id: "war",
    Icon: Swords,
    label: "War / World War",
    labelHindi: "युद्ध / विश्व युद्ध",
    description: "Nuclear war, India-Pakistan, World War prophecies",
    accentColor: "text-red-300",
    borderColor: "border-red-500/40",
    bgColor: "bg-red-500/10",
    glowColor: "shadow-[0_0_20px_rgba(239,68,68,0.2)]",
    instructions:
      "Find ONLY segments where the speaker is prophesying about yuddha (war) — World War, nuclear war, Bharat-Pakistan yuddha, America war, Iran war, missile attacks, nuclear bombs, or countries going to war. Include segments with specific war predictions, timeline mentions, or country-specific prophecies. Skip all non-war content.",
  },
  {
    id: "disease",
    Icon: Biohazard,
    label: "Diseases / Virus",
    labelHindi: "रोग / वायरस",
    description: "64 viruses coming, pandemics, lockdown predictions",
    accentColor: "text-green-300",
    borderColor: "border-green-500/40",
    bgColor: "bg-green-500/10",
    glowColor: "shadow-[0_0_20px_rgba(34,197,94,0.2)]",
    instructions:
      "Find ONLY segments about rog (disease) or virus prophecy — 64 viruses coming (chaunsath rog/virus), Corona returning, new pandemic diseases spreading, lockdown predictions, mass illness, hospitals overflowing, or any health-related disaster prophecy. The speaker mentions many diseases will come one after another. Include only clear disease/virus prophecy segments.",
  },
  {
    id: "pralay",
    Icon: Wind,
    label: "Khand Pralay",
    labelHindi: "खंड प्रलय",
    description: "Unchass vayu, agni vayu, elemental destruction",
    accentColor: "text-cyan-300",
    borderColor: "border-cyan-500/40",
    bgColor: "bg-cyan-500/10",
    glowColor: "shadow-[0_0_20px_rgba(6,182,212,0.2)]",
    instructions:
      "Find ONLY segments about khand pralay or natural destruction prophecy — unchass vayu (49 winds/tornadoes), agni vayu (fire wind), panch tattva vinash (destruction by all 5 elements), cyclones, earthquakes, floods, tornado storms, nature's wrath. The speaker describes destruction by wind, fire, water and all elements together. Include only clear natural calamity prophecy segments.",
  },
  {
    id: "jagannath",
    Icon: Landmark,
    label: "Jagannath Puri Signs",
    labelHindi: "जगन्नाथ पुरी संकेत",
    description: "Divine signs, omens, celestial signals at Puri",
    accentColor: "text-yellow-300",
    borderColor: "border-yellow-500/40",
    bgColor: "bg-yellow-500/10",
    glowColor: "shadow-[0_0_20px_rgba(234,179,8,0.2)]",
    instructions:
      "Find ONLY segments about Jagannath Puri mandir (temple) as a divine sign or omen of coming events. Look for discussions about special signs, unusual events or omens at Jagannath Puri, celestial signs near the moon or stars (tara), divine signals indicating upcoming catastrophes, or any prophecy directly referencing Jagannath Puri. Include only clear Jagannath Puri related segments.",
  },
];

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function clipKey(c: BestClip) {
  return `${c.startSec}-${c.endSec}`;
}

export function BhavishyaClips({ url }: { url: string }) {
  const { toast } = useToast();
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const esRef = useRef<EventSource | null>(null);

  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [clips, setClips] = useState<BestClip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState("");
  const [expandedClip, setExpandedClip] = useState<string | null>(null);
  const [downloadStates, setDownloadStates] = useState<Record<string, { status: "idle" | "downloading" | "done" | "error"; percent: number; message: string }>>({});

  const preset = PRESETS.find(p => p.id === selectedPreset) ?? null;

  const stopStream = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  // Close any open SSE connection when the component unmounts (e.g. tab change)
  useEffect(() => {
    return () => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
  }, []);

  const handleFind = async () => {
    if (!url.trim() || !selectedPreset || isLoading) return;
    const p = PRESETS.find(t => t.id === selectedPreset)!;

    stopStream();
    setIsLoading(true);
    setError(null);
    setClips([]);
    setExpandedClip(null);
    setDownloadStates({});
    setStatusMsg("Starting analysis…");

    try {
      const startRes = await fetch(`${BASE}/api/youtube/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), durations: [480], instructions: p.instructions }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error ?? "Failed to start analysis");

      const { jobId } = startData;
      const es = new EventSource(`${BASE}/api/youtube/clips/stream/${jobId}`);
      esRef.current = es;

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "step") {
            setStatusMsg(msg.message ?? msg.step ?? "");
          } else if (msg.type === "done") {
            setClips(msg.clips ?? []);
            if (!msg.clips?.length) {
              setError(
                !msg.hasTranscript
                  ? "No clips found — this video has no transcript. Try a video with subtitles."
                  : "No matching clips found for this topic. Try a different video."
              );
            }
            setIsLoading(false);
            setStatusMsg("");
            es.close(); esRef.current = null;
          } else if (msg.type === "error") {
            setError(msg.message ?? "Analysis failed");
            setIsLoading(false);
            setStatusMsg("");
            es.close(); esRef.current = null;
          }
        } catch {}
      };

      es.onerror = () => {
        setError("Connection lost. Please try again.");
        setIsLoading(false);
        setStatusMsg("");
        es.close(); esRef.current = null;
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start analysis");
      setIsLoading(false);
      setStatusMsg("");
    }
  };

  const handleDownload = async (clip: BestClip) => {
    const key = clipKey(clip);
    if (downloadStates[key]?.status === "downloading") return;

    setDownloadStates(prev => ({ ...prev, [key]: { status: "downloading", percent: 0, message: "Starting…" } }));

    try {
      const startRes = await fetch(`${BASE}/api/youtube/download-clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), startSec: clip.startSec, endSec: clip.endSec, title: clip.title }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error ?? "Failed to start download");

      const { jobId } = startData;

      let attempts = 0;
      const MAX_ATTEMPTS = 200;

      const poll = async (): Promise<void> => {
        if (attempts++ >= MAX_ATTEMPTS) throw new Error("Download timed out");

        const prog = await fetch(`${BASE}/api/youtube/progress/${jobId}`).then(r => r.json());

        if (prog.status === "done") {
          setDownloadStates(prev => ({ ...prev, [key]: { status: "done", percent: 100, message: "Ready!" } }));
          const a = document.createElement("a");
          a.href = `${BASE}/api/youtube/file/${jobId}`;
          a.download = `${clip.title.replace(/[^a-z0-9]/gi, "_")}.mp4`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          toast({ title: "Clip downloaded!", description: clip.title });
          return;
        }

        if (prog.status === "error" || prog.status === "expired") {
          throw new Error(prog.message ?? prog.error ?? "Download failed");
        }

        setDownloadStates(prev => ({ ...prev, [key]: { status: "downloading", percent: prog.percent ?? 0, message: prog.message ?? "" } }));
        await new Promise(r => setTimeout(r, 1500));
        return poll();
      };

      await poll();
    } catch (err) {
      setDownloadStates(prev => ({ ...prev, [key]: { status: "error", percent: 0, message: err instanceof Error ? err.message : "Error" } }));
      toast({ title: "Download failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" });
    }
  };

  const handleCancel = () => {
    stopStream();
    setIsLoading(false);
    setStatusMsg("");
    setError(null);
  };

  return (
    <div className="glass-panel rounded-3xl p-5 sm:p-6 space-y-5 border border-amber-500/10 bg-gradient-to-br from-amber-500/5 to-transparent mt-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-amber-500/30 to-orange-600/20 border border-amber-500/30 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-amber-300" />
        </div>
        <div>
          <h3 className="text-white font-display font-bold text-base leading-tight">
            Bhavishya Malika Clips
          </h3>
          <p className="text-white/40 text-xs mt-0.5">
            AI finds best ~8 min prophecy clip from any video
          </p>
        </div>
        <div className="ml-auto">
          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/25">
            8-10 min
          </span>
        </div>
      </div>

      {/* Topic preset grid */}
      <div>
        <p className="text-white/50 text-xs font-medium mb-3">Select a prophecy topic:</p>
        <div className="grid grid-cols-2 gap-3">
          {PRESETS.map((p) => {
            const { Icon } = p;
            const isActive = selectedPreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedPreset(isActive ? null : p.id)}
                disabled={isLoading}
                className={cn(
                  "relative flex flex-col items-start gap-1.5 p-3.5 rounded-2xl border text-left transition-all duration-200 group overflow-hidden",
                  isActive
                    ? cn(p.bgColor, p.borderColor, p.glowColor)
                    : "bg-white/4 border-white/8 hover:border-white/20 hover:bg-white/7"
                )}
              >
                {isActive && (
                  <span className="absolute top-2 right-2">
                    <CheckCircle2 className={cn("w-3.5 h-3.5", p.accentColor)} />
                  </span>
                )}
                <div className={cn(
                  "w-7 h-7 rounded-xl flex items-center justify-center border transition-all duration-200",
                  isActive ? cn(p.bgColor, p.borderColor) : "bg-white/6 border-white/10 group-hover:border-white/20"
                )}>
                  <Icon className={cn("w-3.5 h-3.5", isActive ? p.accentColor : "text-white/50 group-hover:text-white/70")} />
                </div>
                <div className="min-w-0 w-full pr-4">
                  <p className={cn("font-semibold text-sm leading-tight", isActive ? p.accentColor : "text-white/80")}>
                    {p.label}
                  </p>
                  <p className={cn("text-[11px] leading-tight mt-0.5", isActive ? cn(p.accentColor, "opacity-70") : "text-white/35")}>
                    {p.labelHindi}
                  </p>
                </div>
                <p className={cn("text-[11px] leading-snug", isActive ? "text-white/55" : "text-white/30")}>
                  {p.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Status / Progress */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className={cn(
              "flex items-center gap-3 p-3.5 rounded-xl border",
              preset ? cn(preset.bgColor, preset.borderColor) : "bg-white/5 border-white/10"
            )}>
              <Loader2 className={cn("w-4 h-4 animate-spin shrink-0", preset?.accentColor ?? "text-amber-300")} />
              <p className="text-white/70 text-sm flex-1 min-w-0 truncate">{statusMsg || "Analyzing video…"}</p>
              <button
                onClick={handleCancel}
                className="shrink-0 p-1 rounded-lg hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors"
                title="Cancel"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      <AnimatePresence>
        {error && !isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-start gap-3 p-3.5 rounded-xl bg-red-500/10 border border-red-500/20"
          >
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-red-300 text-sm">{error}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Find button */}
      <Button
        onClick={handleFind}
        disabled={isLoading || !url.trim() || !selectedPreset}
        className={cn(
          "w-full h-12 rounded-2xl font-semibold text-sm transition-all duration-300",
          selectedPreset && !isLoading
            ? cn(
                "text-white",
                preset?.id === "war" && "bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 shadow-[0_0_20px_rgba(239,68,68,0.3)]",
                preset?.id === "disease" && "bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 shadow-[0_0_20px_rgba(34,197,94,0.3)]",
                preset?.id === "pralay" && "bg-gradient-to-r from-cyan-600 to-sky-600 hover:from-cyan-500 hover:to-sky-500 shadow-[0_0_20px_rgba(6,182,212,0.3)]",
                preset?.id === "jagannath" && "bg-gradient-to-r from-yellow-600 to-amber-600 hover:from-yellow-500 hover:to-amber-500 shadow-[0_0_20px_rgba(234,179,8,0.3)]",
              )
            : "bg-white/8 text-white/40"
        )}
      >
        {isLoading ? (
          <span className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Finding {preset?.label} clips…
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            {selectedPreset
              ? `Find Best ${preset?.label} Clip`
              : "Select a topic above to search"}
          </span>
        )}
      </Button>

      {/* Results */}
      <AnimatePresence>
        {clips.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-3 pt-1"
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className={cn("w-4 h-4", preset?.accentColor ?? "text-amber-300")} />
              <p className={cn("text-sm font-semibold", preset?.accentColor ?? "text-amber-300")}>
                {clips.length} {clips.length === 1 ? "clip" : "clips"} found
              </p>
              <div className="h-px flex-1 bg-white/10" />
            </div>

            {clips.map((clip, idx) => {
              const key = clipKey(clip);
              const dl = downloadStates[key];
              const isExpanded = expandedClip === key;
              const dur = clip.endSec - clip.startSec;

              return (
                <motion.div
                  key={key}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.06 }}
                  className={cn(
                    "rounded-2xl border overflow-hidden transition-all duration-200",
                    preset?.bgColor ?? "bg-white/5",
                    preset?.borderColor ?? "border-white/10"
                  )}
                >
                  {/* Clip header */}
                  <button
                    type="button"
                    onClick={() => setExpandedClip(isExpanded ? null : key)}
                    className="w-full flex items-center gap-3 p-4 text-left"
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-xl flex items-center justify-center shrink-0 font-bold text-sm",
                      preset?.bgColor ?? "bg-white/10",
                      preset?.borderColor ? `border ${preset.borderColor}` : "border border-white/10"
                    )}>
                      <span className={cn("text-sm font-bold", preset?.accentColor ?? "text-amber-300")}>{idx + 1}</span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-white font-semibold text-sm leading-tight truncate">{clip.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Play className={cn("w-3 h-3 shrink-0", preset?.accentColor ?? "text-amber-300")} />
                        <span className="text-white/50 text-xs font-mono">{fmt(clip.startSec)} → {fmt(clip.endSec)}</span>
                        <span className="text-white/30 text-xs">·</span>
                        <Clock className="w-3 h-3 text-white/30 shrink-0" />
                        <span className="text-white/40 text-xs">{fmt(dur)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {dl?.status === "done" ? (
                        <span className={cn("text-xs font-semibold flex items-center gap-1", preset?.accentColor ?? "text-amber-300")}>
                          <CheckCircle2 className="w-3.5 h-3.5" /> Done
                        </span>
                      ) : dl?.status === "downloading" ? (
                        <span className="text-xs text-white/40 flex items-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {dl.percent > 0 ? `${Math.round(dl.percent)}%` : "…"}
                        </span>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDownload(clip); }}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all duration-150",
                            preset
                              ? cn(preset.bgColor, preset.borderColor, preset.accentColor, "hover:opacity-80")
                              : "bg-amber-500/10 border-amber-500/30 text-amber-300 hover:opacity-80"
                          )}
                          title="Download clip"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download
                        </button>
                      )}
                      {isExpanded
                        ? <ChevronUp className="w-4 h-4 text-white/30" />
                        : <ChevronDown className="w-4 h-4 text-white/30" />
                      }
                    </div>
                  </button>

                  {/* Expanded details */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 space-y-2 border-t border-white/5 pt-3">
                          {clip.description && (
                            <p className="text-white/60 text-sm leading-relaxed">{clip.description}</p>
                          )}
                          {clip.reason && (
                            <p className={cn("text-xs leading-relaxed italic", preset?.accentColor ? `${preset.accentColor} opacity-70` : "text-amber-300/60")}>
                              AI: {clip.reason}
                            </p>
                          )}
                          {dl?.status === "error" && (
                            <p className="text-red-400 text-xs">{dl.message}</p>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
