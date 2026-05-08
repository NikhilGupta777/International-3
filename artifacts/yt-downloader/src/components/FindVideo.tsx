import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";

const EMBED_URL = "https://kalkiram.com";

export function FindVideo() {
  const [key, setKey] = useState(0);

  return (
    // Use flex:1 + min-h-0 pattern — works inside any flex parent without needing
    // explicit height values. The iframe gets all remaining space via flex:1.
    // minHeight:0 on the outer div prevents flex from using content size as minimum.
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 0%",
        minHeight: 0,
        height: "100%",
      }}
    >
      {/* Thin top bar — reload + open-in-new-tab */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "8px",
          padding: "6px 12px",
          flexShrink: 0,
          background: "rgba(255,255,255,0.03)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <button
          onClick={() => setKey((k) => k + 1)}
          title="Reload"
          style={{
            padding: "6px",
            borderRadius: "8px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "rgba(255,255,255,0.3)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <RefreshCw style={{ width: 14, height: 14 }} />
        </button>
        <a
          href={EMBED_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in new tab"
          style={{
            padding: "6px",
            borderRadius: "8px",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "rgba(255,255,255,0.3)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <ExternalLink style={{ width: 14, height: 14 }} />
        </a>
      </div>

      {/* iframe fills all remaining space via flex:1 + min-h-0 */}
      <iframe
        key={key}
        src={EMBED_URL}
        title="Kalkiram"
        style={{
          flex: "1 1 0%",
          minHeight: "calc(100dvh - 96px)",
          width: "100%",
          border: "none",
          display: "block",
        }}
        allow="clipboard-write; fullscreen"
        referrerPolicy="no-referrer-when-downgrade"
      />
    </div>
  );
}
