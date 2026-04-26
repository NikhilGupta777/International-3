import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, Languages, Mic, MicOff, Play, Download, CheckCircle,
  Loader2, AlertCircle, X, ChevronDown, Subtitles, RefreshCw,
  Film, Wand2, Volume2, Eye
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const API  = `${BASE}/api/translator`;

// ── Language options ──────────────────────────────────────────────────────────
const LANGS = [
  {code:"auto",name:"Auto-detect"},
  {code:"en",name:"English"},{code:"es",name:"Spanish"},{code:"fr",name:"French"},
  {code:"de",name:"German"},{code:"pt",name:"Portuguese"},{code:"it",name:"Italian"},
  {code:"ja",name:"Japanese"},{code:"ko",name:"Korean"},{code:"zh",name:"Chinese"},
  {code:"ar",name:"Arabic"},{code:"ru",name:"Russian"},{code:"hi",name:"Hindi"},
  {code:"nl",name:"Dutch"},{code:"pl",name:"Polish"},{code:"tr",name:"Turkish"},
  {code:"uk",name:"Ukrainian"},{code:"vi",name:"Vietnamese"},{code:"id",name:"Indonesian"},
  {code:"fil",name:"Filipino"},{code:"fi",name:"Finnish"},
];
const TARGET_LANGS = LANGS.filter(l => l.code !== "auto");

// ── Step config ───────────────────────────────────────────────────────────────
const STEP_ICONS: Record<string, React.ReactNode> = {
  audio_extraction: <Volume2 className="w-4 h-4" />,
  transcription:    <Subtitles className="w-4 h-4" />,
  translation:      <Languages className="w-4 h-4" />,
  voice_generation: <Mic className="w-4 h-4" />,
  lip_sync:         <Film className="w-4 h-4" />,
  video_merge:      <Wand2 className="w-4 h-4" />,
};
const STEP_COLORS: Record<string, string> = {
  completed: "text-green-400 border-green-500/30 bg-green-500/8",
  running:   "text-blue-400  border-blue-500/30  bg-blue-500/8",
  failed:    "text-red-400   border-red-500/30   bg-red-500/8",
  skipped:   "text-white/30  border-white/10     bg-white/3",
  pending:   "text-white/40  border-white/10     bg-white/3",
};

