import { useEffect, useRef, useState } from "react";
import {
  Download, Sparkles, Captions, Scissors, Shield,
  AlarmClock, UploadCloud, Search, Menu, X,
  Home as HomeIcon, Activity, Settings, Clapperboard,
  Terminal, Newspaper,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Mode =
  | "home" | "copilot" | "download" | "clips" | "subtitles"
  | "clipcutter" | "bhagwat" | "scenefinder" | "timestamps"
  | "upload" | "translator" | "heygen" | "findvideo" | "thumbnail" | "content-manager" | "videostudio" | "help" | "activity" | "admin" | "developer" | "api-docs" | "settings";

interface NavItem {
  mode: Mode;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  tone?: "default" | "accent";
}

// Footer (utility) items shared by the rail, drawer, and NavList. Built from the
// caller's permissions so Admin / Developer only appear when granted.
function buildFootItems(opts: { showAdmin?: boolean; showDeveloper?: boolean }): NavItem[] {
  const items: NavItem[] = [];
  if (opts.showAdmin) {
    items.push({ mode: "admin", icon: <Settings className="gs-icon" />, label: "Admin" });
  }
  if (opts.showDeveloper) {
    items.push({ mode: "developer", icon: <Terminal className="gs-icon" />, label: "Developer" });
  }
  items.push({ mode: "activity", icon: <Activity className="gs-icon" />, label: "Activity" });
  items.push({ mode: "settings", icon: <Settings className="gs-icon" />, label: "Settings" });
  return items;
}

// Top "Super Agent" item: special, always pinned above the main list
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
  { mode: "content-manager", icon: <Newspaper className="gs-icon" />,    label: "Content", badge: "New" },
  { mode: "findvideo",   icon: <Search className="gs-icon" />,          label: "Find Video", badge: "New" },
  { mode: "clipcutter",  icon: <Scissors className="gs-icon" />,        label: "Clip Cut" },
  { mode: "subtitles",   icon: <Captions className="gs-icon" />,        label: "Subtitles" },
  { mode: "timestamps",  icon: <AlarmClock className="gs-icon" />,      label: "Timestamps" },
  { mode: "videostudio", icon: <Clapperboard className="gs-icon" />,    label: "AI Studio" },
  { mode: "clips",       icon: <Sparkles className="gs-icon" />,        label: "Best Clips" },
  // { mode: "thumbnail",   icon: <ImageIcon className="gs-icon" />,       label: "Thumbnail" },
  { mode: "download",    icon: <Download className="gs-icon" />,        label: "Download" },
  // { mode: "scenefinder", icon: <ListVideo className="gs-icon" />,       label: "Find Sabha" },
  { mode: "bhagwat",     icon: <Shield className="gs-icon" />,          label: "Bhagwat" },
  { mode: "upload",      icon: <UploadCloud className="gs-icon" />,     label: "Share" },
];

// Utility nav (Activity / Settings) - pinned below the main list.
const UTILITY_ITEMS: NavItem[] = [
  { mode: "activity",    icon: <Activity className="gs-icon" />,        label: "Activity" },
  { mode: "settings",    icon: <Settings className="gs-icon" />,        label: "Settings" },
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
  showAdmin,
  showDeveloper,
  superAgentEnabled = true,
  translatorEnabled = true,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onClose?: () => void;
  onNewChat?: () => void;
  hideUtility?: boolean;
  showAdmin?: boolean;
  showDeveloper?: boolean;
  superAgentEnabled?: boolean;
  translatorEnabled?: boolean;
}) {
  const handle = (m: Mode) => () => { onModeChange(m); onClose?.(); };
  const handleNew = () => { onNewChat?.(); onClose?.(); };
  const utilityItems = buildFootItems({ showAdmin, showDeveloper });

  return (
    <>
      {/* Main nav */}
      {NAV_ITEMS.filter((item) => {
        if (item.mode === "copilot" && !superAgentEnabled) return false;
        if ((item.mode === "translator" || item.mode === "heygen") && !translatorEnabled) return false;
        return true;
      }).map((item) => (
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
          {utilityItems.map((item) => (
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
  showAdmin = false,
  showDeveloper = false,
  superAgentEnabled = true,
  translatorEnabled = true,
}: {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  onNewChat?: () => void;
  showAdmin?: boolean;
  showDeveloper?: boolean;
  superAgentEnabled?: boolean;
  translatorEnabled?: boolean;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const toggleDrawer = () => setDrawerOpen(open => !open);
  const closeDrawer = () => {
    setDrawerOpen(false);
    requestAnimationFrame(() => hamburgerRef.current?.focus());
  };

  useEffect(() => {
    if (!drawerOpen) return;
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  return (
    <>
      {/* Desktop rail */}
      <nav className="gs-rail" aria-label="Studio navigation">
        {/* Profile / app tile */}
        <div className="gs-rail-top">
          <div
            className="gs-app-tile"
            title="Narayan Bhakt Studio"
            aria-label="Narayan Bhakt Studio"
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
            showAdmin={showAdmin}
            showDeveloper={showDeveloper}
            superAgentEnabled={superAgentEnabled}
            translatorEnabled={translatorEnabled}

          />
        </div>

        {/* Bottom pinned utility items */}
        <div className="gs-rail-foot">
          {buildFootItems({ showAdmin, showDeveloper }).map((item) => (
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
        ref={hamburgerRef}
        className={cn("studio-hamburger", mode === "heygen" && "studio-hamburger-heygen")}
        onClick={toggleDrawer}
        aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={drawerOpen}
        aria-controls="studio-mobile-navigation"
      >
        <Menu className="w-5 h-5" />
      </button>

      {drawerOpen && (
        <div className="studio-drawer-backdrop cursor-pointer" onClick={closeDrawer} aria-hidden="true" />
      )}

      {drawerOpen && <nav
        id="studio-mobile-navigation"
        className="gs-drawer gs-drawer-open"
        aria-label="Mobile studio navigation"
        onKeyDown={(event) => {
          if (event.key === "Escape") closeDrawer();
        }}
      >
        <div className="gs-drawer-header">
          <div className="flex items-center gap-2">
            <div className="gs-app-tile">
              <img src="/app-logo.png" alt="App Logo" className="w-5 h-5 object-contain" />
            </div>
            <span className="text-sm font-semibold text-white/90">
              Narayan Bhakt <span className="text-primary">Studio</span>
            </span>
          </div>
          <button
            ref={closeButtonRef}
            onClick={closeDrawer}
            className="studio-drawer-close rounded-lg text-white/60 hover:text-white hover:bg-white/8 transition-colors"
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
            showAdmin={showAdmin}
            showDeveloper={showDeveloper}
            superAgentEnabled={superAgentEnabled}
            translatorEnabled={translatorEnabled}

          />
        </div>

        <div className="gs-drawer-foot">
          {buildFootItems({ showAdmin, showDeveloper }).map((item) => (
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
      </nav>}
    </>
  );
}
