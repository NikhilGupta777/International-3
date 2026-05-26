import { useState } from "react";
import PitajiSidebar from "@/components/pitaji/PitajiSidebar";
import PitajiLiveAgent from "@/components/pitaji/PitajiLiveAgent";
import PitajiHistory from "@/components/pitaji/PitajiHistory";
import PitajiSettings from "@/components/pitaji/PitajiSettings";

export type PitajiTab = "live" | "history" | "settings";

interface Props {
  username: string;
  onLogout: () => void;
  onSwitchWorkspace: () => void;
}

/**
 * Outer shell for the Pita Ji workspace.
 *
 * The shell intentionally does NOT reuse the VideoMaking sidebar / chrome —
 * the workspace is themed independently and only ever shows three tabs:
 * Live, History, Settings. New tabs (intro/outro/logo) can be added later
 * by appending to PitajiTab and PitajiSidebar.
 */
export default function PitajiHome({ username, onLogout, onSwitchWorkspace }: Props) {
  const [tab, setTab] = useState<PitajiTab>("live");

  return (
    <div className="pj-shell">
      <PitajiSidebar
        active={tab}
        onChange={setTab}
        username={username}
        onLogout={onLogout}
        onSwitchWorkspace={onSwitchWorkspace}
      />
      <main className="pj-main">
        {tab === "live" ? <PitajiLiveAgent /> : null}
        {tab === "history" ? <PitajiHistory /> : null}
        {tab === "settings" ? <PitajiSettings /> : null}
      </main>
    </div>
  );
}
