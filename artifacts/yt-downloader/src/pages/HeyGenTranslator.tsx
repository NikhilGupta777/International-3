import { useState } from "react";

export default function HeyGenTranslator() {
  const [src] = useState(() => `/heygen/index.html?v=${Date.now()}`);

  return (
    <div className="h-full min-h-0 w-full bg-[#111214]">
      <iframe
        key={src}
        title="HeyGen Video Translate"
        src={src}
        className="h-full min-h-[100vh] w-full border-0 bg-[#111214]"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
}
