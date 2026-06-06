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
  Link2,
  ArrowUp,
  SlidersHorizontal,
  Lightbulb,
  MoreVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { saveToBestClipsHistory, loadBestClipsHistory, type BestClipsHistoryEntry } from "@/lib/best-clips-history";

function parseCombinedInput(input: string) {
  const match = input.match(/(https?:\/\/[^\s]+)/);
  if (!match) return { url: "", description: input };
  const extractedUrl = match[1];
  const description = input.replace(extractedUrl, "").trim();
  return { url: extractedUrl, description };
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

function VideoTitle({ url, fallback, className }: { url: string; fallback: string; className?: string }) {
  const title = useVideoTitle(url, fallback);
  return <span className={className}>{title}</span>;
}

function formatTimeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

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
  const [command, setCommand] = useState(url);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [history, setHistory] = useState<BestClipsHistoryEntry[]>([]);
  const [selectedDurations, setSelectedDurations] = useState<number[]>([60]);
  const [isAutoMode, setIsAutoMode] = useState(true);
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
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
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

  // Load history on mount and when analysis finishes
  const refreshHistory = useCallback(() => {
    setHistory(loadBestClipsHistory());
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  // Adjust textarea height automatically
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const newHeight = Math.min(60, textarea.scrollHeight);
    textarea.style.height = `${newHeight}px`;
  }, [command]);

  // Restore saved analysis results when prop url changes
  useEffect(() => {
    if (!url.trim()) return;
    setCommand(url);
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
      if (!analysisJobIdRef.current && !analysisStartRef.current) return; // already finished
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
      if (!analysisJobIdRef.current && !analysisStartRef.current) return; // already finished
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
        
        const newHistoryId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        saveToBestClipsHistory({
          id: newHistoryId,
          createdAt: Date.now(),
          url: url.trim(),
          clipCount: resultClips.length,
          hasTranscript: msg.hasTranscript ?? false,
          clips: resultClips,
        });
        setExpandedVideoId(newHistoryId);
      }
      clearAnalysisStatusPolling();
      analysisJobIdRef.current = null;
      analysisStartRef.current = null;
      setIsLoading(false);
      refreshHistory();
    },
    [clearAnalysisStatusPolling, command, refreshHistory],
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
    const { url: parsedUrl, description } = parseCombinedInput(command);
    const finalUrl = parsedUrl || command;
    if (!finalUrl.trim()) return;
    if (!isAutoMode && !is8MinMode && selectedDurations.length === 0) return;
    if (is8MinMode && !selectedTopic) return;

    // Use description from input if provided, otherwise customInstructions
    const finalInstructions = description.trim() || customInstructions.trim();

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
                url: finalUrl.trim(),
                auto: true,
                instructions: finalInstructions || undefined,
              }
            : is8MinMode && activeTopic
              ? {
                  url: finalUrl.trim(),
                  auto: true,
                  instructions: `${activeTopic.instructions}\n\nCLIP LENGTH: The clip should be approximately 8-10 minutes long (480-600 seconds). Find the single best segment matching the topic above that is closest to this length. If the best matching segment is slightly shorter or longer (6-12 min), that is fine — content quality and topic match matter more than exact length.`,
                }
              : {
                  url: finalUrl.trim(),
                  durations: selectedDurations,
                  instructions: finalInstructions || undefined,
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
          url: command.trim(),
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

    closeDownloadStream(key); // Stop polling immediately on cancel

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
        status: "cancelled",
        message: "Cancelled",
        percent: 0,
      });
      toast({
        title: "Download cancelled",
        description: `"${clip.title}" has been cancelled.`,
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
    <div className="flex flex-col gap-5 relative max-w-[720px] mx-auto w-full pt-8 sm:pt-14">
      {/* Controls */}
      <div className="flex flex-col gap-6 relative">
        <div className="mb-5 max-w-none sm:mb-6">
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-[38px]">Find Best Clips</h1>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400 sm:text-base lg:text-[15px]">
            AI scans your video and finds the best moments automatically.
          </p>
        </div>

        {/* Input Bar */}
        <style>{`
          @keyframes rgbGlow {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>
        <div className="relative group w-full mb-2">
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
                  disabled={isLoading}
                  placeholder="Paste YouTube URL and describe the clips you want..."
                  className="min-h-[20px] flex-1 resize-none bg-transparent pt-[2px] pb-0 text-sm leading-5 text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleAnalyze();
                    }
                  }}
                />
                <button
                  type="button"
                  className="p-1.5 rounded-full hover:bg-white/5 text-zinc-400 hover:text-white transition shrink-0"
                  title="Help info"
                >
                  <Info className="h-4.5 w-4.5" />
                </button>
                <button
                  onClick={handleAnalyze}
                  disabled={isLoading || !command.trim()}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition"
                >
                  {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Duration / Topic Toggles */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setIsAutoMode(true);
                setIs8MinMode(false);
              }}
              className={cn(
                "px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200",
                isAutoMode
                  ? "bg-red-500/10 border border-red-500/40 text-red-500 shadow-sm"
                  : "bg-white/5 text-white/50 hover:text-white/80 hover:bg-white/10 border border-transparent"
              )}
            >
              Auto
            </button>

            {DURATION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setIsAutoMode(false);
                  setIs8MinMode(false);
                  selectDuration(opt.value);
                }}
                className={cn(
                  "px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200",
                  !isAutoMode && !is8MinMode && selectedDurations.includes(opt.value)
                    ? "bg-white/10 border border-white/20 text-white shadow-sm"
                    : "bg-white/5 text-white/50 hover:text-white/80 hover:bg-white/10 border border-transparent"
                )}
              >
                {opt.label.replace("≥ ", "")}
              </button>
            ))}

            <button
              onClick={() => {
                setIsAutoMode(false);
                setIs8MinMode(true);
              }}
              className={cn(
                "px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200",
                is8MinMode
                  ? "bg-white/10 border border-white/20 text-white shadow-sm"
                  : "bg-white/5 text-white/50 hover:text-white/80 hover:bg-white/10 border border-transparent"
              )}
            >
              8-10 min
            </button>
          </div>

          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={cn(
              "px-5 py-2.5 rounded-xl transition-all text-sm font-semibold flex items-center gap-2",
              showAdvanced || is8MinMode
                ? "bg-white/10 border border-white/20 text-white shadow-sm"
                : "bg-white/5 text-white/70 hover:text-white hover:bg-white/10 border border-transparent"
            )}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Advanced
          </button>
        </div>

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
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                            : "bg-white/5 border-white/10 hover:border-white/20 hover:bg-white/10",
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
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Custom Instructions Panel */}
        <AnimatePresence>
          {showAdvanced && !is8MinMode && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="space-y-2 pt-2 pb-2">
                <label className="text-white/60 text-sm font-medium flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Detailed AI Instructions (Optional)
                </label>
                <textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="You can also describe the clips you want directly in the main input bar above!"
                  className="w-full p-4 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder-white/30 focus:outline-none focus:border-white/30 focus:bg-white/10 transition-colors resize-none"
                  rows={3}
                  disabled={isLoading}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* (Recent Searches removed to merge with unified history) */}
      </div>

      {/* Live step-by-step status (Native ClipCut Job Card style) */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10, height: 0 }}
            transition={{ duration: 0.25 }}
            className="relative w-full mt-8 sm:mt-12 mb-4"
          >
            <div 
              className="absolute -inset-2.5 rounded-2xl blur-[24px] pointer-events-none z-0"
              style={{
                opacity: 0.52,
                background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
                backgroundSize: '300% 300%',
                animation: 'rgbGlow 10s ease-in-out infinite',
              }}
            />

            <div className="relative z-10 w-full rounded-2xl bg-[#0c0c0e] border border-zinc-900 px-4.5 py-3.5 flex flex-col gap-3 group transition-all duration-300 shadow-xl">
              <div className="flex items-center gap-4 w-full">
                {/* Thumbnail Preview */}
                <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/5 shadow-md">
                  {extractVideoId(command) ? (
                    <img
                      src={`https://img.youtube.com/vi/${extractVideoId(command)}/mqdefault.jpg`}
                      className="h-full w-full object-cover animate-pulse opacity-70"
                      alt="Thumbnail"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-zinc-900 animate-pulse">
                      <Film className="h-4.5 w-4.5 text-white/20" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-85" />
                </div>

                {/* Info details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin shrink-0" />
                    <p className="text-white/95 text-sm font-semibold truncate leading-snug">
                      <VideoTitle url={command} fallback={command ? command : "Video Analysis"} />
                    </p>
                  </div>

                  <p className="text-zinc-400 text-xs mt-1.5 truncate">
                    AI is deciding the best clip durations and scanning the entire video...
                  </p>
                </div>
              </div>

              {/* Progress bar and details */}
              <div className="relative z-10 flex flex-col gap-1.5 px-0.5 mt-1.5">
                <div className="h-[3px] w-full bg-zinc-950/90 rounded-full relative overflow-visible shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]">
                  <div
                    className="h-full rounded-full transition-[width] duration-700 ease-out relative filter"
                    style={{
                      width: `${Math.min(100, Math.max(0, (analysisElapsed / (videoDurationSec ? estimateTotalSec(videoDurationSec) : 120)) * 100))}%`,
                      background: 'linear-gradient(to right, rgba(0, 0, 0, 0) 0%, rgba(0, 122, 255, 0.05) 15%, rgba(0, 122, 255, 0.2) 35%, rgba(175, 82, 222, 0.5) 60%, rgba(255, 45, 85, 0.8) 85%, rgba(255, 149, 0, 0.95) 95%, #ffffff 100%)',
                      animation: 'rocketFire 0.4s ease-in-out infinite',
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-zinc-500 mt-0.5">
                  <span>
                    {steps.metadata.status === "running" ? "Fetching video metadata..." :
                     steps.transcript.status === "running" ? "Downloading transcript..." :
                     steps.ai.status === "running" ? "AI Analysis in progress..." : "Initializing..."}
                  </span>
                  <span className="font-mono">
                    Elapsed: {formatRemaining(analysisElapsed)}
                  </span>
                </div>
              </div>
            </div>
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

      {/* Unified Video & Clips History */}
      <AnimatePresence>
        {!isLoading && history.length > 0 && (
          <motion.div
            key={`history-${resultsKeyRef.current}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-4 mt-8 sm:mt-12"
          >
            <div className="flex items-center gap-3 px-1 mb-4">
              <h3 className="text-lg font-display font-semibold text-white">
                Recent clip searches
              </h3>
            </div>

            <div className="space-y-4">
              {history.map((entry, entryIdx) => {
                const isVideoExpanded = expandedVideoId === entry.id;
                const videoId = extractVideoId(entry.url);
                const thumbUrl = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null;

                return (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: entryIdx * 0.05 }}
                    className="relative z-10 w-full rounded-2xl bg-[#0c0c0e] border px-4.5 py-3.5 flex flex-col group transition-all duration-300 border-zinc-900 text-left"
                  >
                    {/* Collapsed / Top-level Video Row */}
                    <button
                      onClick={() => setExpandedVideoId(isVideoExpanded ? null : entry.id)}
                      className="flex items-center gap-4 w-full text-left"
                    >
                      {/* Thumbnail Preview */}
                      <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-zinc-800 border border-white/5 shadow-md">
                        {thumbUrl ? (
                          <img
                            src={thumbUrl}
                            className="h-full w-full object-cover transition-transform duration-350 group-hover:scale-105"
                            alt="Thumbnail"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
                            <Film className="h-4.5 w-4.5 text-white/20" />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-85" />
                      </div>

                      {/* Info details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                           <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                           <span className="text-emerald-500 text-xs font-semibold">
                             {entry.clipCount} clips generated
                           </span>
                        </div>
                        <p className="text-white/95 text-sm font-semibold truncate leading-snug group-hover:text-white transition-colors">
                          <VideoTitle url={entry.url} fallback={entry.clips?.[0]?.title || "Video Analysis"} />
                        </p>
                        <p className="text-zinc-400 text-xs mt-1 truncate">
                          {formatTimeAgo(entry.createdAt)} • {entry.hasTranscript ? "Analyzed" : "Fast scan"}
                        </p>
                      </div>

                      {/* Action buttons / metadata */}
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors">
                          {isVideoExpanded ? (
                            <ChevronUp className="w-4 h-4" />
                          ) : (
                            <ChevronDown className="w-4 h-4" />
                          )}
                        </div>
                      </div>
                    </button>

                    {/* Expanded Clips List */}
                    <AnimatePresence>
                      {isVideoExpanded && entry.clips && entry.clips.length > 0 && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="pt-5 mt-4 border-t border-white/5 space-y-3">
                            {entry.clips.map((clip, clipIdx) => {
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
                                  transition={{ delay: clipIdx * 0.05 }}
                                  className="relative w-full rounded-xl bg-zinc-900/50 hover:bg-zinc-900 border px-4 py-3 flex flex-col group transition-all duration-300 border-zinc-800/50 text-left"
                                >
                                  {/* Downloading Background Progress */}
                                  {dl.status === "downloading" && (
                                    <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none">
                                      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5">
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
                                    </div>
                                  )}

                                  <div className="flex items-center gap-3 w-full">
                                    {/* Thumbnail Preview for sub-clip (smaller) */}
                                    <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded-md bg-zinc-800 border border-white/5 shadow-sm">
                                      {thumbUrl ? (
                                        <img
                                          src={thumbUrl}
                                          className="h-full w-full object-cover transition-transform duration-350 group-hover:scale-105"
                                          alt="Thumbnail"
                                        />
                                      ) : (
                                        <div className="flex h-full w-full items-center justify-center bg-zinc-900">
                                          <Film className="h-4 w-4 text-white/20" />
                                        </div>
                                      )}
                                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-85" />
                                      <div className="absolute bottom-1 right-1 px-1 py-0.5 rounded bg-black/70 backdrop-blur-md border border-white/10 text-[9px] font-medium text-white shadow-sm">
                                        {formatDuration(clip.endSec - clip.startSec)}
                                      </div>
                                    </div>

                                    {/* Info details */}
                                    <div className="flex-1 min-w-0 py-0.5">
                                      <p className="text-white/95 text-xs font-semibold truncate leading-snug group-hover:text-white transition-colors">
                                        {clip.title}
                                      </p>
                                      <div className="flex items-center gap-2 mt-1 text-zinc-400 text-[10px]">
                                        <span className="flex items-center gap-1">
                                          <Play className="w-2.5 h-2.5" />
                                          {clip.startFormatted}
                                        </span>
                                        <span>→</span>
                                        <span className="flex items-center gap-1">
                                          <Clock className="w-2.5 h-2.5" />
                                          {clip.endFormatted}
                                        </span>
                                      </div>

                                      {dl.status === "downloading" && (
                                        <div className="flex items-center justify-between gap-2 mt-2">
                                          <p className="text-primary/70 text-[10px] font-medium">
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
                                          <span className="text-white/35 text-[10px] font-mono shrink-0">
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
                                      {(dl.status === "error" || dl.status === "cancelled") && dl.message && (
                                        <p className={cn("text-[10px] mt-1.5", dl.status === "cancelled" ? "text-amber-400" : "text-red-400")}>
                                          {dl.message}
                                        </p>
                                      )}
                                    </div>

                                    {/* Action buttons */}
                                    <div className="flex items-center gap-1.5 shrink-0 pl-1">
                                      <button
                                        onClick={() => setExpandedClip(isExpanded ? null : key)}
                                        className="p-1 rounded bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors"
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
                                          className="rounded-md h-7 px-2 text-[10px] font-semibold bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20"
                                        >
                                          <span className="flex items-center gap-1">
                                            <Pencil className="w-2.5 h-2.5" />
                                            Edit
                                          </span>
                                        </Button>
                                      )}

                                      <Button
                                        size="sm"
                                        variant={dl.status === "done" ? "glass" : "default"}
                                        onClick={() =>
                                          dl.status === "downloading"
                                            ? handleCancelDownload(clip)
                                            : dl.status === "done" && dl.jobId
                                              ? triggerClipDownload(dl.jobId, clip.title)
                                              : startClipDownload(clip)
                                        }
                                        className={cn(
                                          "rounded-md h-7 px-2.5 text-[10px] font-semibold min-w-[70px]",
                                          dl.status === "done" && "bg-emerald-500/20 border-emerald-500/30 text-emerald-300",
                                          dl.status === "error" && "bg-red-500/10 border-red-500/30 text-red-300",
                                          dl.status === "cancelled" && "bg-amber-500/10 border-amber-500/30 text-amber-300",
                                          dl.status === "downloading" && "bg-amber-500/15 border-amber-500/40 text-amber-200"
                                        )}
                                      >
                                        {dl.status === "downloading" ? (
                                          <span className="flex items-center gap-1"><X className="w-2.5 h-2.5" />Cancel</span>
                                        ) : dl.status === "done" ? (
                                          <span className="flex items-center gap-1"><Download className="w-2.5 h-2.5" />Save</span>
                                        ) : dl.status === "error" || dl.status === "cancelled" ? (
                                          <span className="flex items-center gap-1"><Download className="w-2.5 h-2.5" />Retry</span>
                                        ) : (
                                          <span className="flex items-center gap-1"><Download className="w-2.5 h-2.5" />Download</span>
                                        )}
                                      </Button>
                                    </div>
                                  </div>

                                  {/* Expanded Description / Reason */}
                                  <AnimatePresence>
                                    {isExpanded && (
                                      <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: "auto" }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="overflow-hidden"
                                      >
                                        <div className="pt-2 mt-2 border-t border-white/5 space-y-2">
                                          <p className="text-zinc-300 text-[11px] leading-relaxed">
                                            {clip.description}
                                          </p>
                                          {clip.reason && (
                                            <div className="flex items-start gap-1.5 bg-white/5 rounded-md px-2 py-1.5">
                                              <Sparkles className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                                              <p className="text-zinc-400 text-[10px] italic leading-relaxed">
                                                {clip.reason}
                                              </p>
                                            </div>
                                          )}
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </motion.div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
