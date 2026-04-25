/**
 * Patches Home.tsx: studio-dark background, refined logo, clean toolbar tab nav.
 * Zero logic changes — purely visual className updates.
 */
import { readFileSync, writeFileSync } from "fs";

const file = "artifacts/yt-downloader/src/pages/Home.tsx";
let src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
let changes = 0;

// ── 1. Outer wrapper + background ────────────────────────────────────────────
const OLD_BG = `    <div className="min-h-screen relative overflow-x-hidden flex flex-col items-center pb-24 px-2 sm:px-6">
      
      {/* Premium Background */}
      <div className="fixed inset-0 z-[-1]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(229,9,20,0.22),transparent_50%),radial-gradient(circle_at_80%_15%,rgba(147,51,234,0.14),transparent_45%),radial-gradient(circle_at_50%_100%,rgba(244,63,94,0.16),transparent_55%)]" />
        <div className="absolute inset-0 bg-background/80 backdrop-blur-[20px] sm:backdrop-blur-[60px]" />
        <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/20 blur-[120px] rounded-full pointer-events-none" />
      </div>`;

const NEW_BG = `    <div className="min-h-screen relative overflow-x-hidden flex flex-col items-center pb-24 px-2 sm:px-6">

      {/* Studio Background */}
      <div className="fixed inset-0 z-[-1]" style={{background:"#111111"}}>
        {/* Subtle dot grid */}
        <div className="absolute inset-0 studio-dots" />
        {/* Very faint warm glow at top only */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[320px] rounded-full pointer-events-none" style={{background:"radial-gradient(ellipse at 50% 0%, rgba(185,28,28,0.10), transparent 70%)"}} />
      </div>`;

if (src.includes(OLD_BG)) { src = src.replace(OLD_BG, NEW_BG); changes++; console.log("✅ 1. Background updated"); }
else console.error("❌ Background block not found");

// ── 2. Logo area ─────────────────────────────────────────────────────────────
const OLD_LOGO = `          {/* Logo */}
          <motion.div layout className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-8">
            <div className="bg-primary/20 p-3 rounded-2xl border border-primary/30 shadow-[0_0_30px_rgba(229,9,20,0.3)]">
              <Youtube className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-2xl sm:text-3xl md:text-5xl font-display font-bold tracking-tight text-white text-center sm:text-left">
              VideoMaking <span className="text-primary text-glow">Studio</span>
            </h1>
          </motion.div>`;

const NEW_LOGO = `          {/* Logo */}
          <motion.div layout className="flex items-center gap-2.5 sm:gap-3 mb-5 sm:mb-8">
            <div className="p-2 rounded-lg border" style={{background:"rgba(185,28,28,0.12)",borderColor:"rgba(185,28,28,0.22)"}}>
              <Youtube className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-xl sm:text-2xl md:text-4xl font-semibold tracking-[-0.03em] text-white text-center sm:text-left">
              VideoMaking <span className="text-primary text-glow">Studio</span>
            </h1>
          </motion.div>`;

if (src.includes(OLD_LOGO)) { src = src.replace(OLD_LOGO, NEW_LOGO); changes++; console.log("✅ 2. Logo refined"); }
else console.error("❌ Logo block not found");

// ── 3. Subtitle text ──────────────────────────────────────────────────────────
const OLD_SUB = `            <motion.p layout className="text-white/60 text-base sm:text-lg mb-6 sm:mb-8 text-center max-w-lg px-2 sm:px-0">
              Smart media workspace for YouTube workflows: fast downloads, AI best-clips extraction, subtitles, precise clip cutting, sabha venue matching, and Bhagwat devotional studio rendering.
            </motion.p>`;
const NEW_SUB = `            <motion.p layout className="mb-6 sm:mb-8 text-center max-w-md px-2 sm:px-0 text-sm leading-relaxed" style={{color:"rgba(255,255,255,0.40)"}}>
              Download · Best Clips · Subtitles · Clip Cut · Bhagwat · Find Sabha · Timestamps
            </motion.p>`;

if (src.includes(OLD_SUB)) { src = src.replace(OLD_SUB, NEW_SUB); changes++; console.log("✅ 3. Subtitle simplified"); }
else console.error("❌ Subtitle text not found");

