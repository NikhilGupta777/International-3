import sys
import json

with open(r'artifacts/yt-downloader/src/components/ClipCutter.tsx', 'r', encoding='utf-8') as f:
    content = f.read()

handleCutOld = content[content.find('  const handleCut = async (e: React.FormEvent) => {'):content.find('  const removeJob = (jobId: string) => {')]
handleCutNew = """  const handleCut = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;

    let requestedUrl = "";
    let requestedStartSecs: number | null = null;
    let requestedEndSecs: number | null = null;

    const localUrl = extractYouTubeUrl(command);
    const { start: localStart, end: localEnd } = extractTimes(command);
    const localStartSecs = parseTimeToSeconds(localStart);
    const localEndSecs = parseTimeToSeconds(localEnd);

    if (localUrl && localStartSecs !== null && localEndSecs !== null) {
      requestedUrl = localUrl;
      requestedStartSecs = localStartSecs;
      requestedEndSecs = localEndSecs;
    } else {
      setSubmitting(true);
      try {
        const intentRes = await fetch(`${BASE_URL}/api/youtube/clip-cut/intent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: command.trim() }),
        });
        const intentData = await intentRes.json().catch(() => ({}));
        if (!intentRes.ok) {
          throw new Error(intentData.error || "AI could not understand the clip request.");
        }
        requestedUrl = intentData.url ?? "";
        requestedStartSecs = typeof intentData.startTime === "number" ? intentData.startTime : null;
        requestedEndSecs = typeof intentData.endTime === "number" ? intentData.endTime : null;
      } catch (err) {
        toast({ title: "AI needs more detail", description: err instanceof Error ? err.message : "Error", variant: "destructive" });
        setSubmitting(false);
        return;
      }
    }

    if (!requestedUrl) {
      toast({ title: "Missing URL", variant: "destructive" });
      setSubmitting(false);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/youtube/clip-cut`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: requestedUrl,
          startTime: requestedStartSecs,
          endTime: requestedEndSecs,
          quality: "best",
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to start clip cut");
      }

      const data = await res.json();
      const label = (requestedStartSecs !== null && requestedEndSecs !== null) 
          ? `${secsToLabel(requestedStartSecs)} → ${secsToLabel(requestedEndSecs)}` 
          : "AI Clip";

      const newJob: ActiveJob = {
        jobId: data.jobId,
        label,
        url: requestedUrl,
        quality: "best",
        startSecs: requestedStartSecs ?? 0,
        endSecs: requestedEndSecs ?? 0,
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
      setCommand("");
    } catch (err) {
      toast({ title: "Failed to start clip", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };\n\n"""
content = content.replace(handleCutOld, handleCutNew)

jsxOld = content[content.find('  return ('):content.find('function useElapsed')]
jsxNew = """  return (
    <div className="flex flex-col">
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

        <div className="mt-2 flex flex-col items-center justify-center gap-3 sm:flex-row">
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

      <AnimatePresence initial={false}>
        <div className="mt-8 flex flex-col gap-3">
          {jobs.map((job) => (
            <ClipJobCard key={job.jobId} job={job} onRemove={removeJob} onCancel={cancelJob} onDownload={downloadClip} />
          ))}
        </div>
      </AnimatePresence>

      <div className="mt-12 border-t border-zinc-900 pt-8 sm:mt-16">
        <h2 className="mb-5 text-base font-bold text-white">Recent cuts</h2>
        {history.length > 0 ? (
          <div className="grid gap-3">
            {history.map((entry) => (
              <RecentClipRow key={entry.jobId} entry={entry} onDownload={downloadHistoryClip} onDelete={() => setHistory(deleteFromClipHistory(entry.jobId))} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-900/60 bg-[#0c0c0e]/30 px-5 py-6 text-xs text-zinc-500 text-center font-medium">
            Your finished clip cuts will appear here with YouTube thumbnails.
          </div>
        )}
      </div>
    </div>
  );
}\n\n"""
content = content.replace(jsxOld, jsxNew)

