/**
 * Adds "Upload" tab to Home.tsx
 * - Adds UploadCloud to lucide imports
 * - Adds FileUpload import
 * - Adds "upload" to Mode type
 * - Adds tab button in nav
 * - Adds showUpload derived bool + renders <FileUpload />
 */
import { readFileSync, writeFileSync } from "fs";

const file = "artifacts/yt-downloader/src/pages/Home.tsx";
let src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
let ok = 0;

// 1. Add UploadCloud to lucide imports
src = src.replace(
  "import { AlarmClock,",
  "import { AlarmClock, UploadCloud,"
);
ok++;

// 2. Add FileUpload import (near other component imports)
src = src.replace(
  "import { Timestamps } from \"@/components/Timestamps\";",
  "import { Timestamps } from \"@/components/Timestamps\";\nimport { FileUpload } from \"@/components/FileUpload\";"
);
ok++;

// 3. Add "upload" to Mode type
src = src.replace(
  "type Mode = \"download\" | \"clips\" | \"subtitles\" | \"clipcutter\" | \"bhagwat\" | \"scenefinder\" | \"timestamps\";",
  "type Mode = \"download\" | \"clips\" | \"subtitles\" | \"clipcutter\" | \"bhagwat\" | \"scenefinder\" | \"timestamps\" | \"upload\";"
);
ok++;

// 4. Add showUpload derived var (near other show* vars)
src = src.replace(
  "const showTimestamps = mode === \"timestamps\";",
  "const showTimestamps = mode === \"timestamps\";\n  const showUpload = mode === \"upload\";"
);
ok++;

// 5. Add tab button (after the timestamps button, before closing </div>)
const OLD_TS_BTN_END = `              <AlarmClock className="w-3 h-3 shrink-0 opacity-70" />
              <span>Timestamps</span>
              <span className="text-[9px] font-bold tracking-wider opacity-50 bg-white/10 rounded px-1 py-px">AI</span>
            </button>
            </div>`;
const NEW_TS_BTN_END = `              <AlarmClock className="w-3 h-3 shrink-0 opacity-70" />
              <span>Timestamps</span>
              <span className="text-[9px] font-bold tracking-wider opacity-50 bg-white/10 rounded px-1 py-px">AI</span>
            </button>
            <button
              onClick={() => { setMode("upload"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className={cn("studio-tab", mode === "upload" && "studio-tab-active")}
            >
              <UploadCloud className="w-3 h-3 shrink-0 opacity-70" />
              <span>Upload</span>
            </button>
            </div>`;
if (src.includes(OLD_TS_BTN_END)) { src = src.replace(OLD_TS_BTN_END, NEW_TS_BTN_END); ok++; }
else console.error("❌ Timestamps tab end not found");

// 6. Add <FileUpload /> panel (after showTimestamps block)
const OLD_TS_PANEL = `            {showTimestamps && (
              <motion.div
                key="timestamps-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="w-full"
              >
                <Timestamps />
              </motion.div>
            )}`;
const NEW_TS_PANEL = `            {showTimestamps && (
              <motion.div
                key="timestamps-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="w-full"
              >
                <Timestamps />
              </motion.div>
            )}

            {showUpload && (
              <motion.div
                key="upload-panel"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
                className="w-full"
              >
                <FileUpload />
              </motion.div>
            )}`;
if (src.includes(OLD_TS_PANEL)) { src = src.replace(OLD_TS_PANEL, NEW_TS_PANEL); ok++; }
else console.error("❌ Timestamps panel block not found");

// 7. showSearch should also hide for upload mode (search bar not needed)
src = src.replace(
  `const showSearch = mode === "download" || mode === "clips";`,
  `const showSearch = mode === "download" || mode === "clips";`
  // already fine — upload tab won't show search bar by default (mode is not download/clips)
);

writeFileSync(file, src, "utf8");
console.log(`✅ Done — ${ok} changes applied to Home.tsx`);
