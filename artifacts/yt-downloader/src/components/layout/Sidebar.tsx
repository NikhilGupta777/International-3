import {
  Download, Sparkles, Captions, Scissors, Shield,
  ListVideo, AlarmClock, UploadCloud, Bot, Youtube,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Mode = "download" | "clips" | "subtitles" | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps" | "upload" | "copilot";

interface NavItem {
  mode: Mode;
  icon: React.ReactNode;
  label: string;
  badge?: string;
}

const NAV_ITEMS: NavItem[] = [
  { mode: "copilot",     icon: <Bot className="w-4 h-4 shrink-0" />,        label: "AI Copilot",   badge: "NEW" },
  { mode: "clips",       icon: <Sparkles className="w-4 h-4 shrink-0" />,   label: "Best Clips",   badge: "AI" },
  { mode: "download",    icon: <Download className="w-4 h-4 shrink-0" />,   label: "Download" },
  { mode: "subtitles",   icon: <Captions className="w-4 h-4 shrink-0" />,   label: "Subtitles" },
  { mode: "clipcutter",  icon: <Scissors className="w-4 h-4 shrink-0" />,   label: "Clip Cut" },
  { mode: "bhagwat",     icon: <Shield className="w-4 h-4 shrink-0" />,     label: "Bhagwat",      badge: "PRO" },
  { mode: "scenefinder", icon: <ListVideo className="w-4 h-4 shrink-0" />,  label: "Find Sabha",   badge: "AI" },
  { mode: "timestamps",  icon: <AlarmClock className="w-4 h-4 shrink-0" />, label: "Timestamps",   badge: "AI" },
  { mode: "upload",      icon: <UploadCloud className="w-4 h-4 shrink-0" />, label: "Share" },
];

export function Sidebar({
  mode,
  onModeChange,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  return (
    <nav className="studio-nav-rail" aria-label="Studio navigation">

      {/* Top logo mark — mirrors the topbar logo so it aligns perfectly */}
      <div className="flex items-center justify-center h-[44px] w-full shrink-0 border-b border-[#1a1a1e]">
        <div
          className="p-1.5 rounded-md"
          style={{ background: "rgba(185,28,28,0.15)", border: "1px solid rgba(185,28,28,0.25)" }}
        >
          <Youtube className="w-4 h-4 text-primary" />
        </div>
      </div>

      <div className="studio-nav-section flex-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.mode}
            onClick={() => onModeChange(item.mode)}
            className={cn("nav-item", mode === item.mode && "nav-item-active")}
            title={item.label}
            aria-label={item.label}
            aria-current={mode === item.mode ? "page" : undefined}
          >
            {item.icon}
            <span className="nav-item-label">{item.label}</span>
            {item.badge && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
      </div>

    </nav>
  );
}
