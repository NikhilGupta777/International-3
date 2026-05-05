import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

const EMBED_URL = "https://kalkiram.com";

export function FindVideo() {
  const [key, setKey] = useState(0);

  return (
    <div className="flex flex-col" style={{ height: "100%", minHeight: 0 }}>
      {/* Thin top bar — reload + open-in-tab, stays out of the way */}
      <div
        className="flex items-center justify-end gap-2 px-3 py-1.5 shrink-0"
        style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <button
          onClick={() => setKey((k) => k + 1)}
          title="Reload"
          className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <a
          href={EMBED_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in new tab"
          className="p-1.5 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/8 transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      {/* The iframe — fills all remaining height */}
      <iframe
        key={key}
        src={EMBED_URL}
        title="Kalkiram"
        className="w-full flex-1 border-0 block"
        style={{ minHeight: 0 }}
        allow="clipboard-write; fullscreen"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}
