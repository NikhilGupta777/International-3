import { LogOut, Cog, History, Sparkles, ArrowLeftRight } from "lucide-react";
import type { PitajiTab } from "@/pages/PitajiHome";

interface Props {
  active: PitajiTab;
  onChange: (tab: PitajiTab) => void;
  username: string;
  onLogout: () => void;
  onSwitchWorkspace: () => void;
}

const TABS: Array<{ id: PitajiTab; label: string; icon: typeof Sparkles; hint: string }> = [
  { id: "live", label: "Live", icon: Sparkles, hint: "Analyze live-stream replay" },
  { id: "history", label: "History", icon: History, hint: "All processed clips" },
  { id: "settings", label: "Settings", icon: Cog, hint: "Thumbnail & analysis settings" },
];

export default function PitajiSidebar({ active, onChange, username, onLogout, onSwitchWorkspace }: Props) {
  return (
    <aside className="pj-sidebar" aria-label="Pita Ji navigation">
      <div className="pj-sidebar-brand">
        <span className="pj-sidebar-mark" aria-hidden>ॐ</span>
        <span className="pj-sidebar-brand-text">
          <span className="pj-sidebar-brand-eyebrow">Pita Ji</span>
          <span className="pj-sidebar-brand-name">Live Studio</span>
        </span>
      </div>

      <nav className="pj-sidebar-nav">
        {TABS.map(({ id, label, icon: Icon, hint }) => (
          <button
            key={id}
            type="button"
            className={`pj-sidebar-tab${active === id ? " is-active" : ""}`}
            onClick={() => onChange(id)}
            title={hint}
            aria-current={active === id ? "page" : undefined}
          >
            <Icon size={18} strokeWidth={2} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="pj-sidebar-footer">
        <div className="pj-sidebar-user">
          <div className="pj-sidebar-avatar" aria-hidden>{username.charAt(0).toUpperCase() || "P"}</div>
          <div className="pj-sidebar-user-meta">
            <span className="pj-sidebar-user-name">{username}</span>
            <span className="pj-sidebar-user-role">Operator</span>
          </div>
        </div>
        <div className="pj-sidebar-actions">
          <button
            type="button"
            className="pj-sidebar-action"
            onClick={onSwitchWorkspace}
            title="Switch to VideoMaking workspace"
          >
            <ArrowLeftRight size={15} strokeWidth={2} aria-hidden />
            <span>Switch workspace</span>
          </button>
          <button
            type="button"
            className="pj-sidebar-action pj-sidebar-action--danger"
            onClick={onLogout}
            title="Sign out of Pita Ji"
          >
            <LogOut size={15} strokeWidth={2} aria-hidden />
            <span>Sign out</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
