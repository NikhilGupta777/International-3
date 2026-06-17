import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, ArrowRight, Play, Clock, Eye, Film, Music,
  Download, Loader2, Sparkles, Captions, Shield, ExternalLink, Send,
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
import { AdminPanel } from "@/components/AdminPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { GUIDE_TABS, type GuideMode } from "@/lib/guide-tabs";
import { Sidebar } from "@/components/layout/Sidebar";
import { StudioCopilot } from "@/components/StudioCopilot";
import { StudioHome } from "@/components/StudioHome";
import { AiVideoStudio, type AiVideoStudioHandle } from "@/components/AiVideoStudio";
import { FindVideo } from "@/components/FindVideo";
import { Thumbnail } from "@/components/Thumbnail";
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
import {
  applyThemePreference,
  loadUserPreferences,
  subscribeToPreferenceChanges,
} from "@/lib/user-preferences";

type Mode = "home" | "download" | "clips" | "subtitles" | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps" | "upload" | "copilot" | "translator" | "findvideo" | "thumbnail" | "videostudio" | "help" | "activity" | "admin" | "settings";

export type AuthUser = {
  method?: "password" | "google";
  role?: "admin" | "user";
  email?: string;
  name?: string;
  picture?: string;
};

export type AuthFeatures = {
  googleAuthEnabled?: boolean;
  adminPanelEnabled?: boolean;
  translatorAllowed?: boolean;
  translatorLipSyncAllowed?: boolean;
  superAgentAllowed?: boolean;
};

type ClientAccessConfig = {
  downloadInputEnabled: boolean;
  telegram?: {
    url?: string;
    message?: string;
  };
};

