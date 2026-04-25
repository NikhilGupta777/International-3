/**
 * Second-pass patch for Timestamps.tsx — fixes the 4 items that failed due to CRLF/whitespace
 */
import { readFileSync, writeFileSync } from "fs";

const file = "artifacts/yt-downloader/src/components/Timestamps.tsx";
let src = readFileSync(file, "utf8");
// Normalize to LF for consistent matching
src = src.replace(/\r\n/g, "\n");
let changes = 0;

// ── 1. Add formatRange + buildTelegramBlock after buildYtDescriptionBlock ─────
const OLD_YT_FN = `function buildYtDescriptionBlock(timestamps: TimestampEntry[]): string {
  return timestamps.map((t) => \`\${formatTime(t.startSec)} \${t.label}\`).join("\\n");
}`;
const NEW_YT_FN = `function formatRange(ts: TimestampEntry, next: TimestampEntry | undefined, videoDuration: number): string {
  const end = ts.endSec ?? next?.startSec ?? videoDuration;
  return \`\${formatTime(ts.startSec)} - \${formatTime(end)}\`;
}

function buildYtDescriptionBlock(timestamps: TimestampEntry[]): string {
  return timestamps.map((t) => \`\${formatTime(t.startSec)} \${t.label}\`).join("\\n");
}

function buildTelegramBlock(timestamps: TimestampEntry[], videoDuration: number): string {
  return timestamps.map((t, i) => {
    const range = formatRange(t, timestamps[i + 1], videoDuration);
    return \`\${i + 1}. \${t.label}\\nTIME STAMP \${range}\`;
  }).join("\\n\\n");
}`;
if (src.includes(OLD_YT_FN)) {
  src = src.replace(OLD_YT_FN, NEW_YT_FN);
  changes++; console.log("✅ 1. formatRange + buildTelegramBlock added");
} else {
  console.error("❌ buildYtDescriptionBlock not found");
}

// ── 2. Immediate progress steps on click ─────────────────────────────────────
const OLD_STEPS = `    closeSSE();
    closePolling();
    statusRef.current = "running";
    setStatus("running");
    setSteps([]);
    setResult(null);
    setError(null);`;
const NEW_STEPS = `    closeSSE();
    closePolling();
    statusRef.current = "running";
    setStatus("running");
    setResult(null);
    setError(null);
    // Show all 3 pipeline steps immediately so user sees progress from the first click
    setSteps([
      { name: "metadata",   status: "running", message: "Fetching video info..." },
      { name: "transcript", status: "idle",    message: "Waiting..." },
      { name: "ai",         status: "idle",    message: "Waiting..." },
    ]);`;
if (src.includes(OLD_STEPS)) {
  src = src.replace(OLD_STEPS, NEW_STEPS);
  changes++; console.log("✅ 2. Immediate progress steps added");
} else {
  console.error("❌ handleSubmit steps block not found");
}

// ── 3. Numbered + range timestamp list ────────────────────────────────────────
const OLD_LIST = `              {result.timestamps.map((ts, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.025, duration: 0.25 }}
                    className="flex items-center gap-3 px-4 py-2.5 group hover:bg-white/3 transition-colors"
                  >
                    <span className="font-mono text-sm font-bold text-indigo-400 shrink-0 w-16 text-right">
                      {formatTime(ts.startSec)}
                    </span>
                    <span className="flex-1 text-sm text-white/85 min-w-0 leading-snug">
                      {ts.label}
                    </span>
                    <button
                      onClick={() => copy(\`\${formatTime(ts.startSec)} \${ts.label}\`, \`row-\${i}\`)}
                      className={cn(
                        "shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-150",
                        copied === \`row-\${i}\`
                          ? "bg-emerald-600/30 text-emerald-400 opacity-100"
                          : "bg-white/5 text-white/40 hover:text-white/80",
                      )}
                      title="Copy this line"
                    >
                      {copied === \`row-\${i}\` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </motion.div>
                ))}`;
const NEW_LIST = `              {result.timestamps.map((ts, i) => {
                  const range = formatRange(ts, result.timestamps[i + 1], result.videoDuration);
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.025, duration: 0.25 }}
                      className="flex items-start gap-3 px-4 py-3 group hover:bg-white/3 transition-colors"
                    >
                      {/* Index */}
                      <span className="font-mono text-xs font-bold text-indigo-400/50 shrink-0 w-5 text-right pt-1">
                        {i + 1}
                      </span>
                      {/* Time range: start on top, end below */}
                      <div className="shrink-0 text-right min-w-[3.5rem]">
                        <span className="font-mono text-xs font-bold text-indigo-400 block">{formatTime(ts.startSec)}</span>
                        <span className="font-mono text-[10px] text-indigo-400/45 block leading-tight">
                          {range.split(" - ")[1]}
                        </span>
                      </div>
                      {/* Label */}
                      <span className="flex-1 text-sm text-white/85 min-w-0 leading-snug">
                        {ts.label}
                      </span>
                      {/* Copy single row (Telegram format) */}
                      <button
                        onClick={() => copy(\`\${i + 1}. \${ts.label}\\nTIME STAMP \${range}\`, \`row-\${i}\`)}
                        className={cn(
                          "shrink-0 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-all duration-150",
                          copied === \`row-\${i}\`
                            ? "bg-emerald-600/30 text-emerald-400 opacity-100"
                            : "bg-white/5 text-white/40 hover:text-white/80",
                        )}
                        title="Copy this timestamp"
                      >
                        {copied === \`row-\${i}\` ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </motion.div>
                  );
                })}`;
if (src.includes(OLD_LIST)) {
  src = src.replace(OLD_LIST, NEW_LIST);
  changes++; console.log("✅ 3. Timestamp list updated: numbered + range display");
} else {
  console.error("❌ Timestamp list not found");
}

// ── 4. Add Telegram copy block (above plain text) and rename plain text label ──
const OLD_PLAIN = `            {/* Plain-text block for easy pasting */}
            <div className="glass-panel rounded-2xl border border-white/8 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                  Plain Text (paste into YouTube description)
                </span>`;
const NEW_PLAIN = `            {/* Telegram-style numbered range block */}
            <div className="glass-panel rounded-2xl border border-violet-500/20 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-xs font-semibold text-violet-300/70 uppercase tracking-widest">
                  Telegram Format (numbered + ranges)
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => copy(telegramBlock, "telegram")}
                  className={cn(
                    "h-7 px-3 text-xs font-medium rounded-lg transition-all duration-200",
                    copied === "telegram"
                      ? "bg-emerald-600 text-white"
                      : "bg-violet-600/40 hover:bg-violet-600/70 text-white/70",
                  )}
                >
                  {copied === "telegram" ? <><Check className="w-3.5 h-3.5 mr-1.5" />Copied!</> : <><Copy className="w-3.5 h-3.5 mr-1.5" />Copy</>}
                </Button>
              </div>
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto">
                {telegramBlock}
              </pre>
            </div>

            {/* Plain-text block for YouTube description */}
            <div className="glass-panel rounded-2xl border border-white/8 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                  YouTube Description Format
                </span>`;
if (src.includes(OLD_PLAIN)) {
  src = src.replace(OLD_PLAIN, NEW_PLAIN);
  changes++; console.log("✅ 4. Telegram copy block added above YouTube format");
} else {
  console.error("❌ Plain text block header not found");
}

writeFileSync(file, src, "utf8");
console.log(`\n✅ Done — ${changes} changes applied`);
