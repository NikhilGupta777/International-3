import { useState } from "react";
import {
  Download, Sparkles, Captions, Scissors, Shield,
  ListVideo, AlarmClock, UploadCloud, Bot, Youtube, Menu, X,
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

// ── Desktop sidebar nav list ────────────────────────────────────────────────
function NavList({
  mode,
  onModeChange,
  onClose,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onClose?: () => void;
}) {
  return (
    <div className="studio-nav-section flex-1">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.mode}
          onClick={() => {
            onModeChange(item.mode);
            onClose?.();
          }}
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
  );
}

export function Sidebar({
  mode,
  onModeChange,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleDrawer = () => setDrawerOpen(o => !o);
  const closeDrawer  = () => setDrawerOpen(false);

  return (
    <>
      {/* ── Desktop sidebar (always visible ≥ md) ── */}
      <nav className="studio-nav-rail" aria-label="Studio navigation">
        {/* Top logo mark */}
        <div className="flex items-center justify-center h-[44px] w-full shrink-0 border-b border-[#1a1a1e]">
          <div
            className="p-1.5 rounded-md"
            style={{ background: "rgba(185,28,28,0.15)", border: "1px solid rgba(185,28,28,0.25)" }}
          >
            <Youtube className="w-4 h-4 text-primary" />
          </div>
        </div>

        <NavList mode={mode} onModeChange={onModeChange} />
      </nav>

      {/* ── Mobile hamburger button in topbar (injected via portal-less fixed btn) ── */}
      <button
        className="studio-hamburger"
        onClick={toggleDrawer}
        aria-label="Open navigation"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* ── Mobile drawer backdrop ── */}
      {drawerOpen && (
        <div
          className="studio-drawer-backdrop"
          onClick={closeDrawer}
          aria-hidden="true"
        />
      )}

      {/* ── Mobile drawer ── */}
      <div className={cn("studio-drawer", drawerOpen && "studio-drawer-open")}>
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 h-[52px] border-b border-[#1a1a1e] shrink-0">
          <div className="flex items-center gap-2">
            <div
              className="p-1.5 rounded-md"
              style={{ background: "rgba(185,28,28,0.15)", border: "1px solid rgba(185,28,28,0.25)" }}
            >
              <Youtube className="w-4 h-4 text-primary" />
            </div>
            <span className="text-sm font-semibold text-white/90">VideoMaking <span className="text-primary">Studio</span></span>
          </div>
          <button
            onClick={closeDrawer}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drawer nav items */}
        <div className="flex-1 overflow-y-auto py-2">
          <NavList mode={mode} onModeChange={onModeChange} onClose={closeDrawer} />
        </div>
      </div>
    </>
  );
}
