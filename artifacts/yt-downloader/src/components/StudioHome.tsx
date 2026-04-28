import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Plus, AudioLines, ArrowUp, Loader2,
  Download, Sparkles, Captions, Scissors,
  ListVideo, AlarmClock, UploadCloud, Languages,
  Film, Paperclip, ImagePlus, Music2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

type Mode =
  | "home" | "copilot" | "download" | "clips" | "subtitles"
  | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps"
  | "upload" | "translator" | "help" | "activity";
const ULTRA_KEY = "studio-ultra-mode";

function readUltraInitial(): boolean {
  try { return localStorage.getItem(ULTRA_KEY) === "1"; } catch { return false; }
}


export function StudioHome({
  onSwitchMode,
  onLaunchAgent,
}: {
  onSwitchMode: (m: Mode) => void;
  onLaunchAgent: (prompt: string) => void;
}) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [ultra, setUltra] = useState<boolean>(readUltraInitial);
  const [listening, setListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<any>(null);

  // Speech recognition is available in Chrome/Edge/Safari on HTTPS or localhost.
  // Firefox and non-secure origins do NOT support the Web Speech API.
  const speechSupported = typeof window !== "undefined" &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  useEffect(() => {
    try { localStorage.setItem(ULTRA_KEY, ultra ? "1" : "0"); } catch { }
  }, [ultra]);

  // Stop recognition if the component unmounts mid-listen.
  useEffect(() => () => { try { recognitionRef.current?.stop(); } catch { } }, []);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onLaunchAgent(t);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast({ title: "Voice input not supported", description: "Try Chrome, Edge, or Safari." });
      return;
    }
    if (listening) {
      try { recognitionRef.current?.stop(); } catch { }
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let baseline = text;
    rec.onresult = (e: any) => {
      let chunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) chunk += e.results[i][0].transcript;
      const next = (baseline + (baseline && !baseline.endsWith(" ") ? " " : "") + chunk).trimStart();
      setText(next);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch { setListening(false); }
  };

  const canSend = text.trim().length > 0;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    if (!showPlusMenu) return;
    const handler = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPlusMenu]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Client-side guard: single-part upload limit is 50 MB
    const MAX_SINGLE_MB = 50;
    if (file.size > MAX_SINGLE_MB * 1024 * 1024) {
      toast({
        title: "File too large",
        description: `Attachments must be under ${MAX_SINGLE_MB} MB. Use the Share tab for larger files.`,
        variant: "destructive",
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    try {
      setUploading(true);
      const res = await fetch(`${BASE}/api/uploads/presign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          mimeType: file.type || "application/octet-stream",
          visibility: "public"
        })
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as any;
        throw new Error(errBody?.error ?? `Server error ${res.status}`);
      }
      const { fileId, uploadType, presignedUrl } = await res.json();

      if (uploadType === "single") {
        const putRes = await fetch(presignedUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" }
        });
        if (!putRes.ok) throw new Error(`S3 upload failed (${putRes.status})`);
      } else {
        // Should not reach here due to client-side guard above, but handle gracefully
        throw new Error(`File too large for quick attach (max ${MAX_SINGLE_MB} MB).`);
      }

      const compRes = await fetch(`${BASE}/api/uploads/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, parts: [] })
      });
      if (!compRes.ok) throw new Error("Could not finalize upload");
      const comp = await compRes.json();

      const newText = text + (text ? "\n" : "") + comp.shareUrl;
      setText(newText);
      toast({ title: "File attached ✓", description: `${file.name} added to your message.` });
    } catch (err: any) {
      toast({ title: "Attachment failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="gs-home">
      <div className="gs-home-center">
        {/* Title */}
        <h1 className="gs-home-title">
          <span className="gs-home-title-text">VideoMaking Studio Workspace 2.0</span>
        </h1>

        {/* Big input box */}
        <form
          className="gs-input-card"
          onSubmit={e => { e.preventDefault(); submit(); }}
        >
          <textarea
            ref={textareaRef}
            className="gs-input-textarea"
            placeholder="Ask anything, create anything"
            value={text}
            onChange={e => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
            }}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
          />

          <div className="gs-input-row">
            <div className="gs-input-row-left">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                onChange={handleFileUpload}
              />
              <div className="relative" ref={plusMenuRef}>
                <button
                  type="button"
                  className={cn("gs-input-circle-btn", showPlusMenu && "gs-input-circle-btn-active")}
                  title="More options"
                  aria-label="More options"
                  onClick={() => setShowPlusMenu(v => !v)}
                >
                  <Plus className="w-4 h-4" />
                </button>
                {showPlusMenu && (
                  <div className="gs-plus-menu">
                    <button
                      className="gs-plus-menu-item"
                      disabled={uploading}
                      onClick={() => { fileInputRef.current?.click(); setShowPlusMenu(false); }}
                    >
                      {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                      <span>Upload Files</span>
                    </button>
                    <button className="gs-plus-menu-item gs-plus-menu-item-soon" disabled>
                      <ImagePlus className="w-4 h-4" />
                      <span>Create Images</span>
                      <span className="gs-plus-menu-badge">Soon</span>
                    </button>
                    <button className="gs-plus-menu-item gs-plus-menu-item-soon" disabled>
                      <Music2 className="w-4 h-4" />
                      <span>Create Music</span>
                      <span className="gs-plus-menu-badge gs-plus-menu-badge-new">New</span>
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className={cn("gs-pill-ultra", ultra && "gs-pill-ultra-active")}
                title={ultra ? "Ultra mode ON — uses Pro model" : "Ultra mode OFF — uses default model"}
                aria-pressed={ultra}
                onClick={() => setUltra(u => !u)}
              >
                <span className="gs-pill-ultra-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M12 2 L14 9 L21 12 L14 15 L12 22 L10 15 L3 12 L10 9 Z" />
                  </svg>
                </span>
                Ultra
              </button>
            </div>
            <div className="gs-input-row-right">
              {/* Speak button: always shown; dimmed with tooltip when browser doesn't support Web Speech API */}
              <button
                type="button"
                className={cn(
                  "gs-pill-speak",
                  listening && "gs-pill-speak-active",
                  !speechSupported && "opacity-40 cursor-not-allowed",
                )}
                title={
                  !speechSupported
                    ? "Voice input requires Chrome, Edge, or Safari"
                    : listening ? "Stop listening" : "Speak"
                }
                aria-pressed={listening}
                aria-disabled={!speechSupported}
                onClick={toggleVoice}
              >
                <AudioLines className="w-3.5 h-3.5" />
                <span>{listening ? "Listening…" : "Speak"}</span>
              </button>
              <button
                type="submit"
                disabled={!canSend}
                className={cn("gs-send-btn", canSend ? "gs-send-active" : "gs-send-disabled")}
                title="Send"
                aria-label="Send"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            </div>
          </div>
        </form>

        {/* Tool bubbles — grid layout */}
        <div className="studio-home-grid mt-4">
          {([
            { icon: <Sparkles className="w-5 h-5" />, label: "Best Clips", desc: "AI highlights", mode: "clips", color: "text-yellow-400" },
            { icon: <Scissors className="w-5 h-5" />, label: "Clip Cutter", desc: "Trim any range", mode: "clipcutter", color: "text-orange-400" },
            { icon: <Captions className="w-5 h-5" />, label: "Subtitles", desc: "Auto + translate", mode: "subtitles", color: "text-blue-400" },
            { icon: <AlarmClock className="w-5 h-5" />, label: "Timestamps", desc: "Chapter markers", mode: "timestamps", color: "text-purple-400" },
            { icon: <Film className="w-5 h-5" />, label: "Translator", desc: "Dub any video", mode: "translator", color: "text-pink-400" },
            { icon: <ListVideo className="w-5 h-5" />, label: "Find Sabha", desc: "Search within videos", mode: "scenefinder", color: "text-sky-400" },
            { icon: <Download className="w-5 h-5" />, label: "Download", desc: "MP4, Audio, 4K", mode: "download", color: "text-red-400" },
            { icon: <UploadCloud className="w-5 h-5" />, label: "Share", desc: "Share files", mode: "upload", color: "text-cyan-400" },
          ] as Array<{ icon: React.ReactNode; label: string; desc: string; mode: string; color: string }>).map((tool) => (
            <button
              key={tool.mode}
              onClick={() => onSwitchMode(tool.mode as Mode)}
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
      </div>
    </div>
  );
}