const GUIDE_SEEN_KEY = "videomaking-guide-seen-v1";
const ACTIVE_MODE_KEY = "videomaking-active-mode-v1";
const CLIP_JOB_MISSING_GRACE_MS = 15 * 60 * 1000;
const NOTIFICATION_SOUND_URL = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/notification-agent.mp3`;
const MODE_LABELS: Record<Mode, string> = {
  home: "Home",
  download: "Download",
  clips: "Best Clips",
  subtitles: "Subtitles",
  clipcutter: "Clip Cutter",
  bhagwat: "Bhagwat Studio",
  scenefinder: "Find Sabha",
  timestamps: "Timestamps",
  upload: "Share",
  copilot: "Super Agent",
  translator: "Translator",
  findvideo: "Find Video",
  thumbnail: "Thumbnail",
  videostudio: "AI Video Studio",
  help: "Help",
  activity: "Activity",
  admin: "Admin",
  settings: "Settings",
};

const VALID_MODES = new Set<Mode>(Object.keys(MODE_LABELS) as Mode[]);
const MODE_PATHS: Record<Mode, string> = {
  home: "/",
  download: "/download",
  clips: "/best-clips",
  subtitles: "/subtitles",
  clipcutter: "/clip-cut",
  bhagwat: "/bhagwat",
  scenefinder: "/find-sabha",
  timestamps: "/timestamps",
  upload: "/share",
  copilot: "/super-agent",
  translator: "/translator",
  findvideo: "/find-video",
  thumbnail: "/thumbnail",
  videostudio: "/ai-studio",
  help: "/help",
  activity: "/activity",
  admin: "/admin",
  settings: "/settings",
};
const PATH_MODES = new Map<string, Mode>(
  Object.entries(MODE_PATHS).map(([mode, path]) => [path, mode as Mode]),
);
type RouteState = { mode: Mode; subKind?: string; subId?: string };

function normalizeMode(value: string | null | undefined): Mode | null {
  const clean = String(value || "").trim().toLowerCase();
  return VALID_MODES.has(clean as Mode) ? clean as Mode : null;
}

function readRouteFromUrl(): RouteState {
  if (typeof window === "undefined") return { mode: "home" };
  const cleanPath = window.location.pathname.replace(/\/+$/, "") || "/";
  const modeFromPath = PATH_MODES.get(cleanPath);
  if (modeFromPath) return { mode: modeFromPath };
  const pathParts = cleanPath.split("/").filter(Boolean);
  const firstPath = pathParts.length ? `/${pathParts[0]}` : "/";
  const baseMode = PATH_MODES.get(firstPath);
  if (baseMode) {
    return {
      mode: baseMode,
      subKind: pathParts[1] ? decodeURIComponent(pathParts[1]) : undefined,
      subId: pathParts[2] ? decodeURIComponent(pathParts[2]) : undefined,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const legacyMode = normalizeMode(params.get("tab") || params.get("mode"));
  return { mode: legacyMode ?? "home" };
}

function readModeFromUrl(): Mode | null {
  return readRouteFromUrl().mode;
}

function readInitialMode(): Mode {
  return readRouteFromUrl().mode;
}

function hasModeRestoreHint(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.pathname !== "/" || window.location.search.includes("tab=") || window.location.search.includes("mode=");
}

function persistMode(mode: Mode) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ACTIVE_MODE_KEY, mode); } catch { /* ignore */ }
  try {
    const url = new URL(window.location.href);
    const nextPath = MODE_PATHS[mode] ?? "/";
    const isExactPath = url.pathname === nextPath;
    const isNestedPath = nextPath !== "/" && url.pathname.startsWith(`${nextPath}/`);
    if ((isExactPath || isNestedPath) && !url.searchParams.has("tab") && !url.searchParams.has("mode")) return;
    url.pathname = nextPath;
    url.searchParams.delete("tab");
    url.searchParams.delete("mode");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch { /* ignore */ }
}

function replaceCurrentPath(path: string) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.pathname === path && !url.searchParams.has("tab") && !url.searchParams.has("mode")) return;
    url.pathname = path;
    url.searchParams.delete("tab");
    url.searchParams.delete("mode");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch { /* ignore */ }
}

function pushCurrentPath(path: string) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.pathname === path && !url.searchParams.has("tab") && !url.searchParams.has("mode")) return;
    url.pathname = path;
    url.searchParams.delete("tab");
    url.searchParams.delete("mode");
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch { /* ignore */ }
}


// GUIDE_TABS now lives in @/lib/guide-tabs and is imported above so the
// dedicated Help sidebar tab and any inline guide stay in sync.

function playSoftCompletionChime() {
  try {
    const audio = new Audio(NOTIFICATION_SOUND_URL);
    audio.volume = 0.65;
    void audio.play().catch(() => {
      playFallbackCompletionChime();
    });
    return;
  } catch {
    playFallbackCompletionChime();
  }
}

function playFallbackCompletionChime() {
  try {
    const AudioContextImpl =
      window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextImpl) return;
    const ctx = new AudioContextImpl();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.045, now + 0.018);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    master.connect(ctx.destination);

    for (const [index, freq] of [523.25, 659.25, 783.99].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + index * 0.075;
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.75, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.24);
    }
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    setTimeout(() => void ctx.close().catch(() => {}), 520);
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

export default function Home({
  authUser,
  authFeatures,
  onLogout,
}: {
  authUser?: AuthUser | null;
  authFeatures?: AuthFeatures | null;
  onLogout?: () => void;
}) {
  const [url, setUrl] = useState("");
  const [submittedUrl, setSubmittedUrl] = useState("");
  const bestClipsRef = useRef<BestClipsHandle>(null);
  const studioRef = useRef<AiVideoStudioHandle>(null);
  const initialRouteRef = useRef<RouteState>(readRouteFromUrl());
  const [jobId, setJobId] = useState<string | null>(
    initialRouteRef.current.mode === "download" && initialRouteRef.current.subKind === "job"
      ? initialRouteRef.current.subId ?? null
      : null,
  );
  const [activeFormatId, setActiveFormatId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => initialRouteRef.current.mode);
  const hadInitialModeRestoreHintRef = useRef(hasModeRestoreHint());
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
  const [preferences, setPreferences] = useState(loadUserPreferences);
  const seenCompletionRef = useRef<Set<string>>(new Set());
  const initializedCompletionsRef = useRef(false);
  const { toast } = useToast();

  useEffect(() => {
    persistMode(mode);
  }, [mode]);

  useEffect(() => {
    const onPopState = () => {
      const next = readRouteFromUrl();
      initialRouteRef.current = next;
      setMode(next.mode);
      if (next.mode === "download" && next.subKind === "job") {
        setJobId(next.subId ?? null);
      }
      if (next.mode === "videostudio") {
        if (next.subKind === "history") {
          studioRef.current?.openHistory(true);
        } else {
          studioRef.current?.closeHistory(true);
          if (next.subKind === "project" && next.subId) {
            studioRef.current?.openProject(next.subId, true);
          } else {
            studioRef.current?.clearProject();
          }
        }
      }
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onPopState);
    };
  }, []);

  useEffect(() => {
    if (mode !== "download") return;
    if (jobId) {
      replaceCurrentPath(`/download/job/${encodeURIComponent(jobId)}`);
    } else {
      replaceCurrentPath("/download");
    }
  }, [mode, jobId]);

  // Restore an active download job from localStorage on page load
  useEffect(() => {
    if (hadInitialModeRestoreHintRef.current) return;
    const saved = loadActiveDownload();
    if (saved) {
      setJobId(saved.jobId);
      if (saved.url) setUrl(saved.url);
      setMode("download");
    }
  }, []);

  useEffect(() => {
    try {
      if (hadInitialModeRestoreHintRef.current) return;
      const seen = localStorage.getItem(GUIDE_SEEN_KEY);
      if (!seen) {
        setHelpInitialMode("download");
        setMode("help");
        try { localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch { /* ignore */ }
      }
    } catch {
      if (hadInitialModeRestoreHintRef.current) return;
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
  const showFindVideo = mode === "findvideo";
  const showThumbnail = mode === "thumbnail";
  const showVideoStudio = mode === "videostudio";
  const showAdmin = mode === "admin";
  const showSettings = mode === "settings";
  const canUseAdmin = Boolean(authFeatures?.adminPanelEnabled && authUser?.role === "admin");
  const canUseTranslator = authFeatures?.translatorAllowed === true;
  const canUseSuperAgent = authFeatures?.superAgentAllowed === true;


  const buttonPlaceholder = "Start";
  const isSearchPending = getInfo.isPending;
  const showSearch = mode === "download";
  const isDownloadInputBlocked = false;

  useEffect(() => {
    const appName = "Narayan Bhakt Studio";
    const modeLabel = MODE_LABELS[mode] ?? "Narayan Bhakt";
    const contentLabel = video?.title?.trim() || submittedUrl.trim();
    document.title = contentLabel
      ? `${modeLabel}: ${contentLabel} | ${appName}`
      : `${modeLabel} | ${appName}`;
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
    applyThemePreference(preferences.theme);
  }, [preferences.theme]);

  useEffect(() => subscribeToPreferenceChanges(setPreferences), []);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return;
    const handler = () => {
      if (loadUserPreferences().theme === "system") {
        applyThemePreference("system");
      }
    };
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
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
    if (mode !== "help" && mode !== "activity" && mode !== "settings" && mode !== "home" && mode !== "copilot" && mode !== "translator" && mode !== "findvideo") {
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
          if (entry && preferences.notificationsEnabled) notifyBackgroundCompletion("Subtitles", entry.srtFilename);
        } else if (key.startsWith("clip:")) {
          const id = key.slice("clip:".length);
          const entry = loadClipHistoryForNotify().find((x) => x.jobId === id);
          if (entry && preferences.notificationsEnabled) notifyBackgroundCompletion("Clip cut", entry.label);
        } else if (key.startsWith("download:")) {
          const id = key.slice("download:".length);
          const entry = loadCompletedDownloadsForNotify().find((x) => x.jobId === id);
          if (entry && preferences.notificationsEnabled) notifyBackgroundCompletion("Download", entry.filename);
        } else if (key.startsWith("bestclips:")) {
          const id = key.slice("bestclips:".length);
          const entry = loadBestClipsHistoryForNotify().find((x) => x.id === id);
          if (entry && preferences.notificationsEnabled) notifyBackgroundCompletion("Best clips", `${entry.clipCount} clips ready`);
        } else if (key.startsWith("translator:")) {
          const id = key.slice("translator:".length);
          const entry = loadTranslatorHistoryForNotify().find((x) => x.jobId === id);
          if (entry && preferences.notificationsEnabled) notifyBackgroundCompletion("Translation", entry.filename);
        }

        if (preferences.notificationSoundEnabled) playSoftCompletionChime();
      }

      seenCompletionRef.current = snapshot;
    };

    sync();
    const timer = setInterval(sync, 4000);
    return () => clearInterval(timer);
  }, [preferences.notificationsEnabled, preferences.notificationSoundEnabled]);

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
    initialRouteRef.current = { mode: m };
    pushCurrentPath(MODE_PATHS[m] ?? "/");
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

      {/* Body: sidebar + content */}
      <div className="studio-body">

        {/* Sidebar */}
        <Sidebar
          mode={mode}
          onModeChange={switchMode}
          showAdmin={canUseAdmin}
          superAgentEnabled={canUseSuperAgent}
          translatorEnabled={canUseTranslator}
          onNewChat={() => {
            if (!canUseSuperAgent) return;
            setPendingCopilotPrompt(null);
            setCopilotResetKey(k => k + 1);
            switchMode("copilot");
          }}
        />

        {/* Main scrollable content */}
        <main className={cn("studio-content", (mode === "copilot" || mode === "translator" || mode === "findvideo" || mode === "thumbnail" || mode === "videostudio" || mode === "home" || mode === "help" || mode === "activity" || mode === "admin" || mode === "settings") && "overflow-hidden")} id="studio-content">
          <div className={cn("studio-content-inner", (mode === "copilot" || mode === "findvideo" || mode === "thumbnail" || mode === "videostudio" || mode === "home" || mode === "help" || mode === "activity" || mode === "admin" || mode === "settings") && "is-copilot", mode === "translator" && "is-copilot")}>
            {/* Translator tab - full screen */}
            {mode === "translator" && (
              canUseTranslator
                ? (
                  <VideoTranslator
                    lipSyncAvailable={Boolean(authFeatures?.translatorLipSyncAllowed)}
                    initialJobId={
                      initialRouteRef.current.mode === "translator" && initialRouteRef.current.subKind === "job"
                        ? initialRouteRef.current.subId ?? null
                        : null
                    }
                  />
                )
                : <FeatureUnavailable title="Translator is restricted" detail="Your account is not allowed to use video translation right now." />
            )}

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

            {showSettings && (
              <SettingsPanel
                authUser={authUser}
                authFeatures={authFeatures}
                onLogout={onLogout}
                onOpenAdmin={() => switchMode("admin")}
                onEnablePush={handleEnablePush}
                pushSupported={pushSupported}
                pushConfigured={pushConfigured}
                pushPermission={pushPermission}
                pushEnabling={pushEnabling}
                onTestSound={playSoftCompletionChime}
              />
            )}

            {showAdmin && canUseAdmin && <AdminPanel />}

            {/* Download tab — title, glowing input, blocked banner */}
            {showSearch && (
              <div className="flex flex-col gap-5 relative max-w-[720px] mx-auto w-full pt-8 sm:pt-14">
                <div className="mb-5 max-w-none sm:mb-6">
                  <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-[38px]">Download</h1>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-400 sm:text-base lg:text-[15px]">
                    Download any YouTube video in <strong className="font-semibold text-white/90">MP4, Audio, or 4K</strong> — just paste a link.
                  </p>
                </div>

                <form onSubmit={handleSearch} className="relative group w-full">
                  <style>{`
                    @keyframes downloadGlow {
                      0% { background-position: 0% 50%; }
                      15% { background-position: 20% 50%; }
                      35% { background-position: 80% 50%; }
                      50% { background-position: 100% 50%; }
                      65% { background-position: 80% 50%; }
                      85% { background-position: 20% 50%; }
                      100% { background-position: 0% 50%; }
                    }
                  `}</style>
                  <div
                    className="absolute -inset-[5.5px] rounded-[12px] opacity-50 blur-[12px] transition-all duration-500 group-hover:opacity-70 group-focus-within:opacity-90"
                    style={{
                      background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
                      backgroundSize: '300% 300%',
                      animation: 'downloadGlow 10s ease-in-out infinite',
                    }}
                  />
                  <div className="relative w-full rounded-[12px] p-[1.2px] overflow-hidden bg-zinc-800">
                    <div
                      className="absolute inset-0"
                      style={{
                        background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
                        backgroundSize: '300% 300%',
                        animation: 'downloadGlow 10s ease-in-out infinite',
                      }}
                    />
                    <div className="relative rounded-[11px] bg-[#09090b] py-3.5 px-5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
                      <div className="flex items-center gap-3">
                        <Search className="h-4.5 w-4.5 text-zinc-500 shrink-0" />
                        <input
                          type="url"
                          name="youtube_url"
                          inputMode="url"
                          autoComplete="off"
                          spellCheck={false}
                          aria-label="YouTube URL"
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (url.trim() && !isSearchPending && !isDownloadInputBlocked) {
                                handleSearch(e as unknown as React.FormEvent);
                              }
                            }
                          }}
                          placeholder={isDownloadInputBlocked ? "Download input is disabled" : "Paste YouTube URL..."}
                          disabled={isDownloadInputBlocked}
                          className="flex-1 bg-transparent text-sm leading-5 text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
                        />
                        <button
                          type="submit"
                          disabled={isSearchPending || !url.trim() || isDownloadInputBlocked}
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition"
                        >
                          {isSearchPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ArrowRight className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </form>

                {/* Download blocked banner */}
                {isDownloadInputBlocked && (
                  <div className="mt-6 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-4">
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

            {/* Content panels */}

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
                <motion.div key="subtitles-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full">
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
                  <Timestamps
                    initialJobId={
                      initialRouteRef.current.mode === "timestamps" && initialRouteRef.current.subKind === "job"
                        ? initialRouteRef.current.subId ?? null
                        : null
                    }
                  />
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
                    translatorEnabled={canUseTranslator}
                    onSwitchMode={(m) => switchMode(m as Mode)}
                    onLaunchAgent={(prompt) => {
                      if (!canUseSuperAgent) {
                        switchMode("copilot");
                        return;
                      }
                      setPendingCopilotPrompt(prompt);
                      switchMode("copilot");
                    }}
                  />
                </motion.div>
              )}

              {/* AI Copilot slot inside AnimatePresence removed — component is always
                  mounted below (outside AnimatePresence) so the SSE stream survives
                  tab navigation without being killed by React unmounting. */}

              {showFindVideo && (
                <motion.div key="findvideo-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full h-full flex-1 flex flex-col">
                  <FindVideo />
                </motion.div>
              )}

              {showThumbnail && (
                <motion.div key="thumbnail-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full h-full flex-1 flex flex-col">
                  <Thumbnail onBackToHome={() => switchMode("home")} />
                </motion.div>
              )}

              {showVideoStudio && (
                <motion.div key="video-studio-panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="w-full h-full flex-1 flex flex-col">
                  <AiVideoStudio
                    ref={studioRef}
                    initialHistoryOpen={
                      initialRouteRef.current.mode === "videostudio" && initialRouteRef.current.subKind === "history"
                    }
                    initialProjectId={
                      initialRouteRef.current.mode === "videostudio" && initialRouteRef.current.subKind === "project"
                        ? initialRouteRef.current.subId ?? null
                        : null
                    }
                  />
                </motion.div>
              )}

            </AnimatePresence>

            {/* Always-mounted copilot — lives outside AnimatePresence so it is never
                unmounted when the user navigates to another tab. The SSE stream keeps
                running in the background; display:none hides it without destroying it. */}
            <div style={{ display: showCopilot ? undefined : "none" }} className="w-full h-full flex-1 flex flex-col">
              {canUseSuperAgent ? (
                <StudioCopilot
                  key={copilotResetKey}
                  onNavigate={(tab) => switchMode(tab as any)}
                  pendingPrompt={pendingCopilotPrompt}
                  onPromptConsumed={() => setPendingCopilotPrompt(null)}
                  onBackToHome={() => switchMode("home")}
                />
              ) : (
                <FeatureUnavailable title="Super Agent is restricted" detail="Your account is not allowed to use Super Agent right now." />
              )}
            </div>

          </div>
        </main>
      </div>

    </div>
  );
}

// GuideModal has been replaced by HelpPanel (a full sidebar tab).
// Keep this stub so any older import sites compile; safe to delete later.

function FeatureUnavailable({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="activity-page">
      <div className="activity-page-inner">
        <div className="settings-card">
          <p className="text-xs uppercase tracking-[0.35em] text-white/35 font-semibold">Access</p>
          <h1 className="text-2xl md:text-3xl font-bold text-white mt-2">{title}</h1>
          <p className="text-sm text-white/45 mt-2">{detail}</p>
        </div>
      </div>
    </div>
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
              Fixing with AI...
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
          Downloading audio and running AI correction - this may take a minute...
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
          <span className="text-xs">Resolving stream...</span>
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
