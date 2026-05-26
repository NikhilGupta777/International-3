// Phase 1 stub — the chat/clips UI lands in Phase 2. Renders the empty state
// + URL input shell so the workspace looks complete from day one.

import { Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";

export default function PitajiLiveAgent() {
  const [url, setUrl] = useState("");

  return (
    <section className="pj-live">
      <header className="pj-live-header">
        <div className="pj-live-header-text">
          <p className="pj-live-eyebrow">Live agent</p>
          <h1 className="pj-live-title">Drop a finished live-stream URL</h1>
          <p className="pj-live-subtitle">
            The agent will watch the full recording, identify every broadcast-worthy topic and Q&amp;A,
            and queue them for cutting plus thumbnail generation in the background.
          </p>
        </div>
      </header>

      <form
        className="pj-live-form"
        onSubmit={(e) => {
          e.preventDefault();
          // Phase 2 wires this to /api/pitaji/analyze SSE.
          alert("Live analysis ships in the next phase. URL captured: " + url);
        }}
      >
        <div className="pj-live-input">
          <Sparkles size={16} strokeWidth={2} className="pj-live-input-icon" aria-hidden />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste any YouTube live, watch, or share URL (e.g. youtu.be/…, /live/…)"
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" disabled={!url.trim()} className="pj-live-submit">
            <Wand2 size={15} strokeWidth={2} aria-hidden />
            <span>Analyze</span>
          </button>
        </div>
        <p className="pj-live-hint">
          Any YouTube URL form is accepted — it&apos;s normalized to <code>watch?v=</code> automatically.
        </p>
      </form>

      <div className="pj-live-empty">
        <div className="pj-live-empty-card">
          <p className="pj-live-empty-eyebrow">What happens next</p>
          <ol className="pj-live-empty-steps">
            <li>
              <strong>Watch.</strong> Short videos (≤40 min) are analyzed directly via Gemini&apos;s YouTube
              connection. Longer videos have their audio split into 2 or 3 chunks and analyzed via Vertex AI.
            </li>
            <li>
              <strong>Review.</strong> Every topic and Q&amp;A clip streams in with start/end times, a summary,
              suggested title, description, hashtags, and a pinned comment.
            </li>
            <li>
              <strong>Pick &amp; ship.</strong> Tick the clips you want, optionally adjust start/end, then click
              Cut, Thumbnail, or Both. Background workers do the rest. History keeps every result.
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