// ── 4. Tab nav container ──────────────────────────────────────────────────────
const OLD_NAV_WRAP = `          <motion.div
            layout
            className="w-full sm:w-auto mb-6 rounded-2xl border border-white/10 bg-white/5 p-1"
          >
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">`;
const NEW_NAV_WRAP = `          <motion.div
            layout
            className="w-full mb-6 overflow-x-auto no-scrollbar"
            style={{borderBottom:"1px solid rgba(255,255,255,0.08)"}}
          >
            <div className="flex items-center gap-0.5 min-w-max pb-0">`;

if (src.includes(OLD_NAV_WRAP)) { src = src.replace(OLD_NAV_WRAP, NEW_NAV_WRAP); changes++; console.log("✅ 4. Nav container → studio toolbar"); }
else console.error("❌ Nav container not found");

// ── 5. Tab buttons — replace each colorful button with studio-tab style ───────
const tabReplacements = [
  // Download
  {
    old: `              onClick={() => { setMode("download"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "download"
                  ? "bg-primary text-white shadow-[0_0_20px_rgba(229,9,20,0.3)]"
                  : "text-white/50 hover:text-white/80"
              )}`,
    new: `              onClick={() => { setMode("download"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "download" && "studio-tab-active")}`,
  },
  // Best Clips
  {
    old: `              onClick={() => { setMode("clips"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "clips"
                  ? "bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-[0_0_20px_rgba(139,92,246,0.4)]"
                  : "text-white/50 hover:text-white/80"
              )}`,
    new: `              onClick={() => { setMode("clips"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "clips" && "studio-tab-active")}`,
  },
  // Subtitles
  {
    old: `              onClick={() => { setMode("subtitles"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "subtitles"
                  ? "bg-gradient-to-r from-teal-600 to-cyan-600 text-white shadow-[0_0_20px_rgba(20,184,166,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}`,
    new: `              onClick={() => { setMode("subtitles"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "subtitles" && "studio-tab-active")}`,
  },
  // Clip Cut
  {
    old: `              onClick={() => { setMode("clipcutter"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "clipcutter"
                  ? "bg-gradient-to-r from-orange-600 to-amber-600 text-white shadow-[0_0_20px_rgba(249,115,22,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}`,
    new: `              onClick={() => { setMode("clipcutter"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "clipcutter" && "studio-tab-active")}`,
  },
  // Bhagwat
  {
    old: `              onClick={() => { setMode("bhagwat"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "bhagwat"
                  ? "bg-gradient-to-r from-amber-600 to-yellow-600 text-white shadow-[0_0_20px_rgba(245,158,11,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}`,
    new: `              onClick={() => { setMode("bhagwat"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "bhagwat" && "studio-tab-active")}`,
  },
  // Find Sabha
  {
    old: `              onClick={() => { setMode("scenefinder"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "scenefinder"
                  ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-[0_0_20px_rgba(6,182,212,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}`,
    new: `              onClick={() => { setMode("scenefinder"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "scenefinder" && "studio-tab-active")}`,
  },
  // Timestamps
  {
    old: `              onClick={() => { setMode("timestamps"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn(
                "flex-1 min-w-[78px] sm:min-w-0 sm:flex-none flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 whitespace-nowrap",
                mode === "timestamps"
                  ? "bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.35)]"
                  : "text-white/50 hover:text-white/80"
              )}`,
    new: `              onClick={() => { setMode("timestamps"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "timestamps" && "studio-tab-active")}`,
  },
];

for (const { old, new: neu } of tabReplacements) {
  if (src.includes(old)) { src = src.replace(old, neu); changes++; }
  else console.warn(`⚠️  Tab button not found exactly`);
}
console.log(`✅ 5. Tab buttons → studio-tab (${tabReplacements.length} tabs)`);

