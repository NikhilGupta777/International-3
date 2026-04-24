import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Scissors,
  Sparkles,
  Clock,
  Download,
  Play,
  ChevronDown,
  ChevronUp,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Info,
  Film,
  Wifi,
  FileText,
  Bot,
  AlertTriangle,
  Wand2,
  Timer,
  Pencil,
  Swords,
  Biohazard,
  Wind,
  Landmark,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { saveToBestClipsHistory } from "@/lib/best-clips-history";

export interface BestClip {
  durationLabel: string;
  durationSec: number;
  startSec: number;
  endSec: number;
  startFormatted: string;
  endFormatted: string;
  title: string;
  description: string;
  reason: string;
}

const DURATION_OPTIONS = [
  {
    label: "1 min",
    value: 60,
    color: "from-blue-500/30 to-blue-600/10",
    badge: "text-blue-300 border-blue-500/30 bg-blue-500/10",
    accent: "border-blue-500/20 bg-blue-500/5",
  },
  {
    label: "3 min",
    value: 180,
    color: "from-purple-500/30 to-purple-600/10",
    badge: "text-purple-300 border-purple-500/30 bg-purple-500/10",
    accent: "border-purple-500/20 bg-purple-500/5",
  },
  {
    label: "≥ 5 min",
    value: 9999,
    color: "from-amber-500/30 to-amber-600/10",
    badge: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    accent: "border-amber-500/20 bg-amber-500/5",
  },
];

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
  activeBtnClass: string;
  instructions: string;
}

const TOPIC_PRESETS: TopicPreset[] = [
  {
    id: "war",
    Icon: Swords,
    label: "War / World War",
    labelHindi: "युद्ध / विश्व युद्ध",
    description: "Nuclear war, India-Pakistan, World War prophecies",
    accentColor: "text-red-300",
    borderColor: "border-red-500/40",
    bgColor: "bg-red-500/10",
    glowColor: "shadow-[0_0_16px_rgba(239,68,68,0.2)]",
    activeBtnClass:
      "bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 shadow-[0_0_18px_rgba(239,68,68,0.3)]",
    instructions:
      "This is a Bhavishya Malika prophecy video. PRIORITY TOPIC: Find the best segment(s) where the speaker talks about yuddha (war) prophecy — this includes World War, nuclear war, Bharat-Pakistan war, America war, Iran war, missile attacks, nuclear bombs, war between countries, or any bhavishya (future prediction) about war. The speaker may use Hindi words like yuddha, ladai, Vishwa Yuddha, parmanu bomb, or missile. Strongly prefer segments that have specific war predictions. Return the best matching clips even if the war discussion is mixed with other topics.\n\nCLIP LENGTH: Target 8-10 minutes (480-600 seconds). HARD LIMIT: never return a clip longer than approx 10 minutes (600 seconds). If the war topic spans a longer section, find the densest 8-10 min window within it. Anchor the clip start at the EXACT moment the speaker FIRST mentions war/yuddha in this segment — do not skip the introduction before the starting so it makes perfect sense of starting of the clip.  End the clip when the speaker transitions away from the disease topic, dont end at time when speaker is sying something, end at the best time when its best to end the clip.",
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
    glowColor: "shadow-[0_0_16px_rgba(34,197,94,0.2)]",
    activeBtnClass:
      "bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 shadow-[0_0_18px_rgba(34,197,94,0.3)]",
    instructions:
      "This is a Bhavishya Malika prophecy video. PRIORITY TOPIC: Find the best segment(s) where the speaker talks about rog (disease) or virus prophecy — this includes 64 viruses coming (chaunsath rog or chaunsath virus), Corona returning, new pandemics, mass illness spreading, lockdown predictions, hospitals overflowing, or any bhavishya (future prediction) about disease. The speaker may use Hindi words like rog, bimari, virus, mahamari, lockdown. Return the best matching clips even if the disease discussion is mixed with other topics.\n\nCLIP LENGTH: Target 8-10 minutes (480-600 seconds). HARD LIMIT: never return a clip longer than approx 10 minutes (600 seconds). If the Diseases / Virus topic spans a longer section, find the densest 8-10 min window within it. Anchor the clip start at the EXACT moment the speaker FIRST mentions rog/bimari/disease in this segment. End the clip when the speaker transitions away from the disease topic, dont end at time when speaker is sying something, end at the best time when its best to end the clip.",
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
    glowColor: "shadow-[0_0_16px_rgba(6,182,212,0.2)]",
    activeBtnClass:
      "bg-gradient-to-r from-cyan-600 to-sky-600 hover:from-cyan-500 hover:to-sky-500 shadow-[0_0_18px_rgba(6,182,212,0.3)]",
    instructions:
      "This is a Bhavishya Malika prophecy video. PRIORITY TOPIC: Find the best segment(s) where the speaker talks about khand pralay or natural destruction prophecy — this includes unchass vayu (49 winds or 49 tornadoes), agni vayu (fire wind), panch tattva vinash (destruction by 5 elements), cyclones, earthquakes, floods, storms destroying the earth, or any bhavishya (future prediction) about natural disasters. The speaker may use Hindi words like pralay, khand pralay, vayu, agni, jal pralay, bhu-dol. Return the best matching clips even if the pralay discussion is mixed with other topics.\n\nCLIP LENGTH: Target 8-10 minutes (480-600 seconds). HARD LIMIT: never return a clip longer than approx 10 minutes (600 seconds). If the war topic spans a longer section, find the densest 8-10 min window within it. Anchor the clip start at the EXACT moment the speaker FIRST mentions pralay/vayu/agni/destruction of 5 elements of earth etc., in this segment.  End the clip when the speaker transitions away from the disease topic, dont end at time when speaker is sying something, end at the best time when its best to end the clip.",
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
    glowColor: "shadow-[0_0_16px_rgba(234,179,8,0.2)]",
    activeBtnClass:
      "bg-gradient-to-r from-yellow-600 to-amber-600 hover:from-yellow-500 hover:to-amber-500 shadow-[0_0_18px_rgba(234,179,8,0.3)]",
    instructions:
      "This is a Bhavishya Malika prophecy video. PRIORITY TOPIC: Find the best segment(s) where the speaker mentions Jagannath Puri as a divine sign or omen — this includes special signs at Jagannath Puri mandir, celestial signs (moon, stars, tara) near the temple, omens of coming events, unusual happenings at Puri, or any bhavishya (future prediction) directly referencing Jagannath Puri. Return the best matching clips. If Jagannath Puri is not mentioned specifically, return the most spiritually significant prophecy segment from the video.\n\nCLIP LENGTH: Target 8-10 minutes (480-600 seconds). HARD LIMIT: never return a clip longer than 10 minutes (600 seconds). Anchor the clip start at the EXACT moment the speaker FIRST mentions Jagannath Puri or the temple sign in this segment or when u think best time to start the clip — do not start the clip mid-discussion. End when the Jagannath Puri topic concludes.",
  },
];

