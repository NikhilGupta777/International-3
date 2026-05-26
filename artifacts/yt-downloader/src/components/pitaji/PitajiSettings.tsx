// Phase 1: read-only view of the persisted settings (defaults until anything
// is saved). Phase 5 wires up upload / save / delete flows.

import { useEffect, useState } from "react";
import { Cog, Image as ImageIcon, Users } from "lucide-react";
import { getPitajiSettings, type PitajiSettings as PitajiSettingsT } from "@/lib/pitaji-api";

export default function PitajiSettings() {
  const [settings, setSettings] = useState<PitajiSettingsT | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await getPitajiSettings();
        if (mounted) setSettings(s);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : "Could not load settings");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <section className="pj-settings">
      <header className="pj-settings-header">
        <div>
          <p className="pj-eyebrow">Workspace</p>
          <h1 className="pj-h1">
            <Cog size={22} strokeWidth={2} aria-hidden /> Settings
          </h1>
          <p className="pj-settings-subtitle">
            These settings drive the analysis prompt and the thumbnail agent. Editor lands in the next phase —
            for now you can confirm the workspace can read the persisted values.
          </p>
        </div>
      </header>

      {error ? <div className="pj-alert">{error}</div> : null}

      <div className="pj-settings-grid">
        <article className="pj-settings-card">
          <h3>Master thumbnail prompt</h3>
          <p className="pj-settings-help">
            One prompt used for every clip&apos;s thumbnail. Speaker face and reference style images are added automatically.
          </p>
          <pre className="pj-settings-pre">
            {loading ? "Loading…" : settings?.thumbnailPrompt?.trim() || "(not set yet)"}
          </pre>
        </article>

        <article className="pj-settings-card">
          <h3>Per-clip analysis instructions</h3>
          <p className="pj-settings-help">
            Optional extra guidance appended to the analysis prompt — e.g. to emphasise certain topics.
          </p>
          <pre className="pj-settings-pre">
            {loading ? "Loading…" : settings?.clipInstructions?.trim() || "(not set yet)"}
          </pre>
        </article>

        <article className="pj-settings-card">
          <h3>
            <Users size={16} strokeWidth={2} aria-hidden /> Speaker images
          </h3>
          <p className="pj-settings-help">Up to 5 portraits the thumbnail agent can choose from.</p>
          <p className="pj-settings-count">{settings?.speakers?.length ?? 0} / 5 uploaded</p>
        </article>

        <article className="pj-settings-card">
          <h3>
            <ImageIcon size={16} strokeWidth={2} aria-hidden /> Reference thumbnails
          </h3>
          <p className="pj-settings-help">Up to 10 reference designs the thumbnail agent can match the style of.</p>
          <p className="pj-settings-count">{settings?.references?.length ?? 0} / 10 uploaded</p>
        </article>
      </div>
    </section>
  );
}
