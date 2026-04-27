import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Plus, Paperclip, AudioLines, ArrowUp,
  Scissors, Sparkles, Captions, Languages, AlarmClock,
  Download, ListVideo, Shield, UploadCloud, Bot, Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

type Mode =
  | "home" | "copilot" | "download" | "clips" | "subtitles"
  | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps"
  | "upload" | "translator";

type AgentTile = {
  key: string;
  label: string;
  icon: React.ReactNode;
  bg: string;
  ring?: string;
  badge?: { text: string; color: string };
  mode?: Mode;
};

const ULTRA_KEY = "studio-ultra-mode";

function readUltraInitial(): boolean {
  try { return localStorage.getItem(ULTRA_KEY) === "1"; } catch { return false; }
}

const AGENTS: AgentTile[] = [
  { key: "clips",       label: "Best Clips",  icon: <Sparkles className="w-5 h-5 text-white" />,    bg: "linear-gradient(135deg,#dc2626 0%,#7f1d1d 100%)", badge: { text: "AI",  color: "#dc2626" }, mode: "clips" },
  { key: "clipcutter",  label: "Clip Cut",    icon: <Scissors className="w-5 h-5 text-white" />,    bg: "linear-gradient(135deg,#475569,#1f2937)",                                                  mode: "clipcutter" },
  { key: "subtitles",   label: "Subtitles",   icon: <Captions className="w-5 h-5 text-white" />,    bg: "linear-gradient(135deg,#16a34a,#14532d)",                                                  mode: "subtitles" },
  { key: "translator",  label: "Translator",  icon: <Languages className="w-5 h-5 text-white" />,   bg: "linear-gradient(135deg,#2563eb,#1e3a8a)",         badge: { text: "GPU", color: "#2563eb" }, mode: "translator" },
  { key: "timestamps",  label: "Timestamps",  icon: <AlarmClock className="w-5 h-5 text-white" />,  bg: "linear-gradient(135deg,#f59e0b,#92400e)",         badge: { text: "AI",  color: "#f59e0b" }, mode: "timestamps" },
  { key: "download",    label: "Download",    icon: <Download className="w-5 h-5 text-white" />,    bg: "linear-gradient(135deg,#a855f7,#581c87)",                                                  mode: "download" },
  { key: "scenefinder", label: "Find Sabha",  icon: <ListVideo className="w-5 h-5 text-white" />,   bg: "linear-gradient(135deg,#0ea5e9,#0c4a6e)",                                                  mode: "scenefinder" },
  { key: "bhagwat",     label: "Bhagwat",     icon: <Shield className="w-5 h-5 text-white" />,      bg: "linear-gradient(135deg,#ec4899,#831843)",         badge: { text: "PRO", color: "#ec4899" }, mode: "bhagwat" },
  { key: "upload",      label: "Share",       icon: <UploadCloud className="w-5 h-5 text-white" />, bg: "linear-gradient(135deg,#14b8a6,#134e4a)",                                                  mode: "upload" },
  { key: "agent",       label: "Super Agent", icon: <Bot className="w-5 h-5 text-white" />,         bg: "linear-gradient(135deg,#0284c7,#082f49)",                                                  mode: "copilot" },
  { key: "all",         label: "All Agents",  icon: <Star className="w-5 h-5 text-white" />,        bg: "linear-gradient(135deg,#1f2937,#0f172a)", ring: "rgba(255,255,255,0.18)",                  mode: "copilot" },
];

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

  const speechSupported = typeof window !== "undefined" &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  useEffect(() => {
    try { localStorage.setItem(ULTRA_KEY, ultra ? "1" : "0"); } catch {}
  }, [ultra]);

  // Stop recognition if the component unmounts mid-listen.
  useEffect(() => () => { try { recognitionRef.current?.stop(); } catch {} }, []);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onLaunchAgent(t);
    setText("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const clearText = () => {
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.focus();
    }
  };

  const onAttach = () => {
    toast({
      title: "Attachments coming soon",
      description: "Tell us what you'd like to attach: image, audio, document, or YouTube URL.",
    });
  };

  const toggleVoice = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast({ title: "Voice input not supported", description: "Try Chrome, Edge, or Safari." });
      return;
    }
    if (listening) {
      try { recognitionRef.current?.stop(); } catch {}
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

  return (
    <div className="gs-home">
      <div className="gs-home-center">
        {/* Title */}
        <h1 className="gs-home-title">
          VideoMaking Studio Workspace 4.0
          <span className="gs-home-dot" aria-hidden="true" />
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
              <button
                type="button"
                className="gs-input-circle-btn"
                title="Clear text"
                aria-label="Clear input"
                onClick={clearText}
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                type="button"
                className="gs-input-circle-btn"
                title="Attach file (coming soon)"
                aria-label="Attach"
                onClick={onAttach}
              >
                <Paperclip className="w-4 h-4" />
              </button>
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
              {speechSupported && (
                <button
                  type="button"
                  className={cn("gs-pill-speak", listening && "gs-pill-speak-active")}
                  title={listening ? "Stop listening" : "Speak"}
                  aria-pressed={listening}
                  onClick={toggleVoice}
                >
                  <AudioLines className="w-3.5 h-3.5" />
                  <span>{listening ? "Listening…" : "Speak"}</span>
                </button>
              )}
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

        {/* Agent quick row */}
        <div className="gs-agents-row no-scrollbar">
          {AGENTS.map(a => (
            <motion.button
              key={a.key}
              whileHover={{ y: -3 }}
              whileTap={{ scale: 0.96 }}
              className="gs-agent"
              onClick={() => a.mode && onSwitchMode(a.mode)}
            >
              <span
                className={cn("gs-agent-circle", a.ring && "gs-agent-ring")}
                style={{ background: a.bg, ...(a.ring ? { boxShadow: `inset 0 0 0 1px ${a.ring}` } : null) }}
              >
                {a.icon}
              </span>
              <span className="gs-agent-label">{a.label}</span>
              {a.badge && (
                <span
                  className="gs-agent-badge"
                  style={{ background: a.badge.color }}
                >
                  {a.badge.text}
                </span>
              )}
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}
