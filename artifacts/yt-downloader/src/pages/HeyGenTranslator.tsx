export default function HeyGenTranslator() {
  return (
    <div className="h-full min-h-0 w-full bg-[#111214]">
      <iframe
        title="HeyGen Video Translate"
        src="/heygen/index.html"
        className="h-full min-h-[100vh] w-full border-0 bg-[#111214]"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
}