type StepStatus = "idle" | "running" | "done" | "warn" | "error";
interface StepState {
  status: StepStatus;
  message: string;
  data?: Record<string, any>;
  startedAt?: number;
}

type ClipKey = string;
interface DownloadState {
  status: "idle" | "downloading" | "done" | "error" | "cancelled";
  percent: number;
  jobId?: string;
  message?: string;
  startedAt?: number;
  elapsed?: number;
  eta?: string | null;
  speed?: string | null;
}

const STEPS = ["metadata", "transcript", "ai"] as const;
type StepName = (typeof STEPS)[number];

const STEP_META: Record<StepName, { label: string; icon: any }> = {
  metadata: { label: "Video info", icon: Wifi },
  transcript: { label: "Transcript", icon: FileText },
  ai: { label: "AI analysis", icon: Bot },
};

interface Props {
  url: string;
  onEditClip?: (clip: BestClip) => void;
  defaultInstructions?: string;
}
export interface BestClipsHandle {
  startAnalyze: () => void;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

// Rough estimate of total analysis time based on video length
function estimateTotalSec(videoDur: number): number {
  const metaSec = 10;
  const transcriptSec = 20;
  // ~4s per minute of video for AI, min 45s
  const aiSec = Math.max(45, Math.round(videoDur / 15));
  return metaSec + transcriptSec + aiSec;
}

function formatRemaining(remainingSec: number): string {
  if (remainingSec <= 0) return "finishing…";
  if (remainingSec < 60) return `~${remainingSec}s left`;
  return `~${Math.ceil(remainingSec / 60)}min left`;
}

export const BestClips = forwardRef(function BestClips(
  { url, onEditClip, defaultInstructions }: Props,
  ref: React.ForwardedRef<BestClipsHandle>,
) {
  const [selectedDurations, setSelectedDurations] = useState<number[]>([60]);
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [is8MinMode, setIs8MinMode] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [customInstructions, setCustomInstructions] = useState(
    defaultInstructions ?? "",
  );
  const [clips, setClips] = useState<BestClip[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasTranscript, setHasTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedClip, setExpandedClip] = useState<ClipKey | null>(null);
  const [downloadStates, setDownloadStates] = useState<
    Record<ClipKey, DownloadState>
  >({});
  const [steps, setSteps] = useState<Record<StepName, StepState>>({
    metadata: { status: "idle", message: "" },
    transcript: { status: "idle", message: "" },
    ai: { status: "idle", message: "" },
  });
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [videoDurationSec, setVideoDurationSec] = useState(0);
  const analysisStartRef = useRef<number | null>(null);
  const analysisJobIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const analysisStatusTimerRef = useRef<number | null>(null);
  const analysisStatusErrorCountRef = useRef(0);
  const resultsKeyRef = useRef(0); // bumped on each new analysis to force clean remount of results
  const downloadPollRefs = useRef<Map<ClipKey, number>>(new Map());
  const { toast } = useToast();

  const PERSIST_KEY = "ytgrabber_bestclips_results";

  // Restore saved analysis results when URL matches
  useEffect(() => {
    if (!url.trim()) return;
    try {
      const raw = sessionStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { url: string; clips: BestClip[]; hasTranscript: boolean };
      if (saved.url === url.trim() && saved.clips?.length > 0) {
        setClips(saved.clips);
        setHasTranscript(saved.hasTranscript ?? false);
      }
    } catch {}
  // Only run when URL changes — not on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Single always-running 1s ticker — updates analysis elapsed + all active download elapsed values
  useEffect(() => {
    const interval = setInterval(() => {
      if (analysisStartRef.current !== null) {
        setAnalysisElapsed(
          Math.floor((Date.now() - analysisStartRef.current) / 1000),
        );
      }
      setDownloadStates((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const key of Object.keys(next)) {
          if (next[key].status === "downloading" && next[key].startedAt) {
            next[key] = {
              ...next[key],
              elapsed: Math.floor((Date.now() - next[key].startedAt!) / 1000),
            };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    return () => {
      if (analysisStatusTimerRef.current !== null) {
        window.clearInterval(analysisStatusTimerRef.current);
        analysisStatusTimerRef.current = null;
      }
      analysisStatusErrorCountRef.current = 0;
      analysisJobIdRef.current = null;
      esRef.current?.close();
      esRef.current = null;
      for (const id of downloadPollRefs.current.values()) {
        window.clearInterval(id);
      }
      downloadPollRefs.current.clear();
    };
  }, []);

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "");

  const clipKey = (clip: BestClip): ClipKey =>
    `${clip.durationSec}|${clip.startSec}`;

  const setDownload = useCallback(
    (key: ClipKey, patch: Partial<DownloadState>) => {
      setDownloadStates((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? { status: "idle", percent: 0 }), ...patch },
      }));
    },
    [],
  );

  const closeDownloadStream = useCallback((key: ClipKey) => {
    const id = downloadPollRefs.current.get(key);
    if (id !== undefined) {
      window.clearInterval(id);
      downloadPollRefs.current.delete(key);
    }
  }, []);

  const closeAllDownloadStreams = useCallback(() => {
    for (const [key, id] of downloadPollRefs.current.entries()) {
      window.clearInterval(id);
      downloadPollRefs.current.delete(key);
    }
  }, []);

  const triggerClipDownload = useCallback(
    (jobId: string, clipTitle: string) => {
      const link = document.createElement("a");
      link.href = `${BASE}/api/youtube/file/${jobId}`;
      link.download = `${clipTitle}.mp4`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [BASE],
  );

  const selectDuration = (value: number) => {
    setSelectedDurations([value]);
  };

  const resetSteps = () =>
    setSteps({
      metadata: { status: "idle", message: "" },
      transcript: { status: "idle", message: "" },
      ai: { status: "idle", message: "" },
    });

  const updateStep = (
    name: StepName,
    status: StepStatus,
    message: string,
    data?: Record<string, any>,
  ) => {
    setSteps((prev) => ({ ...prev, [name]: { status, message, data } }));
  };

  const clearAnalysisStatusPolling = useCallback(() => {
    if (analysisStatusTimerRef.current !== null) {
      window.clearInterval(analysisStatusTimerRef.current);
      analysisStatusTimerRef.current = null;
    }
    analysisStatusErrorCountRef.current = 0;
  }, []);

  const finishAnalysisWithError = useCallback(
    (message: string) => {
      clearAnalysisStatusPolling();
      analysisJobIdRef.current = null;
      analysisStartRef.current = null;
      setIsLoading(false);
      setError(message);
    },
    [clearAnalysisStatusPolling],
  );

  const finishAnalysisWithSuccess = useCallback(
    (msg: { clips?: BestClip[]; hasTranscript?: boolean; videoDuration?: number }) => {
      const resultClips: BestClip[] = msg.clips ?? [];
      setClips(resultClips);
      setHasTranscript(msg.hasTranscript ?? false);
      setVideoDurationSec(msg.videoDuration ?? 0);
      if (!resultClips.length) {
        const noTranscript = !msg.hasTranscript;
        setError(
          noTranscript
            ? "No clips found. This video has no transcript/subtitles, so the AI is working from title and description only — try a video with subtitles for better results."
            : "No clips could be identified. The video content may not have clearly distinct highlight segments, or the AI response could not be parsed. Please try again.",
        );
      } else {
        try {
          sessionStorage.setItem(
            PERSIST_KEY,
            JSON.stringify({
              url: url.trim(),
              clips: resultClips,
              hasTranscript: msg.hasTranscript ?? false,
            }),
          );
        } catch {}
        saveToBestClipsHistory({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          createdAt: Date.now(),
          url: url.trim(),
          clipCount: resultClips.length,
          hasTranscript: msg.hasTranscript ?? false,
          clips: resultClips,
        });
      }
      clearAnalysisStatusPolling();
      analysisJobIdRef.current = null;
      analysisStartRef.current = null;
      setIsLoading(false);
    },
    [clearAnalysisStatusPolling, url],
  );

  const pollBestClipsStatus = useCallback(
    async (jobId: string) => {
      const res = await fetch(`${BASE}/api/youtube/clips/status/${jobId}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error ?? "Failed to read analysis status");
      }
      const status = typeof payload?.status === "string" ? payload.status : "running";
      const message = typeof payload?.message === "string" ? payload.message : "Analysis in progress";

      if (status === "done") {
        updateStep("ai", "done", message, payload);
        finishAnalysisWithSuccess(payload);
        return;
      }
      if (status === "error" || status === "cancelled" || status === "expired") {
        finishAnalysisWithError(message || "Analysis failed");
        return;
      }
      updateStep("ai", "running", message, payload);
    },
    [BASE, finishAnalysisWithError, finishAnalysisWithSuccess],
  );

  const startBestClipsStatusPolling = useCallback(
    (jobId: string) => {
      if (analysisStatusTimerRef.current !== null) return;
      updateStep("ai", "running", "Reconnecting to analysis status...");
      void pollBestClipsStatus(jobId).catch((err) => {
        analysisStatusErrorCountRef.current += 1;
        if (analysisStatusErrorCountRef.current >= 4) {
          finishAnalysisWithError(
            err instanceof Error ? err.message : "Connection lost during analysis. Please try again.",
          );
        }
      });
      analysisStatusTimerRef.current = window.setInterval(() => {
        void pollBestClipsStatus(jobId).catch((err) => {
          analysisStatusErrorCountRef.current += 1;
          if (analysisStatusErrorCountRef.current >= 4) {
            finishAnalysisWithError(
              err instanceof Error ? err.message : "Connection lost during analysis. Please try again.",
            );
          }
        });
      }, 3000);
    },
    [finishAnalysisWithError, pollBestClipsStatus],
  );

  useImperativeHandle(ref, () => ({ startAnalyze: handleAnalyze }));

  const activeTopic = TOPIC_PRESETS.find((p) => p.id === selectedTopic) ?? null;

  async function handleAnalyze() {
    if (!url.trim()) return;
    if (!isAutoMode && !is8MinMode && selectedDurations.length === 0) return;
    if (is8MinMode && !selectedTopic) return;

    // Close any previous SSE
    clearAnalysisStatusPolling();
    analysisJobIdRef.current = null;
    esRef.current?.close();
    esRef.current = null;
    closeAllDownloadStreams();

    setIsLoading(true);
    setError(null);
    setClips([]);
    setExpandedClip(null);
    setDownloadStates({});
    resetSteps();
    setAnalysisElapsed(0);
    setVideoDurationSec(0);
    analysisStartRef.current = Date.now();
    resultsKeyRef.current += 1; // invalidate any stale results section
    // Clear persisted session results so old data can't ghost in
    try { sessionStorage.removeItem(PERSIST_KEY); } catch {}

    try {
      // 1. Start the job
      const startRes = await fetch(`${BASE}/api/youtube/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isAutoMode
            ? {
                url: url.trim(),
                auto: true,
                instructions: customInstructions.trim() || undefined,
              }
            : is8MinMode && activeTopic
              ? {
                  url: url.trim(),
                  auto: true,
                  instructions: `${activeTopic.instructions}\n\nCLIP LENGTH: The clip should be approximately 8-10 minutes long (480-600 seconds). Find the single best segment matching the topic above that is closest to this length. If the best matching segment is slightly shorter or longer (6-12 min), that is fine — content quality and topic match matter more than exact length.`,
                }
              : {
                  url: url.trim(),
                  durations: selectedDurations,
                  instructions: customInstructions.trim() || undefined,
                },
        ),
      });
      const startData = await startRes.json();
      if (!startRes.ok)
        throw new Error(startData.error ?? "Failed to start analysis");

      const { jobId } = startData;
      analysisJobIdRef.current = jobId;

      // 2. Connect SSE stream
      const es = new EventSource(`${BASE}/api/youtube/clips/stream/${jobId}`);
      esRef.current = es;

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "step") {
            const stepName = msg.step as StepName;
            if (STEPS.includes(stepName)) {
              updateStep(stepName, msg.status as StepStatus, msg.message, msg);
              // Capture video duration from metadata step for ETA estimation
              if (stepName === "metadata" && msg.videoDuration) {
                setVideoDurationSec(msg.videoDuration);
              }
            } else if (msg.step === "queue") {
              updateStep("ai", "running", msg.message ?? "Queued for processing...", msg);
            }
          } else if (msg.type === "done") {
            es.close();
            esRef.current = null;
            finishAnalysisWithSuccess(msg);
          } else if (msg.type === "error") {
            es.close();
            esRef.current = null;
            finishAnalysisWithError(msg.message ?? "Analysis failed");
          }
        } catch {}
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (analysisJobIdRef.current) {
          startBestClipsStatusPolling(analysisJobIdRef.current);
        } else {
          finishAnalysisWithError("Connection lost during analysis. Please try again.");
        }
      };
    } catch (err) {
      clearAnalysisStatusPolling();
      analysisJobIdRef.current = null;
      setError(err instanceof Error ? err.message : "Failed to start analysis");
      analysisStartRef.current = null;
      setIsLoading(false);
    }
  }

  const handleDownloadClip = async (clip: BestClip) => {
    const key = clipKey(clip);
    if (downloadStates[key]?.status === "downloading") return;

    setDownload(key, {
      status: "downloading",
      percent: 0,
      message: "Starting…",
      startedAt: Date.now(),
    });

    try {
      const startRes = await fetch(`${BASE}/api/youtube/clip-cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          startTime: clip.startSec,
          endTime: clip.endSec,
          quality: "best",
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok)
        throw new Error(startData.error ?? "Failed to start download");

      const { jobId } = startData;

      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const prog = await fetch(`${BASE}/api/youtube/progress/${jobId}`).then(
          (r) => r.json(),
        );

        if (prog.status === "done") {
          setDownload(key, {
            status: "done",
            percent: 100,
            eta: null,
            speed: null,
          });
          const link = document.createElement("a");
          link.href = `${BASE}/api/youtube/file/${jobId}`;
          link.download = `${clip.title}.mp4`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          toast({
            title: "Clip downloaded!",
            description: `"${clip.title}" saved to your downloads.`,
          });
          return;
        }
        if (prog.status === "error")
          throw new Error(prog.message ?? "Download failed");

        const pct = prog.percent ?? 0;
        setDownload(key, {
          status: "downloading",
          percent: pct,
          eta: prog.eta ?? null,
          speed: prog.speed ?? null,
          message:
            prog.status === "merging"
              ? "Merging…"
              : pct > 0
                ? `${pct}%`
                : "Preparing…",
        });
      }
      throw new Error("Download timed out");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setDownload(key, { status: "error", percent: 0, message: msg });
      toast({
        title: "Download failed",
        description: msg,
        variant: "destructive",
      });
    }
  };

  const startClipDownload = async (clip: BestClip) => {
    const key = clipKey(clip);
    if (downloadStates[key]?.status === "downloading") return;
    closeDownloadStream(key);

    setDownload(key, {
      status: "downloading",
      percent: 0,
      message: "Starting...",
      startedAt: Date.now(),
      jobId: undefined,
      eta: null,
      speed: null,
    });

    try {
      const startRes = await fetch(`${BASE}/api/youtube/clip-cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          startTime: clip.startSec,
          endTime: clip.endSec,
          quality: "best",
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) {
        throw new Error(startData.error ?? "Failed to start download");
      }

      const jobId = String(startData.jobId ?? "");
      if (!jobId) throw new Error("Missing job id");

      setDownload(key, { jobId, message: "Preparing..." });

      const pollProgress = async () => {
        try {
          const res = await fetch(`${BASE}/api/youtube/progress/${jobId}`, { cache: "no-store" });
          if (!res.ok) return;
          const prog = await res.json() as {
            status?: string;
            percent?: number;
            eta?: string | null;
            speed?: string | null;
            message?: string | null;
          };

          if (prog.status === "done") {
            closeDownloadStream(key);
            setDownload(key, {
              status: "done",
              percent: 100,
              eta: null,
              speed: null,
              message: undefined,
            });
            toast({
              title: "Clip ready",
              description: `"${clip.title}" is ready. Tap Save to download.`,
            });
            return;
          }

          if (prog.status === "cancelled") {
            closeDownloadStream(key);
            setDownload(key, {
              status: "cancelled",
              percent: 0,
              eta: null,
              speed: null,
              message: prog.message ?? "Cancelled by user",
            });
            toast({
              title: "Download cancelled",
              description: `"${clip.title}" download was cancelled.`,
            });
            return;
          }

          if (prog.status === "error" || prog.status === "expired") {
            closeDownloadStream(key);
            const msg = prog.message ?? "Download failed";
            setDownload(key, { status: "error", percent: 0, message: msg });
            toast({
              title: "Download failed",
              description: msg,
              variant: "destructive",
            });
            return;
          }

          const pct = typeof prog.percent === "number" ? prog.percent : 0;
          setDownload(key, {
            status: "downloading",
            jobId,
            percent: pct,
            eta: prog.eta ?? null,
            speed: prog.speed ?? null,
            message:
              prog.status === "merging"
                ? "Merging..."
                : pct > 0
                  ? `${pct}%`
                  : "Preparing...",
          });
        } catch {
          // network blip — keep polling
        }
      };

      const intervalId = window.setInterval(() => { void pollProgress(); }, 3000);
      downloadPollRefs.current.set(key, intervalId);
      void pollProgress();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setDownload(key, { status: "error", percent: 0, message: msg });
      toast({
        title: "Download failed",
        description: msg,
        variant: "destructive",
      });
    }
  };

  const handleCancelDownload = async (clip: BestClip) => {
    const key = clipKey(clip);
    const jobId = downloadStates[key]?.jobId;
    if (!jobId) return;

    try {
      const res = await fetch(`${BASE}/api/youtube/cancel/${jobId}`, {
        method: "POST",
      });
      const data = await res
        .json()
        .catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to cancel download");
      }
      setDownload(key, {
        status: "downloading",
        message: "Cancelling...",
      });
      toast({
        title: "Cancelling download",
        description: `"${clip.title}" cancel request sent.`,
      });
    } catch (err) {
      toast({
        title: "Cancel failed",
        description:
          err instanceof Error ? err.message : "Unable to cancel download",
        variant: "destructive",
      });
    }
  };

