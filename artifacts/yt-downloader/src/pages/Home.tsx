import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Youtube, Search, ArrowRight, Play, Clock, Eye, Film, Music,
  Download, Loader2, Sparkles, Captions, Scissors, BellRing, Shield, ExternalLink, Send, ListVideo, AlarmClock
} from "lucide-react";
import { useGetVideoInfo, useDownloadVideo } from "@workspace/api-client-react";
import type { VideoFormat } from "@workspace/api-client-react";

import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatBytes, formatDuration, formatViews } from "@/lib/utils";
import { ActiveDownload } from "@/components/ActiveDownload";
import { BestClips, type BestClipsHandle } from "@/components/BestClips";
import { BhavishyaClips } from "@/components/BhavishyaClips";
import { BhagwatVideos } from "@/components/BhagwatVideos";
import { GetSubtitles } from "@/components/GetSubtitles";
import { ClipCutter } from "@/components/ClipCutter";
import { KathaSceneFinder } from "@/components/KathaSceneFinder";
import { Timestamps } from "@/components/Timestamps";
import { FloatingActivityPanel } from "@/components/FloatingActivityPanel";
import {
  saveActiveDownload,
  loadActiveDownload,
  clearActiveDownload,
  loadCompletedDownloads as loadCompletedDownloadsForNotify,
} from "@/lib/download-history";
import { loadHistory as loadSubtitleHistoryForNotify } from "@/lib/subtitle-history";
import {
  loadActiveClipJobs,
  loadClipHistory as loadClipHistoryForNotify,
  saveActiveClipJobs,
  saveToClipHistory,
  type ClipHistoryEntry,
} from "@/lib/clip-history";
import { loadBestClipsHistory as loadBestClipsHistoryForNotify } from "@/lib/best-clips-history";
import {
  enablePushNotifications,
  getPushConfig,
  pushNotificationSupportSummary,
} from "@/lib/push-notifications";

type Mode = "download" | "clips" | "subtitles" | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps";

type ClientAccessConfig = {
  downloadInputEnabled: boolean;
  telegram?: {
    url?: string;
    message?: string;
  };
};

const GUIDE_SEEN_KEY = "videomaking-guide-seen-v1";
const CLIP_JOB_MISSING_GRACE_MS = 15 * 60 * 1000;

const GUIDE_TABS: Array<{
  mode: Mode;
  title: string;
  summary: string;
  steps: string[];
}> = [
  {
    mode: "download",
    title: "Download Tab",
    summary: "Download complete videos or audio from a source URL.",
    steps: [
      "Paste the video URL and click Start.",
      "Pick quality/audio option from available formats.",
      "Track progress in Active Download and Activity panel.",
      "Use Save when the job is completed.",
    ],
  },
  {
    mode: "clips",
    title: "Best Clips Tab",
    summary: "Use AI to find high-value segments from a long video.",
    steps: [
      "Paste URL and choose duration mode (Auto / 1m / 3m / 8-10m).",
      "Add optional AI instructions for topic-specific clips.",
      "Click Find Best Clips and follow step progress.",
      "Download or retry each suggested clip card.",
    ],
  },
  {
    mode: "subtitles",
    title: "Subtitles Tab",
    summary: "Generate SRT subtitles from URL or uploaded media.",
    steps: [
      "Choose YouTube URL or Upload File mode.",
      "Select source language and optional translation language.",
      "Start generation and monitor the stage tracker.",
      "Download SRT or copy text when completed.",
    ],
  },
  {
    mode: "clipcutter",
    title: "Clip Cut Tab",
    summary: "Cut an exact time range and download only that segment.",
    steps: [
      "Paste URL and set Start / End timestamps.",
      "Choose output quality and click Cut & Download.",
      "Watch queue/progress status in job cards.",
      "Use Save when clip status becomes done.",
    ],
  },
  {
    mode: "bhagwat",
    title: "Bhagwat Studio Tab",
    summary: "Build devotional story videos with AI scene planning and rendering.",
    steps: [
      "Open Bhagwat Studio and unlock access with your password.",
      "Paste a URL or upload audio, then run Analyze to create timeline scenes.",
      "Review and improve AI prompt suggestions before render.",
      "Render final video and download from history when done.",
    ],
  },
  {
    mode: "scenefinder",
    title: "Scene Finder Tab",
    summary: "Find matching Katha scenes from pasted transcripts or notes.",
    steps: [
      "Paste transcript, SRT, or timestamped notes.",
      "Describe the scene/topic you want to find.",
      "Click Find Matching Scenes and wait for AI matching.",
      "Use the timestamps and quotes to cut or create videos.",
    ],
  },
  {
    mode: "timestamps",
    title: "Timestamps Tab",
    summary: "Generate YouTube chapter timestamps from any video using AI.",
    steps: [
      "Paste a YouTube URL and click Generate Timestamps.",
      "AI fetches the transcript automatically (or uses AssemblyAI if no subtitles).",
      "Gemini 2.5 Pro creates meaningful chapter markers.",
      "Copy the timestamps directly into your YouTube description.",
    ],
  },
];

function playSoftCompletionChime() {
  try {
    const AudioContextImpl =
      window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextImpl) return;
    const ctx = new AudioContextImpl();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.02, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.14);

    osc.connect(gain);
    gain.connect(ctx.destination);
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => void ctx.close().catch(() => {}), 220);
  } catch {
    // Ignore browser audio limitations.
  }
}

