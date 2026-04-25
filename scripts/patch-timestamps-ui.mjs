/**
 * Patches Timestamps.tsx:
 * 1. Adds immediate local progress steps on Generate click (before API responds)
 * 2. Shows range timestamps: "3:50 - 5:27" format like the Telegram examples
 * 3. Shows numbered list of topics
 * 4. Better Telegram-style copy format: "1. Topic\n3:50 - 5:27\n\n2. ..."
 * 5. Also keeps plain YouTube chapter format for the YouTube description block
 */
import { readFileSync, writeFileSync } from "fs";

const file = "artifacts/yt-downloader/src/components/Timestamps.tsx";
let src = readFileSync(file, "utf8");
let changes = 0;

// ── 1. Add endSec to TimestampEntry type ──────────────────────────────────────
const OLD_TS_TYPE = "type TimestampEntry = { startSec: number; label: string };";
const NEW_TS_TYPE  = "type TimestampEntry = { startSec: number; endSec?: number; label: string };";
if (src.includes(OLD_TS_TYPE)) {
  src = src.replace(OLD_TS_TYPE, NEW_TS_TYPE);
  changes++; console.log("✅ 1. TimestampEntry type updated with endSec");
} else {
  console.warn("⚠️  TimestampEntry type not found");
}

// ── 2. Add formatRange helper after formatTime ────────────────────────────────
const OLD_FORMAT_FN = `function buildYtDescriptionBlock(timestamps: TimestampEntry[]): string {
  return timestamps.map((t) => \`\${formatTime(t.startSec)} \${t.label}\`).join("\\n");
}`;
const NEW_FORMAT_FN = `function formatRange(ts: TimestampEntry, next: TimestampEntry | undefined, videoDuration: number): string {
  const start = formatTime(ts.startSec);
  const endSec = ts.endSec ?? next?.startSec ?? videoDuration;
  const end = formatTime(endSec);
  return \`\${start} - \${end}\`;
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
if (src.includes(OLD_FORMAT_FN)) {
  src = src.replace(OLD_FORMAT_FN, NEW_FORMAT_FN);
  changes++; console.log("✅ 2. formatRange + buildTelegramBlock helpers added");
} else {
  console.warn("⚠️  buildYtDescriptionBlock not found as expected");
}

// ── 3. Add immediate step "Initializing..." on Generate click (before fetch) ──
const OLD_SUBMIT_START = `    closeSSE();
    closePolling();
    statusRef.current = "running";
    setStatus("running");
    setSteps([]);
    setResult(null);
    setError(null);`;
const NEW_SUBMIT_START = `    closeSSE();
    closePolling();
    statusRef.current = "running";
    setStatus("running");
    setResult(null);
    setError(null);
    // Show all 3 pipeline steps immediately so the user sees progress from the first click
    setSteps([
      { name: "metadata", status: "running", message: "Fetching video info..." },
      { name: "transcript", status: "idle", message: "Waiting..." },
      { name: "ai", status: "idle", message: "Waiting..." },
    ]);`;
if (src.includes(OLD_SUBMIT_START)) {
  src = src.replace(OLD_SUBMIT_START, NEW_SUBMIT_START);
  changes++; console.log("✅ 3. Immediate progress steps on Generate click added");
} else {
  console.warn("⚠️  handleSubmit start block not found");
}

// ── 4. Add telegramBlock computation near ytBlock ─────────────────────────────
const OLD_YT_BLOCK = `  const ytBlock = result ? buildYtDescriptionBlock(result.timestamps) : "";`;
const NEW_YT_BLOCK = `  const ytBlock = result ? buildYtDescriptionBlock(result.timestamps) : "";
  const telegramBlock = result ? buildTelegramBlock(result.timestamps, result.videoDuration) : "";`;
if (src.includes(OLD_YT_BLOCK)) {
  src = src.replace(OLD_YT_BLOCK, NEW_YT_BLOCK);
  changes++; console.log("✅ 4. telegramBlock computation added");
} else {
  console.warn("⚠️  ytBlock line not found");
}

// ── 5. Replace the timestamp list items to show range + numbered ───────────────
const OLD_TS_LIST = `              {result.timestamps.map((ts, i) => (
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
const NEW_TS_LIST = `              {result.timestamps.map((ts, i) => {
                  const range = formatRange(ts, result.timestamps[i + 1], result.videoDuration);
                  return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.025, duration: 0.25 }}
                    className="flex items-start gap-3 px-4 py-3 group hover:bg-white/3 transition-colors"
                  >
                    {/* Number badge */}
                    <span className="font-mono text-xs font-bold text-indigo-400/60 shrink-0 w-5 text-right pt-0.5">
                      {i + 1}
                    </span>
                    {/* Time range */}
                    <div className="shrink-0 text-right">
                      <span className="font-mono text-xs font-bold text-indigo-400 block">
                        {range.split(" - ")[0]}
                      </span>
                      <span className="font-mono text-[10px] text-indigo-400/50 block leading-none">
                        {range.split(" - ")[1]}
                      </span>
                    </div>
                    {/* Label */}
                    <span className="flex-1 text-sm text-white/85 min-w-0 leading-snug">
                      {ts.label}
                    </span>
                    {/* Copy row */}
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
if (src.includes(OLD_TS_LIST)) {
  src = src.replace(OLD_TS_LIST, NEW_TS_LIST);
  changes++; console.log("✅ 5. Timestamp list updated: numbered, range display, Telegram-style copy");
} else {
  console.warn("⚠️  Timestamp list block not found exactly — check whitespace");
}

// ── 6. Add Telegram-style copy block above the plain text block ───────────────
const OLD_PLAIN_BLOCK = `            {/* Plain-text block for easy pasting */}
            <div className="glass-panel rounded-2xl border border-white/8 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-widest">
                  Plain Text (paste into YouTube description)
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => copy(ytBlock, "text")}
                  className={cn(
                    "h-7 px-3 text-xs font-medium rounded-lg transition-all duration-200",
                    copied === "text"
                      ? "bg-emerald-600 text-white"
                      : "bg-white/8 hover:bg-white/15 text-white/60",
                  )}
                >
                  {copied === "text" ? <><Check className="w-3.5 h-3.5 mr-1.5" />Copied!</> : <><Copy className="w-3.5 h-3.5 mr-1.5" />Copy</>}
                </Button>
              </div>
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto">
                {ytBlock}
              </pre>
            </div>`;
const NEW_PLAIN_BLOCK = `            {/* Telegram-style numbered range block */}
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
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => copy(ytBlock, "text")}
                  className={cn(
                    "h-7 px-3 text-xs font-medium rounded-lg transition-all duration-200",
                    copied === "text"
                      ? "bg-emerald-600 text-white"
                      : "bg-white/8 hover:bg-white/15 text-white/60",
                  )}
                >
                  {copied === "text" ? <><Check className="w-3.5 h-3.5 mr-1.5" />Copied!</> : <><Copy className="w-3.5 h-3.5 mr-1.5" />Copy</>}
                </Button>
              </div>
              <pre className="px-4 py-3 text-xs text-white/55 font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-52 overflow-y-auto">
                {ytBlock}
              </pre>
            </div>`;
if (src.includes(OLD_PLAIN_BLOCK)) {
  src = src.replace(OLD_PLAIN_BLOCK, NEW_PLAIN_BLOCK);
  changes++; console.log("✅ 6. Telegram copy block added above YouTube format block");
} else {
  console.warn("⚠️  Plain text block not found — whitespace may differ");
}

// ── 7. Update Copy All to use Telegram format ─────────────────────────────────
const OLD_COPY_ALL = `onClick={() => copy(ytBlock, "all")}`;
const NEW_COPY_ALL = `onClick={() => copy(telegramBlock, "all")}`;
if (src.includes(OLD_COPY_ALL)) {
  src = src.replace(OLD_COPY_ALL, NEW_COPY_ALL);
  changes++; console.log("✅ 7. Copy All now copies Telegram format");
} else {
  console.warn("⚠️  Copy All onClick not found");
}

writeFileSync(file, src, "utf8");
console.log(`\n✅ Done — ${changes} changes applied to ${file}`);