  const getDurationStyle = (durationSec: number) =>
    DURATION_OPTIONS.find((d) => d.value === durationSec) ??
    DURATION_OPTIONS[0];

  const groupedClips = clips.reduce<
    Array<{ durationSec: number; durationLabel: string; clips: BestClip[] }>
  >((acc, clip) => {
    const existing = acc.find((g) => g.durationSec === clip.durationSec);
    if (existing) existing.clips.push(clip);
    else
      acc.push({
        durationSec: clip.durationSec,
        durationLabel: clip.durationLabel,
        clips: [clip],
      });
    return acc;
  }, []);

  const stepRunning = (name: StepName) => steps[name].status === "running";
  const anyStepRunning = STEPS.some((s) => steps[s].status === "running");

  return (
    <div className="w-full space-y-6">
      {/* Controls */}
      <div className="glass-panel rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="bg-primary/20 p-2 rounded-xl border border-primary/30">
            <Scissors className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-white text-lg">
              Find Best Clips
            </h3>
            <p className="text-white/50 text-sm">
              AI scans the entire video to find every great segment
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-white/60 text-sm font-medium">
            Select clip durations to find:
          </p>
          <div className="flex flex-wrap gap-2">
            {/* Auto mode button */}
            <button
              onClick={() => {
                setIsAutoMode((prev) => !prev);
                setIs8MinMode(false);
              }}
              className={cn(
                "px-4 py-2 rounded-xl border text-sm font-semibold transition-all duration-200 flex items-center gap-1.5",
                isAutoMode
                  ? "bg-amber-500/20 border-amber-400/50 text-amber-200 shadow-[0_0_14px_rgba(245,158,11,0.25)]"
                  : "bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20",
                is8MinMode && !isAutoMode && "opacity-30",
              )}
            >
              <Wand2 className="w-3.5 h-3.5" />
              Auto
            </button>

            {/* Manual duration buttons */}
            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setIsAutoMode(false);
                  setIs8MinMode(false);
                  selectDuration(opt.value);
                }}
                className={cn(
                  "px-4 py-2 rounded-xl border text-sm font-semibold transition-all duration-200",
                  (isAutoMode || is8MinMode) && "opacity-30 cursor-default",
                  !isAutoMode &&
                    !is8MinMode &&
                    selectedDurations.includes(opt.value)
                    ? "bg-primary/20 border-primary/50 text-white shadow-[0_0_12px_rgba(229,9,20,0.2)]"
                    : !isAutoMode && !is8MinMode
                      ? "bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20"
                      : "bg-white/5 border-white/10 text-white/30",
                )}
              >
                {opt.label}
              </button>
            ))}

            {/* 8-10 min topic button */}
            <button
              onClick={() => {
                setIsAutoMode(false);
                setIs8MinMode((prev) => !prev);
              }}
              className={cn(
                "px-4 py-2 rounded-xl border text-sm font-semibold transition-all duration-200 flex items-center gap-1.5",
                is8MinMode
                  ? "bg-amber-500/20 border-amber-400/50 text-amber-200 shadow-[0_0_14px_rgba(245,158,11,0.3)]"
                  : "bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20",
                isAutoMode && "opacity-30",
              )}
            >
              <Sparkles className="w-3.5 h-3.5" />
              8-10 min
            </button>
          </div>

          {isAutoMode && (
            <p className="text-amber-300/70 text-xs flex items-center gap-1.5">
              <Wand2 className="w-3 h-3" />
              AI will decide the best duration for each clip — no presets, full
              creative control
            </p>
          )}

          {/* 8-min topic dropdown */}
          <AnimatePresence>
            {is8MinMode && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="pt-2 space-y-2">
                  <p className="text-white/50 text-xs font-medium flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-amber-300" />
                    Select a Bhavishya Malika prophecy topic:
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {TOPIC_PRESETS.map((p) => {
                      const { Icon } = p;
                      const isActive = selectedTopic === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() =>
                            setSelectedTopic(isActive ? null : p.id)
                          }
                          disabled={isLoading}
                          className={cn(
                            "relative flex flex-col items-start gap-1 p-3 rounded-xl border text-left transition-all duration-150 group",
                            isActive
                              ? cn(p.bgColor, p.borderColor, p.glowColor)
                              : "bg-white/4 border-white/8 hover:border-white/20 hover:bg-white/7",
                          )}
                        >
                          {isActive && (
                            <span className="absolute top-2 right-2">
                              <CheckCircle2
                                className={cn("w-3 h-3", p.accentColor)}
                              />
                            </span>
                          )}
                          <div className="flex items-center gap-2">
                            <Icon
                              className={cn(
                                "w-3.5 h-3.5 shrink-0",
                                isActive
                                  ? p.accentColor
                                  : "text-white/40 group-hover:text-white/60",
                              )}
                            />
                            <span
                              className={cn(
                                "font-semibold text-xs leading-tight",
                                isActive ? p.accentColor : "text-white/70",
                              )}
                            >
                              {p.label}
                            </span>
                          </div>
                          <p
                            className={cn(
                              "text-[10px] leading-snug pl-0.5",
                              isActive ? "text-white/50" : "text-white/30",
                            )}
                          >
                            {p.description}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  {selectedTopic && activeTopic && (
                    <p
                      className={cn(
                        "text-xs flex items-center gap-1.5",
                        activeTopic.accentColor,
                      )}
                    >
                      <CheckCircle2 className="w-3 h-3 shrink-0" />
                      AI will find best ~8 min {activeTopic.label} prophecy clip
                    </p>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Custom Instructions Panel — hidden in 8-min mode */}
        {!is8MinMode && (
          <div className="space-y-2 pt-2">
            <label className="text-white/60 text-sm font-medium flex items-center gap-2">
              <FileText className="w-4 h-4" />
              AI Instructions (Optional)
            </label>
            <textarea
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder="Tell AI what to focus on... e.g. 'Get all clips about war discussions', 'Find all Bhagwat Katha or Krishna Leela stories', 'Extract any devotional or bhakti content', 'Find every discussion about spiritual topics'"
              className="w-full p-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder-white/30 focus:outline-none focus:border-primary/50 focus:bg-white/8 transition-colors resize-none"
              rows={3}
              disabled={isLoading}
            />
            {customInstructions && (
              <p className="text-white/40 text-xs">
                Instructions will be used to guide AI analysis
              </p>
            )}
          </div>
        )}

        <Button
          onClick={handleAnalyze}
          disabled={
            isLoading ||
            !url.trim() ||
            (!isAutoMode && !is8MinMode && selectedDurations.length === 0) ||
            (is8MinMode && !selectedTopic)
          }
          className={cn(
            "w-full h-12 rounded-xl transition-all duration-300 text-white",
            isAutoMode &&
              !isLoading &&
              "bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 border-amber-500/30",
            is8MinMode &&
              selectedTopic &&
              !isLoading &&
              activeTopic &&
              activeTopic.activeBtnClass,
          )}
          size="lg"
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Analyzing video...
            </span>
          ) : isAutoMode ? (
            <span className="flex items-center gap-2">
              <Wand2 className="w-4 h-4" />
              Auto Find Best Clips
            </span>
          ) : is8MinMode && selectedTopic && activeTopic ? (
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              <span className="sm:hidden">Find Best Clips</span>
              <span className="hidden sm:inline">
                Find Best {activeTopic.label} Clip (8-10 min)
              </span>
            </span>
          ) : is8MinMode ? (
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Select a topic above
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Find Best Clips
            </span>
          )}
        </Button>
      </div>

      {/* Live step-by-step status */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass-panel rounded-2xl p-5 space-y-3"
          >
            {(() => {
              const totalEst = estimateTotalSec(videoDurationSec);
              const remaining = Math.max(0, totalEst - analysisElapsed);
              const allDone = STEPS.every(
                (s) => steps[s].status === "done" || steps[s].status === "warn",
              );
              return (
                <div className="flex items-center justify-between mb-1">
                  <p className="text-white/50 text-xs font-semibold uppercase tracking-widest">
                    What's happening
                  </p>
                  <span className="flex items-center gap-1.5 text-white/50 text-xs font-mono">
                    <Timer className="w-3 h-3 shrink-0" />
                    {allDone ? "finishing…" : formatRemaining(remaining)}
                  </span>
                </div>
              );
            })()}
            {STEPS.map((name, idx) => {
              const s = steps[name];
              const meta = STEP_META[name];
              const Icon = meta.icon;
              const isIdle = s.status === "idle";
              const isRunning = s.status === "running";
              const isDone = s.status === "done";
              const isWarn = s.status === "warn";

              return (
                <motion.div
                  key={name}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className={cn(
                    "flex items-start gap-3 p-3 rounded-xl border transition-all duration-300",
                    isRunning && "border-primary/30 bg-primary/5",
                    isDone && "border-emerald-500/20 bg-emerald-500/5",
                    isWarn && "border-amber-500/20 bg-amber-500/5",
                    isIdle && "border-white/5 opacity-40",
                  )}
                >
                  {/* Step icon */}
                  <div
                    className={cn(
                      "shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5",
                      isRunning && "bg-primary/20 border border-primary/30",
                      isDone &&
                        "bg-emerald-500/20 border border-emerald-500/30",
                      isWarn && "bg-amber-500/20 border border-amber-500/30",
                      isIdle && "bg-white/5 border border-white/10",
                    )}
                  >
                    {isRunning ? (
                      <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                    ) : isDone ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : isWarn ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                    ) : (
                      <Icon className="w-3.5 h-3.5 text-white/30" />
                    )}
                  </div>

                  {/* Step info */}
                  <div className="flex-1 min-w-0">
                    <p
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wide",
                        isRunning && "text-primary/80",
                        isDone && "text-emerald-400/80",
                        isWarn && "text-amber-400/80",
                        isIdle && "text-white/25",
                      )}
                    >
                      {meta.label}
                    </p>
                    {s.message && (
                      <p
                        className={cn(
                          "text-sm mt-0.5 leading-snug",
                          isRunning && "text-white/80",
                          isDone && "text-white/65",
                          isWarn && "text-amber-300/70",
                          isIdle && "text-white/25",
                        )}
                      >
                        {s.message}
                      </p>
                    )}
                    {/* Pulsing dots for running step */}
                    {isRunning && (
                      <div className="flex gap-1 mt-1.5">
                        {[0, 1, 2].map((i) => (
                          <div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full bg-primary/50 animate-bounce"
                            style={{ animationDelay: `${i * 0.12}s` }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      <AnimatePresence>
        {error && !isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass-panel rounded-2xl p-5 flex items-start gap-4 border-red-500/20"
          >
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-white font-medium">Analysis failed</p>
              <p className="text-white/60 text-sm mt-1">{error}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results */}
      <AnimatePresence>
        {groupedClips.length > 0 && !isLoading && (
          <motion.div
            key={`results-${resultsKeyRef.current}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-6"
          >
            <div className="flex items-center gap-3 px-1 flex-wrap">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <h3 className="text-lg font-display font-semibold text-white">
                {clips.length} clip{clips.length !== 1 ? "s" : ""} found across{" "}
                {groupedClips.length} duration
                {groupedClips.length !== 1 ? "s" : ""}
              </h3>
              {!hasTranscript && (
                <div className="flex items-center gap-1.5 text-amber-300 text-xs bg-amber-500/10 border border-amber-500/20 px-3 py-1 rounded-full ml-auto">
                  <Info className="w-3 h-3" />
                  Based on title &amp; description (no transcript)
                </div>
              )}
            </div>

            {groupedClips.map((group, groupIdx) => {
              const style = getDurationStyle(group.durationSec);
              return (
                <motion.div
                  key={group.durationSec}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: groupIdx * 0.07 }}
                  className="space-y-2"
                >
                  <div
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 rounded-xl border",
                      style.accent,
                    )}
                  >
                    <Film className="w-4 h-4 text-white/40" />
                    <Badge
                      className={cn(
                        "text-xs font-bold px-3 py-1 rounded-lg border",
                        style.badge,
                      )}
                    >
                      {group.durationLabel}
                    </Badge>
                    <span className="text-white/50 text-sm">
                      {group.clips.length} segment
                      {group.clips.length !== 1 ? "s" : ""} found
                    </span>
                  </div>

                  <div className="space-y-2 pl-2">
                    {group.clips.map((clip, clipIdx) => {
                      const key = clipKey(clip);
                      const dl = downloadStates[key] ?? {
                        status: "idle",
                        percent: 0,
                      };
                      const isExpanded = expandedClip === key;

                      return (
                        <motion.div
                          key={key}
                          initial={{ opacity: 0, x: -12 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{
                            delay: groupIdx * 0.07 + clipIdx * 0.04,
                          }}
                          className="group relative glass-panel rounded-xl overflow-hidden border-white/5 hover:border-white/10 transition-all duration-300"
                        >
                          <div
                            className={cn(
                              "absolute inset-0 bg-gradient-to-br opacity-10 pointer-events-none",
                              style.color,
                            )}
                          />
                          {dl.status === "downloading" && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 overflow-hidden">
                              {dl.percent === 0 ? (
                                <motion.div
                                  className="h-full bg-gradient-to-r from-transparent via-primary/70 to-transparent"
                                  animate={{ x: ["-100%", "200%"] }}
                                  transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
                                  style={{ width: "45%" }}
                                />
                              ) : (
                                <motion.div
                                  className="h-full bg-primary"
                                  initial={{ width: 0 }}
                                  animate={{ width: `${dl.percent}%` }}
                                  transition={{ duration: 0.4 }}
                                />
                              )}
                            </div>
                          )}

                          <div className="relative p-4">
                            <div className="flex items-start gap-3">
                              <div className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/30 text-xs font-bold">
                                {clipIdx + 1}
                              </div>
                              <div className="flex-1 min-w-0">
                                <h4 className="font-display font-bold text-white text-sm leading-snug mb-1 line-clamp-2">
                                  {clip.title}
                                </h4>
                                <div className="flex items-center gap-2 sm:gap-3 text-white/50 text-xs flex-wrap">
                                  <span className="flex items-center gap-1">
                                    <Play className="w-3 h-3" />
                                    {clip.startFormatted}
                                  </span>
                                  <span>→</span>
                                  <span className="flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    {clip.endFormatted}
                                  </span>
                                  <span className="text-white/30">·</span>
                                  <span className="text-white/40">
                                    {formatDuration(
                                      clip.endSec - clip.startSec,
                                    )}
                                  </span>
                                </div>
                                {dl.status === "downloading" && (
                                  <div className="flex items-center justify-between gap-2 mt-1">
                                    <p className="text-primary/70 text-xs font-medium">
                                      {dl.percent === 0
                                        ? (dl.elapsed ?? 0) < 15
                                          ? "Solving challenge…"
                                          : (dl.elapsed ?? 0) < 40
                                            ? "Fetching video…"
                                            : "Downloading…"
                                        : dl.speed
                                          ? dl.speed
                                          : "Downloading…"}
                                    </p>
                                    <span className="text-white/35 text-xs font-mono shrink-0">
                                      {dl.percent > 0
                                        ? `${dl.percent.toFixed(0)}%`
                                        : dl.eta
                                          ? `ETA ${dl.eta}`
                                          : dl.elapsed != null
                                            ? dl.elapsed < 60
                                              ? `${dl.elapsed}s`
                                              : `${Math.floor(dl.elapsed / 60)}m ${dl.elapsed % 60}s`
                                            : ""}
                                    </span>
                                  </div>
                                )}
                                {(dl.status === "error" ||
                                  dl.status === "cancelled") &&
                                  dl.message && (
                                    <p
                                      className={cn(
                                        "text-xs mt-1",
                                        dl.status === "cancelled"
                                          ? "text-amber-400"
                                          : "text-red-400",
                                      )}
                                    >
                                      {dl.message}
                                    </p>
                                  )}
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  onClick={() =>
                                    setExpandedClip(isExpanded ? null : key)
                                  }
                                  className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors"
                                >
                                  {isExpanded ? (
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  ) : (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  )}
                                </button>

                                {onEditClip && (
                                  <Button
                                    size="sm"
                                    variant="glass"
                                    onClick={() => onEditClip(clip)}
                                    className="rounded-xl h-8 px-3 text-xs font-semibold bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20"
                                  >
                                    <span className="flex items-center gap-1.5">
                                      <Pencil className="w-3 h-3" />
                                      Edit with AI
                                    </span>
                                  </Button>
                                )}

                                <Button
                                  size="sm"
                                  variant={
                                    dl.status === "done" ? "glass" : "default"
                                  }
                                  onClick={() =>
                                    dl.status === "downloading"
                                      ? handleCancelDownload(clip)
                                      : dl.status === "done" && dl.jobId
                                        ? triggerClipDownload(dl.jobId, clip.title)
                                        : startClipDownload(clip)
                                  }
                                  className={cn(
                                    "rounded-xl h-8 px-3 text-xs font-semibold min-w-[90px]",
                                    dl.status === "done" &&
                                      "bg-emerald-500/20 border-emerald-500/30 text-emerald-300",
                                    dl.status === "error" &&
                                      "bg-red-500/10 border-red-500/30 text-red-300",
                                    dl.status === "cancelled" &&
                                      "bg-amber-500/10 border-amber-500/30 text-amber-300",
                                    dl.status === "downloading" &&
                                      "bg-amber-500/15 border-amber-500/40 text-amber-200",
                                  )}
                                >
                                  {dl.status === "downloading" ? (
                                    <span className="flex items-center gap-1.5">
                                      <X className="w-3 h-3" />
                                      Cancel
                                    </span>
                                  ) : dl.status === "done" ? (
                                    <span className="flex items-center gap-1.5">
                                      <Download className="w-3 h-3" />
                                      Save
                                    </span>
                                  ) : dl.status === "error" ||
                                    dl.status === "cancelled" ? (
                                    <span className="flex items-center gap-1.5">
                                      <Download className="w-3 h-3" />
                                      Retry
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1.5">
                                      <Download className="w-3 h-3" />
                                      Download
                                    </span>
                                  )}
                                </Button>
                              </div>
                            </div>

                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: "auto" }}
                                  exit={{ opacity: 0, height: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="pt-3 mt-3 border-t border-white/5 space-y-2 ml-0 sm:ml-9">
                                    <p className="text-white/65 text-sm leading-relaxed">
                                      {clip.description}
                                    </p>
                                    {clip.reason && (
                                      <div className="flex items-start gap-2 bg-white/5 rounded-lg px-3 py-2">
                                        <Sparkles className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                                        <p className="text-white/55 text-xs italic">
                                          {clip.reason}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
