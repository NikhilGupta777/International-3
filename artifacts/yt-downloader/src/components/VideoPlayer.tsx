import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Loader2, AlertCircle } from "lucide-react";

interface VideoPlayerProps {
  url: string;
  formatId?: string;
  title?: string;
  onClose: () => void;
}

export function VideoPlayer({ url, formatId, title, onClose }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const streamUrl =
    `${BASE}/api/youtube/stream?url=${encodeURIComponent(url)}` +
    (formatId ? `&formatId=${encodeURIComponent(formatId)}` : "");

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4"
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={{ scale: 0.92, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.92, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="relative w-full max-w-5xl"
        >
          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute -top-10 right-0 text-white/60 hover:text-white transition-colors flex items-center gap-1.5 text-sm"
          >
            <X className="w-4 h-4" /> Close
          </button>

          {/* Title */}
          {title && (
            <p className="text-white/80 text-sm font-medium mb-2 truncate px-1">{title}</p>
          )}

          {/* Video container */}
          <div className="relative aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-white/10">
            {loading && !error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/50">
                <Loader2 className="w-10 h-10 animate-spin" />
                <p className="text-sm">Resolving stream&hellip;</p>
                <p className="text-xs text-white/30">This may take a few seconds</p>
              </div>
            )}

            {error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/60 p-8 text-center">
                <AlertCircle className="w-10 h-10 text-red-400" />
                <p className="font-semibold text-white">Playback unavailable</p>
                <p className="text-sm text-white/50">{error}</p>
                <p className="text-xs text-white/30">Try downloading the video instead.</p>
              </div>
            )}

            <video
              ref={videoRef}
              src={streamUrl}
              controls
              autoPlay
              className="w-full h-full"
              style={{ display: error ? "none" : "block" }}
              onCanPlay={() => setLoading(false)}
              onLoadedData={() => setLoading(false)}
              onWaiting={() => setLoading(true)}
              onPlaying={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setError("Could not load this format in the browser. This usually happens with high-resolution formats that need merging.");
              }}
            />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