// ── 6. Tab badge labels — keep AI/Pro badges but simplify them ────────────────
// Replace the verbose sm:hidden/sm:inline spans in tab buttons with simpler single spans
// For clips tab inner content
src = src.replace(
  `              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Clips</span>
              <span className="hidden sm:inline">Best Clips</span>
              <Badge className="hidden sm:inline-flex bg-violet-500/20 text-violet-300 border-violet-500/30 text-[10px] px-1.5 py-0">
                AI
              </Badge>`,
  `              <Sparkles className="w-3 h-3 shrink-0 opacity-70" />
              <span>Best Clips</span>
              <span className="text-[9px] font-bold tracking-wider opacity-50 bg-white/10 rounded px-1 py-px">AI</span>`
);
src = src.replace(
  `              <Download className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Get</span>
              <span className="hidden sm:inline">Download</span>`,
  `              <Download className="w-3 h-3 shrink-0 opacity-70" />
              <span>Download</span>`
);
src = src.replace(
  `              <Captions className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Subs</span>
              <span className="hidden sm:inline">Subtitles</span>`,
  `              <Captions className="w-3 h-3 shrink-0 opacity-70" />
              <span>Subtitles</span>`
);
src = src.replace(
  `              <Scissors className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Cut</span>
              <span className="hidden sm:inline">Clip Cut</span>`,
  `              <Scissors className="w-3 h-3 shrink-0 opacity-70" />
              <span>Clip Cut</span>`
);
src = src.replace(
  `              <Shield className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Bhagwat</span>
              <span className="hidden sm:inline">Bhagwat</span>
              <Badge className="hidden sm:inline-flex bg-amber-500/20 text-amber-200 border-amber-500/30 text-[10px] px-1.5 py-0">
                Pro
              </Badge>`,
  `              <Shield className="w-3 h-3 shrink-0 opacity-70" />
              <span>Bhagwat</span>
              <span className="text-[9px] font-bold tracking-wider opacity-50 bg-white/10 rounded px-1 py-px">Pro</span>`
);
src = src.replace(
  `              <ListVideo className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Sabha</span>
              <span className="hidden sm:inline">Find Sabha</span>
              <Badge className="hidden sm:inline-flex bg-cyan-500/20 text-cyan-200 border-cyan-500/30 text-[10px] px-1.5 py-0">
                AI
              </Badge>`,
  `              <ListVideo className="w-3 h-3 shrink-0 opacity-70" />
              <span>Find Sabha</span>
              <span className="text-[9px] font-bold tracking-wider opacity-50 bg-white/10 rounded px-1 py-px">AI</span>`
);
src = src.replace(
  `              <AlarmClock className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">Times</span>
              <span className="hidden sm:inline">Timestamps</span>
              <Badge className="hidden sm:inline-flex bg-indigo-500/20 text-indigo-200 border-indigo-500/30 text-[10px] px-1.5 py-0">
                AI
              </Badge>`,
  `              <AlarmClock className="w-3 h-3 shrink-0 opacity-70" />
              <span>Timestamps</span>
              <span className="text-[9px] font-bold tracking-wider opacity-50 bg-white/10 rounded px-1 py-px">AI</span>`
);
changes++; console.log("✅ 6. Tab button labels simplified");

// ── 7. Search bar — studio style ──────────────────────────────────────────────
const OLD_SEARCH = `            <div className="absolute -inset-1 bg-gradient-to-r from-primary/60 to-purple-600/60 rounded-2xl blur-lg opacity-30 group-hover:opacity-60 transition duration-500 pointer-events-none" />
            <div className="relative glass-panel rounded-2xl flex p-2 shadow-2xl items-center focus-within:border-primary/50 transition-colors">`;
const NEW_SEARCH = `            <div className="relative rounded-xl flex p-1.5 items-center transition-all" style={{background:"#1a1a1a",border:"1px solid #2e2e2e",boxShadow:"0 2px 20px rgba(0,0,0,0.4)"}}>`;

if (src.includes(OLD_SEARCH)) { src = src.replace(OLD_SEARCH, NEW_SEARCH); changes++; console.log("✅ 7. Search bar → studio style"); }
else console.error("❌ Search bar not found");

// ── 8. Search input placeholder color ─────────────────────────────────────────
src = src.replace(
  `className="bg-transparent flex-1 outline-none px-3 sm:px-4 py-3 text-white placeholder:text-white/30 text-base sm:text-lg min-w-0"`,
  `className="bg-transparent flex-1 outline-none px-3 sm:px-4 py-2.5 text-white placeholder:text-white/25 text-sm sm:text-base min-w-0 font-medium"`
);
changes++; console.log("✅ 8. Search input refined");

writeFileSync(file, src, "utf8");
console.log(`\n✅ Done — ${changes} changes applied to Home.tsx`);
