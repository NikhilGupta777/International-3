import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Youtube, Search, ArrowRight, Play, Clock, Eye, Film, Music,
  Download, Loader2, Sparkles, Captions, Scissors, BellRing, Shield, ExternalLink, Send, ListVideo, AlarmClock, UploadCloud, Bot,
} from "lucide-react";
import { useGetVideoInfo, useDownloadVideo } from "@workspace/api-client-react";
import type { VideoFormat } from "@workspace/api-client-react";

import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatBytes, formatDuration, formatViews } from "@/lib/utils";
import { ActiveDownload } from "@/components/ActiveDownload";
import { BestClips, type BestClipsHandle } from "@/components/BestClips";
import { BhagwatVideos } from "@/components/BhagwatVideos";
import { GetSubtitles } from "@/components/GetSubtitles";
import { ClipCutter } from "@/components/ClipCutter";
import { KathaSceneFinder } from "@/components/KathaSceneFinder";
import { Timestamps } from "@/components/Timestamps";
import { FileUpload } from "@/components/FileUpload";
import { HelpPanel } from "@/components/HelpPanel";
import { ActivityPanel } from "@/components/ActivityPanel";
import { GUIDE_TABS, type GuideMode } from "@/lib/guide-tabs";
import { Sidebar } from "@/components/layout/Sidebar";
import { StudioCopilot } from "@/components/StudioCopilot";
import { StudioHome } from "@/components/StudioHome";
import VideoTranslator from "./VideoTranslator";
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
import { loadTranslatorHistory as loadTranslatorHistoryForNotify } from "@/lib/translator-history";
import {
  enablePushNotifications,
  getPushConfig,
  pushNotificationSupportSummary,
} from "@/lib/push-notifications";

type Mode = "home" | "download" | "clips" | "subtitles" | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps" | "upload" | "copilot" | "translator" | "help" | "activity";

type ClientAccessConfig = {
  downloadInputEnabled: boolean;
  telegram?: {
    url?: string;
    message?: string;
  };
};

const GUIDE_SEEN_KEY = "videomaking-guide-seen-v1";
const CLIP_JOB_MISSING_GRACE_MS = 15 * 60 * 1000;