function buildCompletionSnapshot(): Set<string> {
  const keys = new Set<string>();
  for (const x of loadSubtitleHistoryForNotify()) keys.add(`subtitle:${x.id}`);
  for (const x of loadClipHistoryForNotify()) keys.add(`clip:${x.jobId}`);
  for (const x of loadCompletedDownloadsForNotify()) keys.add(`download:${x.jobId}`);
  for (const x of loadBestClipsHistoryForNotify()) keys.add(`bestclips:${x.id}`);
  return keys;
}

function notifyBackgroundCompletion(type: string, label: string) {
  const title = `${type} completed`;
  const body = label.length > 120 ? `${label.slice(0, 117)}...` : label;

  const send = () => {
    try {
      // Notification may fail on some browsers if permission is blocked.
      new Notification(title, { body, silent: false });
    } catch {
      // No-op
    }
  };

  if (typeof Notification === "undefined") return;
  if (Notification.permission === "granted") {
    send();
    return;
  }
  if (Notification.permission === "default") {
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") send();
    });
  }
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof (error as { data?: unknown }).data === "object" &&
    (error as { data?: { error?: unknown } }).data !== null
  ) {
    const maybeMessage = (error as { data?: { error?: unknown } }).data?.error;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) {
      return maybeMessage;
    }
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }

  return fallback;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [submittedUrl, setSubmittedUrl] = useState("");
  const bestClipsRef = useRef<BestClipsHandle>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [activeFormatId, setActiveFormatId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("clips");
  const [playing, setPlaying] = useState(false);
  const [playerFormatId, setPlayerFormatId] = useState<string | undefined>();
  const [pushSupported, setPushSupported] = useState(false);
  const [pushConfigured, setPushConfigured] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [pushEnabling, setPushEnabling] = useState(false);
  const [clientAccessLoaded, setClientAccessLoaded] = useState(false);
  const [downloadInputEnabled, setDownloadInputEnabled] = useState(false);
  const [telegramUrl, setTelegramUrl] = useState("https://t.me/c/2852263933/3");
  const [telegramMessage, setTelegramMessage] = useState(
    "For High Quality Fast Video Download, join this Telegram Group",
  );
  const [showGuide, setShowGuide] = useState(false);
  const [activeGuideMode, setActiveGuideMode] = useState<Mode>("download");
  const seenCompletionRef = useRef<Set<string>>(new Set());
  const initializedCompletionsRef = useRef(false);
  const { toast } = useToast();

  // Restore an active download job from localStorage on page load
  useEffect(() => {
    const saved = loadActiveDownload();
    if (saved) {
      setJobId(saved.jobId);
      if (saved.url) setUrl(saved.url);
      setMode("download");
    }
  }, []);

  useEffect(() => {
    try {
      const seen = localStorage.getItem(GUIDE_SEEN_KEY);
      if (!seen) {
        setShowGuide(true);
        setActiveGuideMode("download");
      }
    } catch {
      setShowGuide(true);
      setActiveGuideMode("download");
    }
  }, []);

  const getInfo = useGetVideoInfo({
    mutation: {
      onSuccess: () => {
        setJobId(null);
        setActiveFormatId(null);
        setPlaying(false);
        setPlayerFormatId(undefined);
      },
      onError: (error) => {
        toast({
          title: "Couldn't fetch video",
          description: getApiErrorMessage(
            error,
            "Please check the URL and try again.",
          ),
          variant: "destructive",
        });
      }
    }
  });

  const download = useDownloadVideo({
    mutation: {
      onSuccess: (data) => {
        setJobId(data.jobId);
        saveActiveDownload({
          jobId: data.jobId,
          url: submittedUrl || url.trim(),
          savedAt: Date.now(),
        });
      },
      onError: (error) => {
        toast({
          title: "Download Failed",
          description: getApiErrorMessage(
            error,
            "Could not start the download process.",
          ),
          variant: "destructive",
        });
        setActiveFormatId(null);
      }
    }
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "download" && (!clientAccessLoaded || !downloadInputEnabled)) {
      toast({
        title: "Download access is limited",
        description: "Join the Telegram group below for high quality fast downloads.",
        variant: "destructive",
      });
      return;
    }
    const normalizedUrl = url.trim();
    if (!normalizedUrl) return;
    setSubmittedUrl(normalizedUrl);
    if (mode === "download") {
      getInfo.mutate({ data: { url: normalizedUrl } });
    } else if (mode === "clips") {
      bestClipsRef.current?.startAnalyze();
    }
  };

  const handleDownload = (format: VideoFormat) => {
    const downloadUrl = submittedUrl || url.trim();
    if (!downloadUrl) {
      toast({
        title: "Missing URL",
        description: "Please paste a valid YouTube URL first.",
        variant: "destructive",
      });
      return;
    }
    setActiveFormatId(format.formatId);
    download.mutate({ 
      data: { 
        url: downloadUrl,
        formatId: format.formatId, 
        audioOnly: !format.hasVideo 
      } 
    });
  };

  const video = getInfo.data;
  
  const videoFormats = video?.formats?.filter(f => f.hasVideo && f.hasAudio)?.sort((a, b) => {
    const resA = parseInt(a.resolution?.split('x')[1] || '0');
    const resB = parseInt(b.resolution?.split('x')[1] || '0');
    if (resB !== resA) return resB - resA;
    return (b.filesize || 0) - (a.filesize || 0);
  }) || [];

  const hasSyntheticBest = videoFormats.some(
    (f) => f.formatId === "bestvideo+bestaudio/best",
  );
  const displayVideoFormats: VideoFormat[] = hasSyntheticBest
    ? videoFormats
    : [
        {
          formatId: "bestvideo+bestaudio/best",
          ext: "mp4",
          resolution: "source",
          fps: null,
          filesize: null,
          vcodec: "best",
          acodec: "best",
          quality: "BEST",
          label: "Best quality (merged)",
          hasVideo: true,
          hasAudio: true,
        },
        ...videoFormats,
      ];

  const audioFormats = video?.formats?.filter(f => !f.hasVideo && f.hasAudio)?.sort((a, b) => {
    return (b.filesize || 0) - (a.filesize || 0);
  }) || [];

  const showVideoInfo = mode === "download" && video && !jobId;
  const showClips = mode === "clips" && submittedUrl;
  const showSubtitles = mode === "subtitles";
  const showClipCutter = mode === "clipcutter";
  const showBhagwat = mode === "bhagwat";
  const showSceneFinder = mode === "scenefinder";
  const showTimestamps = mode === "timestamps";

  const buttonPlaceholder = mode === "clips" ? "Analyze" : "Start";
  const isSearchPending = getInfo.isPending;
  const showSearch = mode !== "subtitles" && mode !== "clipcutter" && mode !== "bhagwat" && mode !== "scenefinder" && mode !== "timestamps";
  const isDownloadInputBlocked =
    mode === "download" && (!clientAccessLoaded || !downloadInputEnabled);

  useEffect(() => {
    const appName = "VideoMaking Studio";
    const modeLabel =
      mode === "download"
        ? "Download"
        : mode === "clips"
          ? "Best Clips"
          : mode === "subtitles"
            ? "Subtitles"
            : mode === "clipcutter"
              ? "Clip Cutter"
              : mode === "bhagwat"
                ? "Bhagwat Studio"
                : mode === "timestamps"
                  ? "Timestamps"
                  : "Scene Finder";
    const contentLabel = video?.title?.trim() || submittedUrl.trim();
    document.title = contentLabel
      ? `${modeLabel}: ${contentLabel} · ${appName}`
      : `${modeLabel} · ${appName}`;
  }, [mode, submittedUrl, video?.title]);

  useEffect(() => {
    const support = pushNotificationSupportSummary();
    setPushSupported(support.supported);
    setPushPermission(support.permission);

    if (!support.supported) return;
    void getPushConfig().then((cfg) => {
      if (!cfg) return;
      setPushConfigured(Boolean(cfg.enabled && cfg.publicKey));
    });
  }, []);

  useEffect(() => {
    let closed = false;
    const loadClientAccess = async () => {
      try {
        const res = await fetch(
          `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/youtube/client-access`,
        );
        if (!res.ok) throw new Error("Failed to load access config");
        const data = (await res.json()) as ClientAccessConfig;
        if (closed) return;
        setDownloadInputEnabled(Boolean(data.downloadInputEnabled));
        if (data.telegram?.url) setTelegramUrl(data.telegram.url);
        if (data.telegram?.message) setTelegramMessage(data.telegram.message);
      } catch {
        if (!closed) {
          setDownloadInputEnabled(false);
        }
      } finally {
        if (!closed) setClientAccessLoaded(true);
      }
    };
    void loadClientAccess();
    return () => {
      closed = true;
    };
  }, []);

  const handleEnablePush = async () => {
    setPushEnabling(true);
    const result = await enablePushNotifications();
    setPushEnabling(false);

    const support = pushNotificationSupportSummary();
    setPushPermission(support.permission);

    if (result.ok) {
      toast({
        title: "Alerts enabled",
        description: "You will receive background completion notifications.",
      });
      return;
    }

    const description =
      result.reason === "permission_denied"
        ? "Notification permission is blocked in your browser settings."
        : result.reason === "not_configured"
          ? "Push is not configured on the server yet."
          : "Could not enable browser alerts on this device.";
    toast({
      title: "Could not enable alerts",
      description,
      variant: "destructive",
    });
  };

  const openGuide = () => {
    setActiveGuideMode(mode);
    setShowGuide(true);
  };

  const closeGuide = () => {
    setShowGuide(false);
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, "1");
    } catch {}
  };

  // Background completion notifications across all tabs/history sources.
  useEffect(() => {
    const sync = () => {
      const snapshot = buildCompletionSnapshot();
      if (!initializedCompletionsRef.current) {
        seenCompletionRef.current = snapshot;
        initializedCompletionsRef.current = true;
        return;
      }

      const isBackground = document.visibilityState !== "visible" || !document.hasFocus();
      if (!isBackground) {
        seenCompletionRef.current = snapshot;
        return;
      }

      for (const key of snapshot) {
        if (seenCompletionRef.current.has(key)) continue;

        if (key.startsWith("subtitle:")) {
          const id = key.slice("subtitle:".length);
          const entry = loadSubtitleHistoryForNotify().find((x) => x.id === id);
          if (entry) notifyBackgroundCompletion("Subtitles", entry.srtFilename);
        } else if (key.startsWith("clip:")) {
          const id = key.slice("clip:".length);
          const entry = loadClipHistoryForNotify().find((x) => x.jobId === id);
          if (entry) notifyBackgroundCompletion("Clip cut", entry.label);
        } else if (key.startsWith("download:")) {
          const id = key.slice("download:".length);
          const entry = loadCompletedDownloadsForNotify().find((x) => x.jobId === id);
          if (entry) notifyBackgroundCompletion("Download", entry.filename);
        } else if (key.startsWith("bestclips:")) {
          const id = key.slice("bestclips:".length);
          const entry = loadBestClipsHistoryForNotify().find((x) => x.id === id);
          if (entry) notifyBackgroundCompletion("Best clips", `${entry.clipCount} clips ready`);
        }

        playSoftCompletionChime();
      }

      seenCompletionRef.current = snapshot;
    };

    sync();
    const timer = setInterval(sync, 4000);
    return () => clearInterval(timer);
  }, []);

  // Reconcile Clip Cutter jobs even when user is on other tabs or reopens later.
  useEffect(() => {
    let closed = false;

    const syncClipJobs = async () => {
      const active = loadActiveClipJobs();
      if (active.length === 0) return;

      const nextActive: typeof active = [];
      let changed = false;

      for (const j of active) {
        try {
          const res = await fetch(
            `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/youtube/progress/${encodeURIComponent(j.jobId)}`,
          );
          if (res.status === 404) {
            if (Date.now() - j.startedAt < CLIP_JOB_MISSING_GRACE_MS) {
              nextActive.push(j);
              continue;
            }
            changed = true;
            continue;
          }
          if (!res.ok) {
            nextActive.push(j);
            continue;
          }
          const data = (await res.json()) as {
            status?: string;
            filename?: string | null;
            filesize?: number | null;
          };
          const status = data.status ?? "pending";

          if (status === "done") {
            const entry: ClipHistoryEntry = {
              jobId: j.jobId,
              createdAt: Date.now(),
              label: j.label,
              url: j.url,
              quality: j.quality,
              filename: data.filename ?? `${j.jobId}.mp4`,
              filesize: data.filesize ?? null,
              durationSecs: Math.max(1, j.endSecs - j.startSecs),
            };
            saveToClipHistory(entry);
            changed = true;
            continue;
          }

          if (status === "error" || status === "cancelled" || status === "expired") {
            changed = true;
            continue;
          }

          nextActive.push(j);
        } catch {
          nextActive.push(j);
        }
      }

      if (!closed && changed) {
        saveActiveClipJobs(nextActive);
      }
    };

    void syncClipJobs();
    const timer = setInterval(() => void syncClipJobs(), 5000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="min-h-screen relative overflow-x-hidden flex flex-col items-center pb-24 px-2 sm:px-6">
      
      {/* Premium Background */}
      <div className="fixed inset-0 z-[-1]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(229,9,20,0.22),transparent_50%),radial-gradient(circle_at_80%_15%,rgba(147,51,234,0.14),transparent_45%),radial-gradient(circle_at_50%_100%,rgba(244,63,94,0.16),transparent_55%)]" />
        <div className="absolute inset-0 bg-background/80 backdrop-blur-[20px] sm:backdrop-blur-[60px]" />
        <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/20 blur-[120px] rounded-full pointer-events-none" />
      </div>

      <main className="w-full max-w-5xl mx-auto flex flex-col items-center z-10 relative">
        
        {/* Header + Search */}
        <motion.div 
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "w-full flex flex-col items-center transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]",
            (showVideoInfo || showClips || showSubtitles || showClipCutter || showBhagwat || showSceneFinder) ? "pt-12 mb-8" : "pt-[25vh]"
          )}
        >
          {/* Logo */}
          <motion.div layout className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-8">
            <div className="bg-primary/20 p-3 rounded-2xl border border-primary/30 shadow-[0_0_30px_rgba(229,9,20,0.3)]">
              <Youtube className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-2xl sm:text-3xl md:text-5xl font-display font-bold tracking-tight text-white text-center sm:text-left">
              VideoMaking <span className="text-primary text-glow">Studio</span>
            </h1>
          </motion.div>

          {!showVideoInfo && !showClips && (
            <motion.p layout className="text-white/60 text-base sm:text-lg mb-6 sm:mb-8 text-center max-w-lg px-2 sm:px-0">
              Smart media workspace for YouTube workflows: fast downloads, AI best-clips extraction, subtitles, precise clip cutting, scene finding, and Bhagwat devotional studio rendering.
            </motion.p>
          )}

          {/* Mode Tabs */}
          <motion.div
            layout
            className="w-full sm:w-auto mb-6 rounded-2xl border border-white/10 bg-white/5 p-1"
          >
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            <button
              onClick={() => { setMode("download"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "download"
                  ? "bg-primary text-white shadow-[0_0_20px_rgba(229,9,20,0.3)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <Download className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Get</span>
              <span className="hidden sm:inline">Download</span>
            </button>
            <button
              onClick={() => { setMode("clips"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "clips"
                  ? "bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-[0_0_20px_rgba(139,92,246,0.4)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Clips</span>
              <span className="hidden sm:inline">Best Clips</span>
              <Badge className="hidden sm:inline-flex bg-violet-500/20 text-violet-300 border-violet-500/30 text-[10px] px-1.5 py-0">
                AI
              </Badge>
            </button>
            <button
              onClick={() => { setMode("subtitles"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "subtitles"
                  ? "bg-gradient-to-r from-teal-600 to-cyan-600 text-white shadow-[0_0_20px_rgba(20,184,166,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <Captions className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Subs</span>
              <span className="hidden sm:inline">Subtitles</span>
            </button>
            <button
              onClick={() => { setMode("clipcutter"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "clipcutter"
                  ? "bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-[0_0_20px_rgba(249,115,22,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <Scissors className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Cut</span>
              <span className="hidden sm:inline">Clip Cut</span>
            </button>
            <button
              onClick={() => { setMode("bhagwat"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "bhagwat"
                  ? "bg-gradient-to-r from-amber-600 to-yellow-600 text-white shadow-[0_0_20px_rgba(245,158,11,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <Shield className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Bhagwat</span>
              <span className="hidden sm:inline">Bhagwat</span>
              <Badge className="hidden sm:inline-flex bg-amber-500/20 text-amber-200 border-amber-500/30 text-[10px] px-1.5 py-0">
                Pro
              </Badge>
            </button>
            <button
              onClick={() => { setMode("scenefinder"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "scenefinder"
                  ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-[0_0_20px_rgba(6,182,212,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <ListVideo className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Scenes</span>
              <span className="hidden sm:inline">Scene Find</span>
              <Badge className="hidden sm:inline-flex bg-cyan-500/20 text-cyan-200 border-cyan-500/30 text-[10px] px-1.5 py-0">
                AI
              </Badge>
            </button>
            <button
              onClick={() => { setMode("timestamps"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "timestamps"
                  ? "bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <AlarmClock className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Times</span>
              <span className="hidden sm:inline">Timestamps</span>
              <Badge className="hidden sm:inline-flex bg-indigo-500/20 text-indigo-200 border-indigo-500/30 text-[10px] px-1.5 py-0">
                AI
              </Badge>
            </button>
            </div>
          </motion.div>

          {/* Search Bar — hidden in Bhagwat mode */}
          {pushSupported && pushConfigured && pushPermission !== "granted" && (
            <motion.div layout className="mb-4 w-full max-w-2xl">
              <div className="glass-panel rounded-2xl border border-teal-500/25 bg-teal-500/10 px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-teal-200">
                  <BellRing className="w-4 h-4 shrink-0" />
                  <span className="text-sm font-medium">
                    Enable browser alerts for completed downloads and clips.
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleEnablePush}
                  disabled={pushEnabling}
                  className="bg-teal-600 hover:bg-teal-500 text-white shrink-0 w-full sm:w-auto"
                >
                  {pushEnabling ? "Enabling..." : "Enable Alerts"}
                </Button>
              </div>
            </motion.div>
          )}

          <motion.form 
            layout 
            onSubmit={handleSearch}
            className={cn("w-full max-w-2xl relative group", !showSearch && "hidden")}
          >
            <div className="absolute -inset-1 bg-gradient-to-r from-primary/60 to-purple-600/60 rounded-2xl blur-lg opacity-30 group-hover:opacity-60 transition duration-500 pointer-events-none" />
            <div className="relative glass-panel rounded-2xl flex p-2 shadow-2xl items-center focus-within:border-primary/50 transition-colors">
              <Search className="w-6 h-6 text-white/40 ml-4 hidden sm:block" />
              <input 
                type="url"
                name="youtube_url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                aria-label="YouTube URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={
                  isDownloadInputBlocked
                    ? "Download input is disabled"
                    : "Paste YouTube URL..."
                }
                disabled={isDownloadInputBlocked}
                className="bg-transparent flex-1 outline-none px-3 sm:px-4 py-3 text-white placeholder:text-white/30 text-base sm:text-lg min-w-0"
              />
              <Button 
                type="submit" 
                size="lg"
                disabled={
                  isSearchPending || !url.trim() || isDownloadInputBlocked
                }
                className="h-10 sm:h-12 px-3 sm:px-6 rounded-xl shrink-0 text-sm sm:text-base min-w-[106px] sm:min-w-0"
              >
                {isSearchPending ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" />
                    <span className="hidden sm:inline">Fetching</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 sm:gap-2">
                    <span className="sm:hidden">{mode === "clips" ? "Analyze" : "Start"}</span>
                    <span className="hidden sm:inline">{buttonPlaceholder}</span>
                    <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
                  </span>
                )}
              </Button>
            </div>
          </motion.form>

          {mode === "download" && isDownloadInputBlocked && (
            <motion.div
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 w-full max-w-2xl"
            >
              <div className="glass-panel rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 bg-amber-500/20 p-2 rounded-lg border border-amber-400/40">
                    <Shield className="w-4 h-4 text-amber-300" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-amber-200 font-semibold text-sm">
                      Download tab access is limited
                    </p>
                    <p className="text-amber-100/80 text-sm mt-1">
                      Download support for YouTube, Instagram, and Twitter videos is managed via Telegram.
                    </p>
                    <a
                      href={telegramUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-xl bg-[#229ED9] hover:bg-[#1b8fc4] border border-[#58b8e6] px-4 py-2.5 text-sm font-bold text-white shadow-[0_0_16px_rgba(34,158,217,0.35)] transition-colors"
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/20">
                        <Send className="w-3.5 h-3.5" />
                      </span>
                      <span className="text-center">Join Telegram Group</span>
                      <ExternalLink className="w-4 h-4" />
                    </a>
                    <p className="text-[12px] text-amber-100/60 mt-2">
                      Tap the blue button above to open Telegram.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </motion.div>

        {/* Content area */}
        <div className="w-full">

          {/* Download Progress — always its own AnimatePresence so it overlays independently */}
          <AnimatePresence>
            {jobId && mode === "download" && (
              <ActiveDownload
                jobId={jobId}
                onReset={() => {
                  clearActiveDownload();
                  setJobId(null);
                  setActiveFormatId(null);
                }}
                onExpired={clearActiveDownload}
              />
            )}
          </AnimatePresence>

          {/* Single AnimatePresence so tab exit + enter are coordinated */}
          <AnimatePresence mode="wait">

          {/* ── Download Mode ── */}
            {showVideoInfo && (
              <motion.div 
                key="download-results"
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="flex flex-col gap-8"
              >
                {/* Video Info Card */}
                <div className="glass-panel p-4 sm:p-6 rounded-3xl flex flex-col md:flex-row gap-6 sm:gap-8 items-center md:items-start group relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 blur-[80px] rounded-full pointer-events-none" />
                  
                  <div className="relative w-full md:w-80 shrink-0 aspect-video rounded-2xl overflow-hidden shadow-2xl border border-white/10 group-hover:border-primary/30 transition-colors bg-black">
                    {playing ? (
                      <InlinePlayer
                        url={url}
                        formatId={playerFormatId}
                        onClose={() => setPlaying(false)}
                      />
                    ) : (
                      <button
                        className="w-full h-full relative"
                        onClick={() => {
                          const combined = videoFormats.find(f => !f.formatId.includes("+"));
                          setPlayerFormatId(combined?.formatId);
                          setPlaying(true);
                        }}
                      >
                        <img src={video.thumbnail || ''} alt={video.title} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/30 hover:bg-black/10 transition-colors flex items-center justify-center">
                          <div className="bg-black/50 backdrop-blur-md p-3 rounded-full text-white/90 hover:text-white hover:scale-110 transition-all shadow-lg">
                            <Play className="w-8 h-8 ml-1" />
                          </div>
                        </div>
                        <div className="absolute bottom-2 right-2 bg-black/80 backdrop-blur-md text-white text-xs font-semibold px-2 py-1 rounded-md flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDuration(video.duration)}
                        </div>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col flex-1 w-full justify-center h-full min-h-[180px]">
                    <h2 className="text-2xl sm:text-3xl font-display font-bold text-white leading-tight mb-4">
                      {video.title}
                    </h2>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-white/70">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-gray-700 to-gray-900 border border-white/10 flex items-center justify-center font-bold text-xs text-white uppercase shadow-inner">
                          {video.uploader?.charAt(0) || 'Y'}
                        </div>
                        <span className="font-medium text-white/90">{video.uploader}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <Eye className="w-4 h-4 text-white/40" />
                        {formatViews(video.viewCount)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Formats Grid */}
                <div className="space-y-8">
                  {videoFormats.length > 0 && (
                    <div className="space-y-4">
                      <div className="flex items-center gap-3 px-2">
                        <Film className="w-5 h-5 text-primary" />
                        <h3 className="text-xl font-display font-semibold text-white">Video Options</h3>
                        <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent ml-4" />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {displayVideoFormats.map((format, idx) => (
                          <FormatCard 
                            key={format.formatId} 
                            format={format} 
                            isBest={idx === 0} 
                            onDownload={handleDownload}
                            isPending={activeFormatId === format.formatId && download.isPending}
                            isDisabled={download.isPending}
                          />
                        ))}
                      </div>
                      <SubtitleDownloadRow url={submittedUrl} />
                    </div>
                  )}

                  {audioFormats.length > 0 && (
                    <div className="space-y-4">
                      <div className="flex items-center gap-3 px-2">
                        <Music className="w-5 h-5 text-purple-400" />
                        <h3 className="text-xl font-display font-semibold text-white">Audio Only</h3>
                        <div className="h-[1px] flex-1 bg-gradient-to-r from-white/10 to-transparent ml-4" />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {audioFormats.slice(0, 6).map((format, idx) => (
                          <FormatCard 
                            key={format.formatId} 
                            format={format} 
                            isBest={idx === 0} 
                            onDownload={handleDownload}
                            isPending={activeFormatId === format.formatId && download.isPending}
                            isDisabled={download.isPending}
                            audioOnly
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

          {/* ── Best Clips Mode ── */}
            {mode === "clips" && (
              <motion.div
                key="clips-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col"
              >
                <BestClips ref={bestClipsRef} url={url} />
                {submittedUrl && <BhavishyaClips url={submittedUrl} />}
              </motion.div>
            )}

          {/* ── Subtitles Mode ── */}
            {showSubtitles && (
              <motion.div
                key="subtitles-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
              >
                <GetSubtitles />
              </motion.div>
            )}

          {/* ── Clip Cutter Mode ── */}
            {showClipCutter && (
              <motion.div
                key="clipcutter-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
              >
                <ClipCutter />
              </motion.div>
            )}

          {/* ── Bhagwat Studio Mode ── */}
            {showBhagwat && (
              <motion.div
                key="bhagwat-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="w-full"
              >
                <BhagwatVideos />
              </motion.div>
            )}

            {showSceneFinder && (
              <motion.div
                key="scenefinder-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="w-full"
              >
                <KathaSceneFinder />
              </motion.div>
            )}

            {showTimestamps && (
              <motion.div
                key="timestamps-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="w-full"
              >
                <Timestamps />
              </motion.div>
            )}

          </AnimatePresence>

        </div>
      </main>

      <FloatingActivityPanel onSwitchTab={setMode} onOpenGuide={openGuide} />

      <GuideModal
        open={showGuide}
        activeMode={activeGuideMode}
        onSelectMode={setActiveGuideMode}
        onSwitchTab={(nextMode) => {
          setMode(nextMode);
          setActiveGuideMode(nextMode);
          window.scrollTo({ top: 0, behavior: "smooth" });
          closeGuide();
        }}
        onClose={closeGuide}
      />
    </div>
  );
}

function GuideModal({
  open,
  activeMode,
  onSelectMode,
  onSwitchTab,
  onClose,
}: {
  open: boolean;
  activeMode: Mode;
  onSelectMode: (mode: Mode) => void;
  onSwitchTab: (mode: Mode) => void;
  onClose: () => void;
}) {
  const activeIndex = Math.max(
    0,
    GUIDE_TABS.findIndex((x) => x.mode === activeMode),
  );
  const active = GUIDE_TABS[activeIndex];
  const isLast = activeIndex === GUIDE_TABS.length - 1;

  const handleNext = () => {
    if (isLast) {
      onSwitchTab(active.mode);
      return;
    }
    onSelectMode(GUIDE_TABS[activeIndex + 1].mode);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm p-4 sm:p-6 flex items-start sm:items-center justify-center overflow-y-auto"
        >
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.98 }}
            className="w-full max-w-3xl my-4 sm:my-0 max-h-[92vh] glass-panel rounded-3xl border border-white/15 overflow-hidden flex flex-col"
          >
            <div className="px-5 sm:px-7 py-5 border-b border-white/10 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-teal-300/80 font-semibold">
                  Welcome Guide
                </p>
                <h3 className="text-xl sm:text-2xl font-display font-bold text-white mt-1">
                  How VideoMaking Studio Works
                </h3>
                <p className="text-sm text-white/55 mt-1">
                  Quick walkthrough of each tab so new users can start confidently.
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                className="text-white/60 hover:text-white hover:bg-white/10 px-2.5 sm:px-4"
                onClick={onClose}
              >
                <span className="sm:hidden">✕</span>
                <span className="hidden sm:inline">Close</span>
              </Button>
            </div>

            <div className="p-4 sm:p-7 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4 sm:gap-5 overflow-y-auto">
              <div className="hidden md:block space-y-2">
                {GUIDE_TABS.map((tab) => (
                  <button
                    key={tab.mode}
                    type="button"
                    onClick={() => onSelectMode(tab.mode)}
                    className={cn(
                      "w-full text-left rounded-xl border px-3.5 py-3 transition-colors",
                      activeMode === tab.mode
                        ? "bg-primary/15 border-primary/40 text-white"
                        : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:border-white/20",
                    )}
                  >
                    <p className="font-semibold text-sm">{tab.title}</p>
                    <p className="text-xs mt-1 opacity-80">{tab.summary}</p>
                  </button>
                ))}
              </div>

              <div className="md:hidden -mt-1 flex gap-2 overflow-x-auto no-scrollbar pb-1">
                {GUIDE_TABS.map((tab) => (
                  <button
                    key={`mobile-${tab.mode}`}
                    type="button"
                    onClick={() => onSelectMode(tab.mode)}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap",
                      activeMode === tab.mode
                        ? "bg-primary/20 border-primary/50 text-white"
                        : "bg-white/5 border-white/15 text-white/70",
                    )}
                  >
                    {tab.title.replace(" Tab", "")}
                  </button>
                ))}
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/20 p-4 sm:p-5">
                <h4 className="text-lg sm:text-xl font-display font-semibold text-white">{active.title}</h4>
                <p className="text-sm text-white/60 mt-1">{active.summary}</p>
                <div className="mt-3 sm:mt-4 space-y-2.5">
                  {active.steps.map((step, idx) => (
                    <div
                      key={`${active.mode}-step-${idx}`}
                      className="flex items-start gap-2.5 text-sm text-white/80"
                    >
                      <span className="w-5 h-5 shrink-0 rounded-full bg-primary/20 border border-primary/40 text-[11px] text-primary flex items-center justify-center font-semibold">
                        {idx + 1}
                      </span>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 sm:mt-5 pt-4 border-t border-white/10 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    onClick={handleNext}
                    className="bg-primary hover:bg-primary/90 text-white w-full sm:w-auto"
                  >
                    {isLast ? "Start Making" : "Next"}
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FormatCard({ 
  format, 
  isBest, 
  onDownload, 
  isPending, 
  isDisabled,
  audioOnly = false
}: { 
  format: VideoFormat; 
  isBest: boolean; 
  onDownload: (f: VideoFormat) => void;
  isPending: boolean;
  isDisabled: boolean;
  audioOnly?: boolean;
}) {
  return (
    <div className="group relative glass-panel hover:bg-white/10 border-white/5 hover:border-primary/40 transition-all duration-300 rounded-2xl p-5 overflow-hidden flex flex-col justify-between">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
      
      <div className="relative z-10 flex justify-between items-start mb-4">
        <div>
          <span className="font-display font-bold text-2xl text-white tracking-tight">
            {format.quality}
          </span>
          <div className="flex items-center gap-2 text-sm text-white/50 mt-1">
            <span className="uppercase font-medium tracking-wide">{format.ext}</span>
            <span className="w-1 h-1 rounded-full bg-white/20" />
            <span>{format.vcodec !== 'none' ? format.vcodec?.split('.')[0] : format.acodec?.split('.')[0] || 'Unknown'}</span>
          </div>
        </div>
        
        {isBest && (
          <Badge className={audioOnly ? "bg-purple-500/20 text-purple-300 border-purple-500/30" : "bg-primary/20 text-red-300 border-primary/30"}>
            Best Quality
          </Badge>
        )}
      </div>

      <div className="relative z-10 flex items-center justify-between mt-2">
        <span className="text-white/80 font-medium text-sm">
          {formatBytes(format.filesize)}
        </span>
        
        <Button 
          size="sm" 
          variant={isBest ? "default" : "glass"}
          onClick={() => onDownload(format)}
          disabled={isDisabled}
          className={cn(
            "rounded-lg px-4",
            !isBest && "bg-white/10 hover:bg-white/20 border-transparent shadow-none"
          )}
        >
          {isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>Get <Download className="w-4 h-4 ml-2 opacity-70 group-hover:opacity-100 group-hover:-translate-y-0.5 transition-all" /></>
          )}
        </Button>
      </div>
    </div>
  );
}

function SubtitleDownloadRow({ url }: { url: string }) {
  const [fixing, setFixing] = useState(false);
  const { toast } = useToast();

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const encoded = encodeURIComponent(url);

  const handleFixWithAI = async () => {
    setFixing(true);
    try {
      const res = await fetch(`${BASE}/api/youtube/subtitles/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, format: "srt" }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error || "AI correction failed");
      }

      const text = await res.text();
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = "subtitles-ai-corrected.srt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);

      toast({ title: "Done!", description: "AI-corrected subtitles downloaded." });
    } catch (err: any) {
      toast({
        title: "AI Correction Failed",
        description: err.message || "Could not correct subtitles. Make sure a Gemini API key is configured.",
        variant: "destructive",
      });
    } finally {
      setFixing(false);
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 border-white/5">
      <div className="flex items-center gap-2 shrink-0">
        <Captions className="w-4 h-4 text-white/50" />
        <span className="text-sm font-medium text-white/60">Subtitles</span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={`${BASE}/api/youtube/subtitles?url=${encoded}&format=srt`}
          download="subtitles.srt"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/14 border border-white/10 hover:border-white/20 text-white/70 hover:text-white text-xs font-semibold transition-all duration-200"
        >
          <Download className="w-3 h-3" />
          SRT
        </a>
        <a
          href={`${BASE}/api/youtube/subtitles?url=${encoded}&format=vtt`}
          download="subtitles.vtt"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/14 border border-white/10 hover:border-white/20 text-white/70 hover:text-white text-xs font-semibold transition-all duration-200"
        >
          <Download className="w-3 h-3" />
          VTT
        </a>

        <div className="w-px h-5 bg-white/10 mx-0.5 hidden sm:block" />

        <button
          onClick={handleFixWithAI}
          disabled={fixing}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 border",
            fixing
              ? "bg-violet-500/10 border-violet-500/20 text-violet-300 cursor-wait"
              : "bg-gradient-to-r from-violet-600/20 to-purple-600/20 hover:from-violet-600/30 hover:to-purple-600/30 border-violet-500/30 hover:border-violet-500/50 text-violet-300 hover:text-violet-200"
          )}
        >
          {fixing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Fixing with AI…
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              Fix with AI
            </>
          )}
        </button>
      </div>

      {fixing && (
        <p className="text-xs text-white/30 sm:ml-auto">
          Downloading audio & running AI correction — this may take a minute…
        </p>
      )}
    </div>
  );
}

function InlinePlayer({
  url,
  formatId,
  onClose,
}: {
  url: string;
  formatId?: string;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const streamUrl =
    `${BASE}/api/youtube/stream?url=${encodeURIComponent(url)}` +
    (formatId ? `&formatId=${encodeURIComponent(formatId)}` : "");

  return (
    <div className="w-full h-full relative bg-black">
      {loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/50 z-10">
          <Loader2 className="w-7 h-7 animate-spin" />
          <span className="text-xs">Resolving stream…</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/50 z-10 p-4 text-center">
          <span className="text-xs">Can't play this format in browser.</span>
          <button onClick={onClose} className="text-xs underline text-white/40 hover:text-white/70">
            Back to thumbnail
          </button>
        </div>
      )}
      {!error && (
        <video
          key={streamUrl}
          src={streamUrl}
          controls
          autoPlay
          className="w-full h-full object-contain"
          onCanPlay={() => setLoading(false)}
          onLoadedData={() => setLoading(false)}
          onError={() => { setLoading(false); setError(true); }}
        />
      )}
      {!error && (
        <button
          onClick={onClose}
          className="absolute top-1.5 right-1.5 z-20 bg-black/60 hover:bg-black/90 text-white/70 hover:text-white rounded-full p-1 transition-colors"
          title="Back to thumbnail"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </button>
      )}
    </div>
  );
}