clipJobCardOld = content[content.find('function ClipJobCard({'):content.find('      {/* Progress bar */}')]
clipJobCardNew = """function ClipJobCard({
  job,
  onRemove,
  onCancel,
  onDownload,
}: {
  job: ActiveJob;
  onRemove: (id: string) => void;
  onCancel: (id: string) => void;
  onDownload: (job: ActiveJob) => void;
}) {
  const isDone = job.status === "done";
  const isError = job.status === "error";
  const isCancelled = job.status === "cancelled";
  const isProcessing =
    job.status === "pending" ||
    job.status === "downloading" ||
    job.status === "merging";

  const isCancelling = isProcessing && (job.message ?? "").toLowerCase().includes("cancel");
  const queuePositionMatch = job.message?.match(/queued\\s*\\(#(\\d+)\\)/i);
  const queuePosition = queuePositionMatch ? Number.parseInt(queuePositionMatch[1], 10) : null;
  const isQueued = job.status === "pending" && (job.message ?? "").toLowerCase().includes("queued");

  const elapsed = useElapsed(job.startedAt, isProcessing);
  const progressView = getClipProgressView(job, elapsed);
  const doneTimeLabel = fmtMs(job.elapsedMs ?? (job.completedAt ? job.completedAt - job.startedAt : null));
  
  const videoId = extractVideoId(job.url);
  const title = useVideoTitle(job.url, job.label);

  return (
    <motion.div
      key={job.jobId}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, height: 0 }}
      transition={{ duration: 0.25 }}
      className={cn(
        "glass-panel rounded-2xl px-5 py-4 flex flex-col gap-3 relative overflow-hidden border",
        isDone && "border-green-500/20",
        isError && "border-red-500/20",
        isCancelled && "border-amber-500/20",
        isProcessing && "border-orange-500/15",
      )}
    >
      {/* Glow */}
      <div
        className={cn(
          "absolute top-0 right-0 w-40 h-40 blur-[60px] rounded-full pointer-events-none opacity-20",
          isDone && "bg-green-500",
          isError && "bg-red-500",
          isCancelled && "bg-amber-500",
          isProcessing && "bg-orange-500",
        )}
      />

      <div className="flex items-center justify-between gap-4 relative z-10">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded bg-zinc-800">
            {videoId ? (
              <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} className="h-full w-full object-cover" alt="Thumbnail" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-zinc-900">
                <Youtube className="h-4 w-4 text-white/20" />
              </div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
            <div className="absolute bottom-1 right-1">
              {isDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              ) : isError ? (
                <AlertCircle className="w-3.5 h-3.5 text-red-400" />
              ) : isCancelled ? (
                <X className="w-3.5 h-3.5 text-amber-400" />
              ) : (
                <Loader2 className="w-3.5 h-3.5 text-orange-400 animate-spin" />
              )}
            </div>
          </div>
          
          <div className="flex flex-col min-w-0">
            <span className="text-[13px] font-semibold text-white truncate">
              {title}
            </span>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[11px] text-zinc-400 font-mono">
                {job.label}
              </span>
              {isQueued && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-amber-500/20 text-amber-300">
                  {queuePosition ? `Q#${queuePosition}` : "Queued"}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isProcessing && (
            <button
              onClick={() => onCancel(job.jobId)}
              disabled={isCancelling}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all",
                "border-amber-500/40 text-amber-300",
                isCancelling
                  ? "bg-amber-500/10 opacity-70 cursor-not-allowed"
                  : "bg-amber-500/15 hover:bg-amber-500/25",
              )}
            >
              <X className="w-3 h-3" />
              {isCancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
          {isDone && (
            <button
              onClick={() => onDownload(job)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/15 hover:bg-green-500/25 border border-green-500/30 text-green-300 text-xs font-semibold transition-all"
            >
              <Download className="w-3 h-3" />
              Save
            </button>
          )}
          {(isDone || isError || isCancelled) && (
            <button
              onClick={() => onRemove(job.jobId)}
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/30 hover:text-white/70 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

"""
content = content.replace(clipJobCardOld, clipJobCardNew)

newHelpers = """
const titleCache = new Map<string, string>();

function useVideoTitle(url: string, defaultTitle: string) {
  const [title, setTitle] = useState(() => {
    return titleCache.get(url) || defaultTitle;
  });

  useEffect(() => {
    if (titleCache.has(url)) {
      setTitle(titleCache.get(url)!);
      return;
    }
    let active = true;
    async function fetchTitle() {
      try {
        const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.title && active) {
          titleCache.set(url, data.title);
          setTitle(data.title);
        }
      } catch {}
    }
    void fetchTitle();
    return () => { active = false; };
  }, [url]);

  return title;
}

function RecentClipRow({
  entry,
  onDownload,
  onDelete,
}: {
  entry: ClipHistoryEntry;
  onDownload: (entry: ClipHistoryEntry) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const videoId = extractVideoId(entry.url);
  const title = useVideoTitle(entry.url, entry.label);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 8 }}
      className="glass-panel rounded-xl px-4 py-3 flex items-center gap-4 relative"
    >
      <div className="relative h-[42px] w-[74px] shrink-0 overflow-hidden rounded-md bg-zinc-800">
        {videoId ? (
          <img src={`https://img.youtube.com/vi/${videoId}/mqdefault.jpg`} className="h-full w-full object-cover" alt="Thumbnail" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
            <Film className="h-4 w-4 text-white/20" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-white/90 text-[13px] font-semibold truncate">{title}</p>
        <p className="text-zinc-500 text-[11px] mt-0.5 truncate">
          {formatDuration(entry.durationSecs)} • {entry.quality === "best" ? "Best quality" : `${entry.quality}p`}
          {entry.filesize ? ` • ${formatFilesize(entry.filesize)}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span className="text-[11px] text-zinc-500 hidden sm:block">{formatClipRelativeTime(entry.createdAt)}</span>
        <div className="relative">
          <button onClick={() => setMenuOpen(!menuOpen)} className="p-1 text-zinc-500 hover:text-white transition rounded-md hover:bg-white/10">
            <MoreVertical className="h-4 w-4" />
          </button>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 5 }}
                transition={{ duration: 0.1 }}
                className="absolute right-0 top-8 z-30 w-32 rounded-xl border border-zinc-800 bg-[#0d0d0d] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
              >
                <button
                  type="button"
                  onClick={() => { onDownload(entry); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition"
                >
                  <Download className="h-3.5 w-3.5" /> Save
                </button>
                <button
                  type="button"
                  onClick={() => { onDelete(); setMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-red-400 hover:bg-red-500/10 hover:text-red-300 transition"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
"""
content += newHelpers

with open(r'artifacts/yt-downloader/src/components/ClipCutter.tsx', 'w', encoding='utf-8') as f:
    f.write(content)
