import re

with open('artifacts/yt-downloader/src/components/ClipCutter.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update imports
content = content.replace(
    '  Trash2,\n  Film,\n} from "lucide-react";',
    '  Trash2,\n  Film,\n  Link2,\n  Info,\n  ArrowUp,\n  SlidersHorizontal,\n  MoreVertical,\n} from "lucide-react";'
)

# 2. Add helpers at the top before ClipCutter
helpers = """
function extractYouTubeUrl(text: string): string | null {
  const ytRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = text.match(ytRegex);
  return match ? `https://www.youtube.com/watch?v=${match[1]}` : null;
}

function extractTimes(text: string): { start: number | null; end: number | null } {
  const timeRegex = /(?:(\\d{1,2}):)?(\\d{1,2}):(\\d{2})/g;
  const matches = [...text.matchAll(timeRegex)];
  
  if (matches.length === 0) return { start: null, end: null };
  
  const parseTime = (match: RegExpMatchArray) => {
    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = parseInt(match[2]);
    const seconds = parseInt(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  };

  const start = parseTime(matches[0]);
  const end = matches.length > 1 ? parseTime(matches[1]) : null;

  return { start, end };
}

export function ClipCutter() {"""
content = content.replace('export function ClipCutter() {', helpers)

# 3. Update state in ClipCutter
old_state = """  const [url, setUrl] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");"""
new_state = """  const [command, setCommand] = useState("");"""
content = content.replace(old_state, new_state)

# 4. Remove derived startSecs/endSecs
old_derived = """  const startSecs = parseTimeToSeconds(startTime);
  const endSecs = parseTimeToSeconds(endTime);
  const clipDuration =
    startSecs !== null && endSecs !== null && endSecs > startSecs
      ? endSecs - startSecs
      : null;"""
content = content.replace(old_derived, "")

# 5. Update handleCut
old_handlecut = """  const handleCut = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!url.trim()) {
      toast({ title: "Enter a YouTube URL", variant: "destructive" });
      return;
    }
    if (startSecs === null) {
      toast({ title: "Invalid start time", description: "Use 1:30 or 0:45", variant: "destructive" });
      return;
    }
    if (endSecs === null) {
      toast({ title: "Invalid end time", description: "Use 2:00 or 1:30", variant: "destructive" });
      return;
    }
    if (endSecs <= startSecs) {
      toast({ title: "End time must be after start time", variant: "destructive" });
      return;
    }
    if (endSecs - startSecs > 3600) {
      toast({ title: "Clip cannot exceed 60 minutes", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/youtube/clip-cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          startTime: startSecs,
          endTime: endSecs,
          quality,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Failed to start clip cut");
      }

      const data = (await res.json()) as { jobId: string; status?: string; message?: string };
      const label = `${secsToLabel(startSecs)} → ${secsToLabel(endSecs)}`;

      const newJob: ActiveJob = {
        jobId: data.jobId,
        label,
        url: url.trim(),
        quality,
        startSecs,
        endSecs,
        status: normalizeJobStatus(data.status, "pending"),
        percent: 0,
        speed: null,
        eta: null,
        filename: null,
        filesize: null,
        progressLine: null,
        progressSource: null,
        queueUpdatedAt: null,
        completedAt: null,
        elapsedMs: null,
        message: data.message ?? "Clip cut queued...",
        downloaded: false,
        savedToHistory: false,
        startedAt: Date.now(),
      };

      setJobs((prev) => {
        const updated = [newJob, ...prev];
        persistActiveJobs(updated);
        return updated;
      });
      setStartTime("");
      setEndTime("");"""
new_handlecut = """  const handleCut = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!command.trim()) {
      toast({ title: "Please enter a URL and times", variant: "destructive" });
      return;
    }

    const parsedUrl = extractYouTubeUrl(command);
    if (!parsedUrl) {
      toast({ title: "No valid YouTube URL found", variant: "destructive" });
      return;
    }

    const { start: startSecs, end: endSecs } = extractTimes(command);
    
    if (startSecs === null) {
      toast({ title: "No start time found", description: "Include a time like 1:30", variant: "destructive" });
      return;
    }
    if (endSecs === null) {
      toast({ title: "No end time found", description: "Include an end time like 2:00", variant: "destructive" });
      return;
    }
    if (endSecs <= startSecs) {
      toast({ title: "End time must be after start time", variant: "destructive" });
      return;
    }
    if (endSecs - startSecs > 3600) {
      toast({ title: "Clip cannot exceed 60 minutes", variant: "destructive" });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/youtube/clip-cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: parsedUrl,
          startTime: startSecs,
          endTime: endSecs,
          quality,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Failed to start clip cut");
      }

      const data = (await res.json()) as { jobId: string; status?: string; message?: string };
      const label = `${secsToLabel(startSecs)} → ${secsToLabel(endSecs)}`;

      const newJob: ActiveJob = {
        jobId: data.jobId,
        label,
        url: parsedUrl,
        quality,
        startSecs,
        endSecs,
        status: normalizeJobStatus(data.status, "pending"),
        percent: 0,
        speed: null,
        eta: null,
        filename: null,
        filesize: null,
        progressLine: null,
        progressSource: null,
        queueUpdatedAt: null,
        completedAt: null,
        elapsedMs: null,
        message: data.message ?? "Clip cut queued...",
        downloaded: false,
        savedToHistory: false,
        startedAt: Date.now(),
      };

      setJobs((prev) => {
        const updated = [newJob, ...prev];
        persistActiveJobs(updated);
        return updated;
      });
      setCommand("");"""
content = content.replace(old_handlecut, new_handlecut)

# 6. Update the entire return block in ClipCutter (lines 729-887 of original file)
# The regex targets from "  return (\n    <div className="flex flex-col gap-5">" up to "        )}</AnimatePresence></div>);"
content = re.sub(
    r'  return \(\n    <div className="flex flex-col gap-5">\n      {/\* Form — always visible \*/}.*?      </AnimatePresence>\n    </div>\n  \);\n}',
    '''  return (
    <div className="flex flex-col gap-5">
      <div className="mb-8 max-w-xl sm:mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-[34px]">Clip Cut</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400 sm:text-base lg:text-[15px]">
          Cut, trim, and extract the perfect clips from any YouTube video with AI precision.
        </p>
      </div>

      <form onSubmit={handleCut} className="flex flex-col gap-6">
        <div className="relative rounded-2xl border border-zinc-800 bg-[#0d0d0d] p-2.5 px-4 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
          <div className="flex items-center gap-3">
            <Link2 className="h-4.5 w-4.5 text-zinc-400 shrink-0" />
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={submitting}
              rows={1}
              placeholder="Paste YouTube URL and describe the clip you want..."
              className="h-7 min-h-[28px] flex-1 resize-none bg-transparent py-1 text-sm leading-5 text-white outline-none placeholder:text-zinc-500 disabled:opacity-60"
            />
            <Info className="h-4.5 w-4.5 text-zinc-400 shrink-0 hidden sm:block" />
            <button disabled={submitting || !command.trim()} type="submit" className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </button>
          </div>
        </div>
        
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button
            type="submit"
            disabled={submitting || !command.trim()}
            className="flex h-11 w-full max-w-[200px] items-center justify-center gap-2 rounded-xl bg-white text-[14px] font-semibold text-black hover:bg-white/90 sm:w-auto disabled:opacity-50"
          >
            <Scissors className="h-4 w-4" />
            Cut Clip
          </Button>
          <Button
            type="button"
            className="flex h-11 w-full max-w-[200px] items-center justify-center gap-2 rounded-xl bg-[#0d0d0d] border border-zinc-800 text-[14px] font-semibold text-white hover:bg-zinc-800/80 sm:w-auto"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Advanced
          </Button>
        </div>
      </form>

      {/* Active / in-progress job cards */}
      <AnimatePresence initial={false}>
        {jobs.map((job) => (
          <ClipJobCard
            key={job.jobId}
            job={job}
            onRemove={removeJob}
            onCancel={cancelJob}
            onDownload={downloadClip}
          />
        ))}
      </AnimatePresence>

      {/* ── History panel ──────────────────────────────────────────────────── */}
      <AnimatePresence>
        {history.length > 0 && (
          <motion.div
            key="clip-history"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex flex-col gap-4 mt-6"
          >
            <div className="w-full h-px bg-white/5 mb-2" />
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-white">Recent cuts</span>
            </div>

            <div className="flex flex-col gap-2">
              {history.map((entry) => (
                <RecentClipRow
                  key={entry.jobId}
                  entry={entry}
                  onDownload={() => downloadHistoryClip(entry)}
                  onDelete={() => setHistory(deleteFromClipHistory(entry.jobId))}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}''',
    content,
    flags=re.DOTALL
)

# 7. Append RecentClipRow, useVideoTitle, extractVideoId
helpers_bottom = """

function extractVideoId(url: string) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function useVideoTitle(url: string, defaultTitle: string) {
  const [title, setTitle] = useState(defaultTitle);

  useEffect(() => {
    const videoId = extractVideoId(url);
    if (!videoId) return;

    fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.title) {
          setTitle(data.title);
        }
      })
      .catch(() => {});
  }, [url]);

  return title;
}

function RecentClipRow({ entry, onDownload, onDelete }: { entry: ClipHistoryEntry; onDownload: (entry: ClipHistoryEntry) => void; onDelete: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const videoId = extractVideoId(entry.url);
  const title = useVideoTitle(entry.url, entry.label);

  return (
    <motion.div layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} className="bg-[#0f0f0f] border border-white/5 rounded-xl px-4 py-3 flex items-center gap-4 relative">
      <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-md bg-zinc-800">
        {videoId ? (
          <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} className="h-full w-full object-cover" alt="Thumbnail" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
            <Youtube className="h-4 w-4 text-white/20" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-white/90 text-[13px] font-semibold truncate">{title}</p>
        <p className="text-zinc-500 text-[11px] mt-0.5 truncate">
          {entry.label} • {formatDuration(entry.durationSecs)} total
        </p>
      </div>

      <div className="flex items-center shrink-0">
        <span className="text-xs text-zinc-500 hidden sm:block mr-4">
          {formatClipRelativeTime(entry.createdAt)}
        </span>
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen(!menuOpen);
            }}
            className="p-1.5 rounded-lg hover:bg-white/10 text-zinc-500 hover:text-white transition-colors"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 5 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 5 }}
                  transition={{ duration: 0.1 }}
                  className="absolute right-0 top-9 z-30 w-32 rounded-xl border border-zinc-800 bg-[#0d0d0d] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onDownload(entry);
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition"
                  >
                    <Download className="w-3.5 h-3.5" /> Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onDelete();
                      setMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-red-400/80 hover:bg-red-500/10 hover:text-red-400 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remove
                  </button>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
"""
content += helpers_bottom

with open('artifacts/yt-downloader/src/components/ClipCutter.tsx', 'w', encoding='utf-8') as f:
    f.write(content)

print("Applied!")