// ── Select component ──────────────────────────────────────────────────────────
function LangSelect({ value, onChange, options, label, id }: {
  value: string; onChange: (v: string) => void;
  options: typeof LANGS; label: string; id: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-white/40 font-medium uppercase tracking-wider">{label}</label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full appearance-none bg-white/[0.06] border border-white/[0.1] rounded-xl
                     px-4 py-2.5 pr-8 text-sm text-white/90 focus:outline-none focus:border-primary/60
                     cursor-pointer transition-colors"
        >
          {options.map(l => (
            <option key={l.code} value={l.code} className="bg-[#1a1a1a] text-white">{l.name}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
      </div>
    </div>
  );
}

// ── Step card ─────────────────────────────────────────────────────────────────
function StepCard({ step }: { step: any }) {
  const colorClass = STEP_COLORS[step.status] ?? STEP_COLORS.pending;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex items-center gap-3 px-4 py-3 rounded-xl border transition-all", colorClass)}
    >
      <span className="shrink-0">{STEP_ICONS[step.name] ?? <Wand2 className="w-4 h-4"/>}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{step.label}</span>
          {step.status === "running" && step.progress != null && (
            <span className="text-xs font-mono opacity-70">{step.progress}%</span>
          )}
        </div>
        {step.message && (
          <p className="text-xs opacity-60 truncate mt-0.5">{step.message}</p>
        )}
        {step.status === "running" && step.progress != null && (
          <div className="mt-2 h-1 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-blue-400 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${step.progress}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        )}
      </div>
      <span className="shrink-0">
        {step.status === "completed" && <CheckCircle className="w-4 h-4 text-green-400" />}
        {step.status === "running"   && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
        {step.status === "failed"    && <AlertCircle className="w-4 h-4 text-red-400" />}
      </span>
    </motion.div>
  );
}

// ── Transcript panel ──────────────────────────────────────────────────────────
function TranscriptPanel({ segments }: { segments: any[] }) {
  if (!segments.length) return null;
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
        <Subtitles className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-white/80">Transcript</span>
        <span className="text-xs text-white/30 ml-auto">{segments.length} segments</span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {segments.map((s, i) => (
          <div key={i} className="px-4 py-2 border-b border-white/[0.04] last:border-0">
            <div className="flex items-start gap-3">
              <span className="text-[10px] text-white/30 font-mono shrink-0 mt-0.5">
                {String(Math.floor(s.start/60)).padStart(2,"0")}:{String(Math.floor(s.start%60)).padStart(2,"0")}
              </span>
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="text-xs text-white/50 line-through">{s.originalText}</p>
                <p className="text-sm text-white/90">{s.translatedText}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Drop zone ─────────────────────────────────────────────────────────────────
function DropZone({ onFile, disabled }: { onFile: (f: File) => void; disabled?: boolean }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault(); setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f && !disabled) onFile(f);
      }}
      className={cn(
        "relative flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed",
        "cursor-pointer transition-all duration-200 py-16 px-8",
        dragging ? "border-primary/70 bg-primary/8 scale-[1.01]"
                 : "border-white/[0.12] hover:border-white/25 bg-white/[0.02] hover:bg-white/[0.04]",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <div className="w-16 h-16 rounded-2xl bg-white/[0.06] border border-white/[0.1] flex items-center justify-center">
        <Upload className="w-7 h-7 text-white/50" />
      </div>
      <div className="text-center">
        <p className="text-base font-semibold text-white/80">Drop your video here</p>
        <p className="text-sm text-white/40 mt-1">MP4, MOV, MKV, AVI, WebM · Max 2GB</p>
      </div>
      <input ref={inputRef} type="file" accept=".mp4,.mov,.mkv,.avi,.webm" className="hidden"
             onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function VideoTranslator() {
  const [file, setFile]             = useState<File | null>(null);
  const [srcLang, setSrcLang]       = useState("auto");
  const [tgtLang, setTgtLang]       = useState("en");
  const [voiceStyle, setVoiceStyle] = useState<"original"|"female">("original");
  const [lipSync, setLipSync]       = useState(false);
  const [jobId, setJobId]           = useState<string | null>(null);
  const [job, setJob]               = useState<any>(null);
  const [transcript, setTranscript] = useState<any[]>([]);
  const [uploading, setUploading]   = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll job status from DynamoDB via API
  const pollStatus = useCallback(async (id: string) => {
    try {
      const r = await fetch(`${API}/status/${id}`);
      if (!r.ok) return;
      const data = await r.json();
      setJob(data);
      if (data.status === "DONE") {
        clearInterval(pollRef.current!);
        // Fetch transcript JSON
        const tr = await fetch(`${API}/result/${id}`);
        if (tr.ok) {
          const result = await tr.json();
          // Fetch and parse the transcript JSON from S3 presigned URL
          if (result.transcriptUrl) {
            const tj = await fetch(result.transcriptUrl);
            if (tj.ok) {
              const parsed = await tj.json();
              setTranscript(parsed.segments ?? []);
            }
          }
          setJob((prev: any) => ({ ...prev, ...result }));
        }
      } else if (data.status === "FAILED") {
        clearInterval(pollRef.current!);
        setError(data.error ?? "Translation failed");
      }
    } catch (e: any) {
      setError(e?.message);
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    pollRef.current = setInterval(() => pollStatus(jobId), 3000);
    pollStatus(jobId);
    return () => clearInterval(pollRef.current!);
  }, [jobId, pollStatus]);

  const handleUpload = async () => {
    if (!file) return;
    setError(null); setUploading(true); setJob(null); setTranscript([]);
    try {
      // Step 1: Get S3 presigned PUT URL
      const ext = file.name.split(".").pop() ?? "mp4";
      const presignRes = await fetch(
        `${API}/presign?filename=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type || "video/mp4")}`
      );
      const { jobId: newJobId, presignedUrl, s3Key } = await presignRes.json();
      if (!presignRes.ok) throw new Error("Failed to get upload URL");

      // Step 2: Upload directly to S3
      const uploadRes = await fetch(presignedUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "video/mp4" },
      });
      if (!uploadRes.ok) throw new Error("S3 upload failed");

      // Step 3: Submit Batch job
      const submitRes = await fetch(`${API}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: newJobId,
          s3Key,
          targetLang: TARGET_LANGS.find(l => l.code === tgtLang)?.name ?? tgtLang,
          targetLangCode: tgtLang,
          sourceLang: srcLang,
          voiceClone: voiceStyle === "original",
          lipSync,
          lipSyncQuality: "musetalk",
        }),
      });
      const submitData = await submitRes.json();
      if (!submitRes.ok) throw new Error(submitData.error ?? "Submit failed");

      setJobId(newJobId);
    } catch (e: any) {
      setError(e?.message);
    } finally {
      setUploading(false);
    }
  };

  const reset = () => {
    clearInterval(pollRef.current!);
    setFile(null); setJobId(null); setJob(null);
    setTranscript([]); setError(null); setShowTranscript(false);
  };

  const isProcessing = job && !["DONE","FAILED"].includes(job.status);
  const isDone       = job?.status === "DONE";
  const overallPct   = job?.progress ?? 0;


  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full px-4 py-8 flex flex-col gap-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Languages className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Video Translator</h1>
            <p className="text-sm text-white/40">GPU-powered voice cloning · 20 languages</p>
          </div>
          {jobId && (
            <button onClick={reset} className="ml-auto p-2 rounded-xl bg-white/6 hover:bg-white/10 text-white/50 hover:text-white transition-colors">
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Error */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{opacity:0,y:-8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}}
              className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-300 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)}><X className="w-4 h-4" /></button>
            </motion.div>
          )}
        </AnimatePresence>

        {!jobId ? (
          <>
            {/* Drop zone */}
            <DropZone onFile={setFile} disabled={uploading} />
            {file && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.05] border border-white/[0.08]">
                <Film className="w-4 h-4 text-primary shrink-0" />
                <span className="text-sm text-white/80 flex-1 truncate">{file.name}</span>
                <span className="text-xs text-white/40">{(file.size/1024/1024).toFixed(1)} MB</span>
                <button onClick={() => setFile(null)} className="text-white/30 hover:text-white/70 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Settings */}
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <LangSelect id="src-lang" label="Source Language" value={srcLang}
                            onChange={setSrcLang} options={LANGS} />
                <LangSelect id="tgt-lang" label="Target Language" value={tgtLang}
                            onChange={setTgtLang} options={TARGET_LANGS} />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-white/40 font-medium uppercase tracking-wider">Voice Style</label>
                <div className="flex gap-2">
                  {(["original","female"] as const).map(s => (
                    <button key={s} onClick={() => setVoiceStyle(s)}
                      className={cn("flex-1 py-2.5 rounded-xl text-sm font-medium border transition-all",
                        voiceStyle===s
                          ? "bg-primary/20 border-primary/50 text-primary"
                          : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:text-white/80")}>
                      {s==="original" ? "🎤 Clone Original" : "👩 Neural Female"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-3 cursor-pointer select-none">
                <div onClick={() => setLipSync(!lipSync)}
                  className={cn("w-10 h-6 rounded-full transition-all relative",
                    lipSync ? "bg-primary" : "bg-white/20")}>
                  <div className={cn("absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all",
                    lipSync ? "left-[18px]" : "left-0.5")} />
                </div>
                <div>
                  <p className="text-sm text-white/80 font-medium">Lip Sync (Wav2Lip)</p>
                  <p className="text-xs text-white/40">Match mouth movements to translated audio</p>
                </div>
              </label>
            </div>

            {/* Submit */}
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className={cn(
                "w-full py-3.5 rounded-2xl font-bold text-base flex items-center justify-center gap-2 transition-all",
                file && !uploading
                  ? "bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/25"
                  : "bg-white/10 text-white/30 cursor-not-allowed"
              )}
            >
              {uploading ? <><Loader2 className="w-5 h-5 animate-spin" /> Uploading…</> : <><Languages className="w-5 h-5" /> Translate Video</>}
            </button>
          </>
        ) : (
          <>
            {/* Overall progress */}
            {isProcessing && (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-5">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-semibold text-white/80">Translating…</span>
                  <span className="text-sm font-mono text-white/50">{overallPct.toFixed(0)}%</span>
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <motion.div className="h-full bg-gradient-to-r from-primary to-orange-400 rounded-full"
                    animate={{ width: `${overallPct}%` }} transition={{ duration: 0.6 }} />
                </div>
              </div>
            )}

            {/* Steps */}
            {job?.steps && (
              <div className="flex flex-col gap-2">
                {job.steps.map((s: any) => <StepCard key={s.name} step={s} />)}
              </div>
            )}

            {/* Done */}
            {isDone && (
              <motion.div initial={{opacity:0,scale:0.97}} animate={{opacity:1,scale:1}}
                className="rounded-2xl border border-green-500/25 bg-green-500/8 p-5 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-6 h-6 text-green-400" />
                  <div>
                    <p className="font-bold text-green-300">Translation Complete!</p>
                    <p className="text-xs text-white/40 mt-0.5">{file?.name}</p>
                  </div>
                </div>
                {job?.videoUrl && (
                  <video
                    src={job.videoUrl}
                    controls
                    className="w-full rounded-xl bg-black aspect-video"
                  />
                )}
                <div className="flex gap-3">
                  {job?.videoUrl && (
                    <a href={job.videoUrl} download="translated_video.mp4"
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-white text-sm transition-all"
                      style={{background:"linear-gradient(135deg,#16a34a,#15803d)",boxShadow:"0 4px 16px rgba(22,163,74,0.3)"}}>
                      <Download className="w-4 h-4" /> Download Video
                    </a>
                  )}
                  {job?.srtUrl && (
                    <a href={job.srtUrl} download="subtitles.srt"
                      className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                      <Subtitles className="w-4 h-4" /> SRT
                    </a>
                  )}
                  <button onClick={() => setShowTranscript(!showTranscript)}
                    className="px-4 py-3 rounded-xl bg-white/8 hover:bg-white/12 border border-white/10 text-white/60 text-sm flex items-center gap-2 transition-colors">
                    <Eye className="w-4 h-4" /> Transcript
                  </button>
                </div>
              </motion.div>
            )}


            {/* Transcript */}
            {showTranscript && transcript.length > 0 && (
              <TranscriptPanel segments={transcript} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
