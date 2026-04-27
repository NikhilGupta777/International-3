import { useState } from "react";
import { motion } from "framer-motion";
import {
  Plus, Paperclip, Mic, AudioLines,
  Scissors, Sparkles, Captions, Languages, AlarmClock,
  Download, ListVideo, Shield, UploadCloud, Bot, Star,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Mode =
  | "home" | "copilot" | "download" | "clips" | "subtitles"
  | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps"
  | "upload" | "translator";

type AgentTile = {
  key: string;
  label: string;
  icon: React.ReactNode;
  bg: string;       // background gradient/color for the circle
  ring?: string;    // optional outer ring color
  badge?: { text: string; color: string };
  mode?: Mode;      // tab to switch to on click
};

const AGENTS: AgentTile[] = [
  {
    key: "clips",
    label: "Best Clips",
    icon: <Sparkles className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#dc2626 0%,#7f1d1d 100%)",
    badge: { text: "AI", color: "#dc2626" },
    mode: "clips",
  },
  {
    key: "clipcutter",
    label: "Clip Cut",
    icon: <Scissors className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#475569,#1f2937)",
    mode: "clipcutter",
  },
  {
    key: "subtitles",
    label: "Subtitles",
    icon: <Captions className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#16a34a,#14532d)",
    mode: "subtitles",
  },
  {
    key: "translator",
    label: "Translator",
    icon: <Languages className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#2563eb,#1e3a8a)",
    badge: { text: "GPU", color: "#2563eb" },
    mode: "translator",
  },
  {
    key: "timestamps",
    label: "Timestamps",
    icon: <AlarmClock className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#f59e0b,#92400e)",
    badge: { text: "AI", color: "#f59e0b" },
    mode: "timestamps",
  },
  {
    key: "download",
    label: "Download",
    icon: <Download className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#a855f7,#581c87)",
    mode: "download",
  },
  {
    key: "scenefinder",
    label: "Find Sabha",
    icon: <ListVideo className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#0ea5e9,#0c4a6e)",
    mode: "scenefinder",
  },
  {
    key: "bhagwat",
    label: "Bhagwat",
    icon: <Shield className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#ec4899,#831843)",
    badge: { text: "PRO", color: "#ec4899" },
    mode: "bhagwat",
  },
  {
    key: "upload",
    label: "Share",
    icon: <UploadCloud className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#14b8a6,#134e4a)",
    mode: "upload",
  },
  {
    key: "agent",
    label: "Super Agent",
    icon: <Bot className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#0284c7,#082f49)",
    mode: "copilot",
  },
  {
    key: "all",
    label: "All Agents",
    icon: <Star className="w-5 h-5 text-white" />,
    bg: "linear-gradient(135deg,#1f2937,#0f172a)",
    ring: "rgba(255,255,255,0.18)",
    mode: "copilot",
  },
];

export function StudioHome({
  onSwitchMode,
  onLaunchAgent,
}: {
  onSwitchMode: (m: Mode) => void;
  onLaunchAgent: (prompt: string) => void;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onLaunchAgent(t);
    setText("");
  };

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
              <button type="button" className="gs-input-circle-btn" title="Add">
                <Plus className="w-4 h-4" />
              </button>
              <button type="button" className="gs-input-circle-btn" title="Attach">
                <Paperclip className="w-4 h-4" />
              </button>
              <button type="button" className="gs-pill-ultra" title="Ultra mode">
                <span className="gs-pill-ultra-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M12 2 L14 9 L21 12 L14 15 L12 22 L10 15 L3 12 L10 9 Z" />
                  </svg>
                </span>
                Ultra
              </button>
            </div>
            <div className="gs-input-row-right">
              <button type="button" className="gs-input-circle-btn" title="Voice">
                <Mic className="w-4 h-4" />
              </button>
              <button type="button" className="gs-pill-speak" title="Speak">
                <AudioLines className="w-3.5 h-3.5" />
                <span>Speak</span>
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
