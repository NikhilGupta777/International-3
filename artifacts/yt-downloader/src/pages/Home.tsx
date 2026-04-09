import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Youtube, Search, ArrowRight, Play, Clock, Eye, Film, Music,
  Download, Loader2, Sparkles, Captions, Scissors
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
import { GetSubtitles } from "@/components/GetSubtitles";
import { ClipCutter } from "@/components/ClipCutter";
import { GlobalHistoryPanel } from "@/components/GlobalHistoryPanel";
import { FloatingActivityPanel } from "@/components/FloatingActivityPanel";
import {
  saveActiveDownload,
  loadActiveDownload,
  clearActiveDownload,
} from "@/lib/download-history";

type Mode = "download" | "clips" | "subtitles" | "clipcutter";

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
        saveActiveDownload({ jobId: data.jobId, url, savedAt: Date.now() });
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
    if (!url.trim()) return;
    setSubmittedUrl(url.trim());
    if (mode === "download") {
      getInfo.mutate({ data: { url } });
    } else if (mode === "clips") {
      bestClipsRef.current?.startAnalyze();
    }
  };

  const handleDownload = (format: VideoFormat) => {
    setActiveFormatId(format.formatId);
    download.mutate({ 
      data: { 
        url, 
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

  const audioFormats = video?.formats?.filter(f => !f.hasVideo && f.hasAudio)?.sort((a, b) => {
    return (b.filesize || 0) - (a.filesize || 0);
  }) || [];

  const showVideoInfo = mode === "download" && video && !jobId;
  const showClips = mode === "clips" && submittedUrl;
  const showSubtitles = mode === "subtitles";
  const showClipCutter = mode === "clipcutter";

  const buttonPlaceholder = mode === "clips" ? "Analyze" : "Start";
  const isSearchPending = getInfo.isPending;
  const showSearch = mode !== "subtitles" && mode !== "clipcutter";

  return (
    <div className="min-h-screen relative overflow-x-hidden flex flex-col items-center pb-24 px-3 sm:px-6">
      
      {/* Premium Background */}
      <div className="fixed inset-0 z-[-1]">
        <img 
          src={`${import.meta.env.BASE_URL}images/dark-glow-bg.png`} 
          alt="Dark premium abstract background" 
          className="w-full h-full object-cover opacity-50 mix-blend-screen"
        />
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
            (showVideoInfo || showClips || showSubtitles || showClipCutter) ? "pt-12 mb-8" : "pt-[25vh]"
          )}
        >
          {/* Logo */}
          <motion.div layout className="flex items-center gap-2 sm:gap-3 mb-5 sm:mb-8">
            <div className="bg-primary/20 p-3 rounded-2xl border border-primary/30 shadow-[0_0_30px_rgba(229,9,20,0.3)]">
              <Youtube className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-3xl md:text-5xl font-display font-bold tracking-tight text-white">
              YT<span className="text-primary text-glow">Grabber</span>
            </h1>
          </motion.div>

          {!showVideoInfo && !showClips && (
            <motion.p layout className="text-white/60 text-lg mb-8 text-center max-w-lg">
              Download high-quality videos and audio, or let AI find the best clips from any YouTube video.
            </motion.p>
          )}

          {/* Mode Tabs */}
          <motion.div layout className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-2xl p-1 mb-6 w-full sm:w-auto">
            <button
              onClick={() => { setMode("download"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
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
                "flex-1 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
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
                "flex-1 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
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
                "flex-1 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "clipcutter"
                  ? "bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-[0_0_20px_rgba(249,115,22,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}
            >
              <Scissors className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Cut</span>
              <span className="hidden sm:inline">Clip Cut</span>
            </button>
          </motion.div>

          {/* Search Bar — hidden in Bhagwat mode */}
          <motion.form 
            layout 
            onSubmit={handleSearch}
            className={cn("w-full max-w-2xl relative group", !showSearch && "hidden")}
          >
            <div className="absolute -inset-1 bg-gradient-to-r from-primary/60 to-purple-600/60 rounded-2xl blur-lg opacity-30 group-hover:opacity-60 transition duration-500 pointer-events-none" />
            <div className="relative glass-panel rounded-2xl flex p-2 shadow-2xl items-center focus-within:border-primary/50 transition-colors">
              <Search className="w-6 h-6 text-white/40 ml-4 hidden sm:block" />
              <input 
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste YouTube URL..."
                className="bg-transparent flex-1 outline-none px-3 sm:px-4 py-3 text-white placeholder:text-white/30 text-base sm:text-lg min-w-0"
                autoFocus
              />
              <Button 
                type="submit" 
                size="lg"
                disabled={isSearchPending || !url.trim()}
                className="h-10 sm:h-12 px-4 sm:px-6 rounded-xl shrink-0 text-sm sm:text-base"
              >
                {isSearchPending ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin w-4 h-4 border-2 border-white/30 border-t-white rounded-full" />
                    <span className="hidden sm:inline">Fetching</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 sm:gap-2">
                    {buttonPlaceholder} <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
                  </span>
                )}
              </Button>
            </div>
          </motion.form>
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
                        {videoFormats.map((format, idx) => (
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

          </AnimatePresence>

          <GlobalHistoryPanel onSwitchTab={setMode} />

        </div>
      </main>

      <FloatingActivityPanel onSwitchTab={setMode} />
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