// GUIDE_TABS now lives in @/lib/guide-tabs and is imported above so the
// dedicated Help sidebar tab and any inline guide stay in sync.

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
  for (const x of loadTranslatorHistoryForNotify()) keys.add(`translator:${x.jobId}`);
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
  const [mode, setMode] = useState<Mode>("home");
  const [pendingCopilotPrompt, setPendingCopilotPrompt] = useState<string | null>(null);
  const [copilotResetKey, setCopilotResetKey] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playerFormatId, setPlayerFormatId] = useState<string | undefined>();
  const [pushSupported, setPushSupported] = useState(false);
  const [pushConfigured, setPushConfigured] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [pushEnabling, setPushEnabling] = useState(false);
  const [telegramUrl, setTelegramUrl] = useState("https://t.me/c/2852263933/3");
  const [helpInitialMode, setHelpInitialMode] = useState<GuideMode>("download");
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
        setHelpInitialMode("download");
        setMode("help");
        try { localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch { /* ignore */ }
      }
    } catch {
      setHelpInitialMode("download");
      setMode("help");
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
  
  const videoFormats = video?.formats?.filter(
    f => f.hasVideo && f.hasAudio && (f.ext === "mp4" || f.formatId.includes("+")),
  )?.sort((a, b) => {
    const resA = parseInt(a.resolution?.split('x')[1] || '0');
    const resB = parseInt(b.resolution?.split('x')[1] || '0');
    if (resB !== resA) return resB - resA;
    return (b.filesize || 0) - (a.filesize || 0);
  }) || [];

  const hasSyntheticBest = videoFormats.some(
    (f) => f.formatId === "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
  );
  const displayVideoFormats: VideoFormat[] = hasSyntheticBest
    ? videoFormats
    : [
        {
          formatId: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
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

  const showHome = mode === "home";
  const showVideoInfo = mode === "download" && video && !jobId;
  const showSubtitles = mode === "subtitles";
  const showClipCutter = mode === "clipcutter";
  const showBhagwat = mode === "bhagwat";
  const showSceneFinder = mode === "scenefinder";
  const showTimestamps = mode === "timestamps";
  const showUpload = mode === "upload";
  const showCopilot = mode === "copilot";


  const buttonPlaceholder = mode === "clips" ? "Analyze" : "Start";
  const isSearchPending = getInfo.isPending;
  const showSearch = mode === "download" || mode === "clips";
  const isDownloadInputBlocked = false;

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
                  : "Find Sabha";
    const contentLabel = video?.title?.trim() || submittedUrl.trim();
    document.title = contentLabel
      ? `${modeLabel}: ${contentLabel} Ã‚Â· ${appName}`
      : `${modeLabel} Ã‚Â· ${appName}`;
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
        if (data.telegram?.url) setTelegramUrl(data.telegram.url);
      } catch {
        // Download access is open; this config only customizes the Telegram link.
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
    // Help is now a sidebar tab — switch into it and remember the user's
    // current tab so the guide opens to the relevant section by default.
    if (mode !== "help" && mode !== "activity" && mode !== "home" && mode !== "copilot" && mode !== "translator") {
      setHelpInitialMode(mode as GuideMode);
    }
    setMode("help");
    try { localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch { /* ignore */ }
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
        } else if (key.startsWith("translator:")) {
          const id = key.slice("translator:".length);
          const entry = loadTranslatorHistoryForNotify().find((x) => x.jobId === id);
          if (entry) notifyBackgroundCompletion("Translation", entry.filename);
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

  const switchMode = (m: Mode) => {
    setMode(m);
    const el = document.querySelector('.studio-content');
    if (el) el.scrollTop = 0;
  };

  return (
    <div className="studio-workspace">

      {/* Floating Help / Activity panel — pinned to top-right since the
          old topbar is removed in the new sidebar-based layout */}
      {/* Help and Activity are now first-class sidebar tabs (rendered below)
          instead of a floating top-right panel. */}
      {(() => { void pushSupported; void pushConfigured; void pushPermission; void pushEnabling; void handleEnablePush; void openGuide; return null; })()}

      {/* Ã¢â€â‚¬Ã¢â€â‚¬ Body: sidebar + content Ã¢â€â‚¬Ã¢â€â‚¬ */}
      <div className="studio-body">

        {/* Sidebar */}
        <Sidebar
          mode={mode}
          onModeChange={switchMode}
          onNewChat={() => {
            setPendingCopilotPrompt(null);
            setCopilotResetKey(k => k + 1);
            switchMode("copilot");
          }}
        />

        {/* Main scrollable content */}
        <main className={cn("studio-content", (mode === "copilot" || mode === "translator" || mode === "home" || mode === "help" || mode === "activity") && "overflow-hidden")} id="studio-content">
          <div className={cn("studio-content-inner", (mode === "copilot" || mode === "home" || mode === "help" || mode === "activity") && "is-copilot", mode === "translator" && "is-copilot")}>

            {/* Translator tab â€” full screen */}
            {mode === "translator" && <VideoTranslator />}

            {/* Help tab — dedicated page (replaces old GuideModal) */}
            {mode === "help" && (
              <HelpPanel
                initialMode={helpInitialMode}
                onSwitchTab={(next) => switchMode(next as Mode)}
              />
            )}

            {/* Activity tab — dedicated page (replaces old floating panel) */}
            {mode === "activity" && (
              <ActivityPanel
                onSwitchTab={(next) => switchMode(next as Mode)}
              />
            )}

            {/* Search bar Ã¢â‚¬â€ only for download + clips modes */}
            {showSearch && (
              <div className="studio-search-wrap">
                <form onSubmit={handleSearch}>
                  <div
                    className="relative rounded-xl flex p-1.5 items-center transition-all"
                    style={{ background: "#1a1a1a", border: "1px solid #2e2e2e", boxShadow: "0 2px 20px rgba(0,0,0,0.4)" }}
                  >
                    <Search className="w-5 h-5 text-white/40 ml-3 hidden sm:block shrink-0" />
                    <input
                      type="url"
                      name="youtube_url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="YouTube URL"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder={isDownloadInputBlocked ? "Download input is disabled" : "Paste YouTube URL..."}
                      disabled={isDownloadInputBlocked}
                      className="bg-transparent flex-1 outline-none px-3 sm:px-4 py-2.5 text-white placeholder:text-white/25 text-sm min-w-0 font-medium"
                    />
                    <Button
                      type="submit"
                      size="lg"
                      disabled={isSearchPending || !url.trim() || isDownloadInputBlocked}
                      className="h-10 px-4 sm:px-6 rounded-xl shrink-0 text-sm min-w-[90px]"
                    >
                      {isSearchPending ? (
                        <span className="flex items-center gap-2">
                          <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" />
                          <span className="hidden sm:inline">Fetching</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5">
                          {buttonPlaceholder}
                          <ArrowRight className="w-4 h-4" />
                        </span>
                      )}
                    </Button>
                  </div>
                </form>

                {/* Download blocked banner */}
                {mode === "download" && isDownloadInputBlocked && (
                  <div className="mt-4 glass-panel rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 bg-amber-500/20 p-2 rounded-lg border border-amber-400/40">
                        <Shield className="w-4 h-4 text-amber-300" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-amber-200 font-semibold text-sm">Download tab access is limited</p>
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
                          <span>Join Telegram Group</span>
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}


            {/* ═══════════════════════════════════════════════════════════════
               Genspark-style Studio Homepage — shown on fresh load
               ═══════════════════════════════════════════════════════════════ */}
            {mode === "download" && !video && !jobId && !isSearchPending && (
              <motion.div
                key="studio-home"
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.35 }}
                className="studio-home-hero"
              >
                {/* Brand header */}
                <div className="studio-home-brand">
                  <div className="studio-home-orb">
                    <Youtube className="w-7 h-7 text-primary" />
                  </div>
                  <h1 className="studio-home-title">
                    <span className="studio-home-gradient">VideoMaking</span>
                    <span className="text-white"> Studio</span>
                  </h1>
                  <p className="studio-home-sub">
                    AI-powered video tools — Download, Clip, Subtitle, Translate, and more.
                  </p>
                </div>

                {/* Tool bubbles — like Genspark AI workspace */}
                <div className="studio-home-grid">
                  {([
                    { icon: <Download className="w-5 h-5" />, label: "Download", desc: "MP4, Audio, 4K", mode: "download", color: "text-red-400" },
                    { icon: <Scissors className="w-5 h-5" />, label: "Clip Cutter", desc: "Trim any range", mode: "clipcutter", color: "text-orange-400" },
                    { icon: <Sparkles className="w-5 h-5" />, label: "Best Clips", desc: "AI highlights", mode: "clips", color: "text-yellow-400" },
                    { icon: <Captions className="w-5 h-5" />, label: "Subtitles", desc: "Auto + translate", mode: "subtitles", color: "text-blue-400" },
                    { icon: <AlarmClock className="w-5 h-5" />, label: "Timestamps", desc: "Chapter markers", mode: "timestamps", color: "text-purple-400" },
                    { icon: <Film className="w-5 h-5" />, label: "Translator", desc: "Dub any video", mode: "translator", color: "text-pink-400" },
                    { icon: <UploadCloud className="w-5 h-5" />, label: "Upload", desc: "Share files", mode: "upload", color: "text-cyan-400" },
                    { icon: <Bot className="w-5 h-5" />, label: "AI Agent", desc: "Ask anything", mode: "copilot", color: "text-emerald-400" },
                  ] as Array<{ icon: React.ReactNode; label: string; desc: string; mode: string; color: string }>).map((tool) => (
                    <button
                      key={tool.mode}
                      onClick={() => switchMode(tool.mode as Mode)}
                      className="studio-home-tool"
                    >
                      <span className={tool.color}>{tool.icon}</span>
                      <div className="studio-home-tool-text">
                        <span className="studio-home-tool-label">{tool.label}</span>
                        <span className="studio-home-tool-desc">{tool.desc}</span>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Quick tip */}
                <p className="studio-home-tip">
                  💡 Paste a YouTube URL above to get started, or click <button onClick={() => switchMode("copilot")} className="text-primary hover:underline font-semibold">AI Agent</button> to chat.
                </p>
              </motion.div>
            )}

            {/* Ã¢â€â‚¬Ã¢â€â‚¬ Content panels Ã¢â€â‚¬Ã¢â€â‚¬ */}

            {/* Active download progress */}
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

            <AnimatePresence mode="wait">

              {/* Download video info */}
              {showVideoInfo && (
                <motion.div
                  key="download-results"
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.4, delay: 0.05 }}
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

              {/* Best Clips */}
              {mode === "clips" && (
                <motion.div
                  key="clips-panel"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.25 }}
                >
                  <BestClips ref={bestClipsRef} url={url} />
                </motion.div>
              )}

              {/* Subtitles */}
              {showSubtitles && (
                <motion.div key="subtitles-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
                  <GetSubtitles />
                </motion.div>
              )}

              {/* Clip Cutter */}
              {showClipCutter && (
                <motion.div key="clipcutter-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
                  <ClipCutter />
                </motion.div>
              )}

              {/* Bhagwat Studio */}
              {showBhagwat && (
                <motion.div key="bhagwat-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full">
                  <BhagwatVideos />
                </motion.div>
              )}

              {/* Find Sabha */}
              {showSceneFinder && (
                <motion.div key="scenefinder-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full">
                  <KathaSceneFinder />
                </motion.div>
              )}

              {/* Timestamps */}
              {showTimestamps && (
                <motion.div key="timestamps-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full">
                  <Timestamps />
                </motion.div>
              )}

              {/* Share (upload) */}
              {showUpload && (
                <motion.div key="upload-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full">
                  <FileUpload />
                </motion.div>
              )}

              {/* Genspark-style Home workspace */}
              {showHome && (
                <motion.div
                  key="home-panel"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.3 }}
                  className="w-full h-full flex-1 flex flex-col"
                >
                  <StudioHome
                    onSwitchMode={(m) => switchMode(m as Mode)}
                    onLaunchAgent={(prompt) => {
                      setPendingCopilotPrompt(prompt);
                      switchMode("copilot");
                    }}
                  />
                </motion.div>
              )}

              {/* AI Copilot */}
              {showCopilot && (
                <motion.div key="copilot-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full h-full flex-1 flex flex-col">
                  <StudioCopilot
                    key={copilotResetKey}
                    onNavigate={(tab) => switchMode(tab as any)}
                    pendingPrompt={pendingCopilotPrompt}
                    onPromptConsumed={() => setPendingCopilotPrompt(null)}
                    onBackToHome={() => switchMode("home")}
                  />
                </motion.div>
              )}

            </AnimatePresence>

          </div>
        </main>
      </div>

    </div>
  );
}

// GuideModal has been replaced by HelpPanel (a full sidebar tab).
// Keep this stub so any older import sites compile; safe to delete later.

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
              Fixing with AIÃ¢â‚¬Â¦
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
          Downloading audio & running AI correction Ã¢â‚¬â€ this may take a minuteÃ¢â‚¬Â¦
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
          <span className="text-xs">Resolving streamÃ¢â‚¬Â¦</span>
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

