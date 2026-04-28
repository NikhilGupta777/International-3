import { useState } from "react";
import {
  Download, Sparkles, Captions, Scissors, Shield,
  ListVideo, AlarmClock, UploadCloud, Languages, Youtube, Menu, X,
  Plus, Home as HomeIcon, CircleHelp, Activity, UserCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Mode =
  | "home" | "copilot" | "download" | "clips" | "subtitles"
  | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps"
  | "upload" | "translator" | "help" | "activity";

interface NavItem {
  mode: Mode;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  tone?: "default" | "accent";
}

// Top "Super Agent" item — special, always pinned above the main list
const SUPER_AGENT_ITEM: NavItem = {
  mode: "copilot",
  icon: (
    <img src="/agent-logo.png" alt="" className="w-5 h-5 object-contain" aria-hidden="true" />
  ),
  label: "Super Agent",
  tone: "accent",
};

const NAV_ITEMS: NavItem[] = [
  { mode: "home",        icon: <HomeIcon className="gs-icon" />,        label: "Home" },
  SUPER_AGENT_ITEM,
  { mode: "clips",       icon: <Sparkles className="gs-icon" />,        label: "Best Clips" },
  { mode: "clipcutter",  icon: <Scissors className="gs-icon" />,        label: "Clip Cut" },
  { mode: "subtitles",   icon: <Captions className="gs-icon" />,        label: "Subtitles" },
  { mode: "translator",  icon: <Languages className="gs-icon" />,       label: "Translator" },
  { mode: "timestamps",  icon: <AlarmClock className="gs-icon" />,      label: "Timestamps" },
  { mode: "download",    icon: <Download className="gs-icon" />,        label: "Download" },
  { mode: "scenefinder", icon: <ListVideo className="gs-icon" />,       label: "Find Sabha" },
  { mode: "bhagwat",     icon: <Shield className="gs-icon" />,          label: "Bhagwat" },
  { mode: "upload",      icon: <UploadCloud className="gs-icon" />,     label: "Share" },
];

// Utility nav (Help / Activity) — pinned below the main list, separated by a divider.
const UTILITY_ITEMS: NavItem[] = [
  { mode: "activity",    icon: <Activity className="gs-icon" />,        label: "Activity" },
  { mode: "help",        icon: <CircleHelp className="gs-icon" />,      label: "Help" },
];

function GsItem({
  item,
  active,
  onClick,
  className,
}: {
  item: { icon: React.ReactNode; label: string; badge?: string; tone?: "default" | "accent" };
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "gs-nav-item",
        active && "gs-nav-item-active",
        item.tone === "accent" && "gs-nav-item-accent",
        className,
      )}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
    >
      <span className="gs-nav-icon-wrap">
        {item.icon}
        {item.badge && <span className="gs-nav-badge">{item.badge}</span>}
      </span>
      <span className="gs-nav-label">{item.label}</span>
    </button>
  );
}

function NavList({
  mode,
  onModeChange,
  onClose,
  onNewChat,
  hideUtility,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onClose?: () => void;
  onNewChat?: () => void;
  hideUtility?: boolean;
}) {
  const handle = (m: Mode) => () => { onModeChange(m); onClose?.(); };
  const handleNew = () => { onNewChat?.(); onClose?.(); };

  return (
    <>
      {/* Main nav */}
      {NAV_ITEMS.map((item) => (
        <GsItem
          key={item.mode}
          item={item}
          active={mode === item.mode}
          onClick={handle(item.mode)}
        />
      ))}

      {/* Utility nav: Activity + Help */}
      {!hideUtility && (
        <>
          <div className="gs-nav-divider" />
          {UTILITY_ITEMS.map((item) => (
            <GsItem
              key={item.mode}
              item={item}
              active={mode === item.mode}
              onClick={handle(item.mode)}
            />
          ))}
        </>
      )}
    </>
  );
}

export function Sidebar({
  mode,
  onModeChange,
  onNewChat,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onNewChat?: () => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleDrawer = () => setDrawerOpen(o => !o);
  const closeDrawer  = () => setDrawerOpen(false);

  return (
    <>
      {/* Desktop rail */}
      <nav className="gs-rail" aria-label="Studio navigation">
        {/* Profile / app tile */}
        <div className="gs-rail-top">
          <div
            className="gs-app-tile"
            title="VideoMaking Studio"
            aria-label="VideoMaking Studio"
          >
            <img src="/app-logo.png" alt="App Logo" className="w-6 h-6 object-contain" />
          </div>
        </div>

        <div className="gs-rail-list">
          <NavList
            mode={mode}
            onModeChange={onModeChange}
            onNewChat={onNewChat}
            hideUtility={true}
          />
        </div>

        {/* Bottom pinned utility items */}
        <div className="gs-rail-foot">
          {UTILITY_ITEMS.map((item) => (
            <GsItem
              key={item.mode}
              item={item}
              active={mode === item.mode}
              onClick={() => onModeChange(item.mode)}
            />
          ))}
        </div>
      </nav>

      {/* Mobile hamburger */}
      <button
        className="studio-hamburger"
        onClick={toggleDrawer}
        aria-label="Open navigation"
      >
        <Menu className="w-5 h-5" />
      </button>

      {drawerOpen && (
        <div className="studio-drawer-backdrop" onClick={closeDrawer} aria-hidden="true" />
      )}

      <div className={cn("gs-drawer", drawerOpen && "gs-drawer-open")}>
        <div className="gs-drawer-header">
          <div className="flex items-center gap-2">
            <div className="gs-app-tile">
              <img src="/app-logo.png" alt="App Logo" className="w-5 h-5 object-contain" />
            </div>
            <span className="text-sm font-semibold text-white/90">
              VideoMaking <span className="text-primary">Studio</span>
            </span>
          </div>
          <button
            onClick={closeDrawer}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/8 transition-colors"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="gs-drawer-list">
          <NavList
            mode={mode}
            onModeChange={onModeChange}
            onClose={closeDrawer}
            onNewChat={onNewChat}
            hideUtility={true}
          />
        </div>

        <div className="gs-drawer-foot">
          {UTILITY_ITEMS.map((item) => (
            <GsItem
              key={item.mode}
              item={item}
              active={mode === item.mode}
              onClick={() => {
                onModeChange(item.mode);
                closeDrawer();
              }}
            />
          ))}
        </div>
      </div>
    </>
  );
}
