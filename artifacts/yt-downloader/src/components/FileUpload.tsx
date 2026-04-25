import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload, Cloud, Link2, Copy, Check, Eye, XOctagon,
  FileText, Film, Music, Image, Archive, File,
  Download, Globe, Lock, Trash2, ChevronDown, ChevronUp,
  CheckCircle2, AlertCircle, Loader2, X, FolderHeart, Info
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const BASE_URL = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

// ── helpers ─────────────────────────────────────────────────────────────────
function fmtBytes(n: number) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}
function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
function fileIcon(mime: string) {
  const cls = "w-5 h-5";
  if (mime.startsWith("video/"))       return <Film className={cls} />;
  if (mime.startsWith("audio/"))       return <Music className={cls} />;
  if (mime.startsWith("image/"))       return <Image className={cls} />;
  if (mime.includes("pdf"))            return <FileText className={cls} />;
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("rar")) return <Archive className={cls} />;
  return <File className={cls} />;
}
function fileColor(mime: string) {
  if (mime.startsWith("video/")) return "text-violet-400";
  if (mime.startsWith("audio/")) return "text-emerald-400";
  if (mime.startsWith("image/")) return "text-blue-400";
  if (mime.includes("pdf"))      return "text-red-400";
  return "text-white/50";
}

const MAX_SIZE = 3 * 1024 * 1024 * 1024;
const PART_SIZE = 10 * 1024 * 1024;
const CONCURRENCY = 4;

// ── Multipart upload engine ──────────────────────────────────────────────────
async function uploadPart(
  signedUrl: string, chunk: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const handleAbort = () => { xhr.abort(); reject(new Error("aborted")); };
    signal.addEventListener("abort", handleAbort);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      signal.removeEventListener("abort", handleAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.getResponseHeader("ETag") ?? "").replace(/"/g, ""));
      } else reject(new Error(`Part ${xhr.status}`));
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", handleAbort);
      reject(new Error("Network error"));
    };
    xhr.open("PUT", signedUrl);
    xhr.send(chunk);
  });
}

async function uploadSingle(
  url: string, file: File, mime: string,
  onProgress: (pct: number, loaded: number) => void,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const handleAbort = () => { xhr.abort(); reject(new Error("aborted")); };
    signal.addEventListener("abort", handleAbort);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100), e.loaded); };
    xhr.onload = () => {
      signal.removeEventListener("abort", handleAbort);
      xhr.status < 300 ? resolve() : reject(new Error(`Upload ${xhr.status}`));
    };
    xhr.onerror = () => {
      signal.removeEventListener("abort", handleAbort);
      reject(new Error("Network error"));
    };
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.send(file);
  });
}

// ── Types ────────────────────────────────────────────────────────────────────
interface PublicFile {
  fileId: string;
  filename: string;
  title: string;
  description: string;
  size: number;
  mimeType: string;
  visibility: "public" | "private";
  uploadedAt: number;
  downloadCount: number;
}

type Tab = "upload" | "my-uploads" | "gallery";

// ── Local Storage Helpers ────────────────────────────────────────────────────
function saveLocalUpload(file: PublicFile) {
  try {
    const existing = JSON.parse(localStorage.getItem("videomaking_uploads") || "[]");
    localStorage.setItem("videomaking_uploads", JSON.stringify([file, ...existing]));
  } catch { /* ignore */ }
}
function getLocalUploads(): PublicFile[] {
  try {
    return JSON.parse(localStorage.getItem("videomaking_uploads") || "[]");
  } catch { return []; }
}
function removeLocalUpload(fileId: string) {
  try {
    const existing = getLocalUploads();
    localStorage.setItem("videomaking_uploads", JSON.stringify(existing.filter((x: any) => x.fileId !== fileId)));
  } catch { /* ignore */ }
}

// ── Main Component ───────────────────────────────────────────────────────────
export function FileUpload() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("upload");

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [showMeta, setShowMeta] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speedStr, setSpeedStr] = useState("");
  const [etaStr, setEtaStr] = useState("");
  const [done, setDone] = useState<{ shareUrl: string; fileId: string; filename: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Gallery / My Uploads state
  const [gallery, setGallery] = useState<PublicFile[]>([]);
  const [myUploads, setMyUploads] = useState<PublicFile[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();

  const loadGallery = useCallback(async (cursor?: string) => {
    setGalleryLoading(true);
    try {
      const cursorQuery = cursor ? "&cursor=" + cursor : "";
      const url = `${BASE_URL()}/api/uploads/public?limit=24${cursorQuery}`;
      const res = await fetch(url);
      const data = await res.json() as { files: PublicFile[]; nextCursor?: string };
      setGallery(prev => cursor ? [...prev, ...data.files] : data.files);
      setNextCursor(data.nextCursor);
    } catch { /* ignore */ }
    finally { setGalleryLoading(false); }
  }, []);

  useEffect(() => { 
    if (tab === "gallery") loadGallery(); 
    if (tab === "my-uploads") setMyUploads(getLocalUploads());
  }, [tab, loadGallery]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) { if (f.size > MAX_SIZE) { setError("File exceeds 3 GB limit."); return; } setFile(f); setError(null); }
  }, []);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { if (f.size > MAX_SIZE) { setError("File exceeds 3 GB limit."); return; } setFile(f); setError(null); }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setUploading(false);
      setError("Upload cancelled.");
    }
  };

  const handleUpload = async () => {
    if (!file || uploading) return;
    setUploading(true); setProgress(0); setError(null); setDone(null);
    setSpeedStr("calculating..."); setEtaStr("...");
    
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const signal = abortController.signal;
    const startTime = Date.now();
    let lastUpdate = startTime;

    const updateStats = (loadedBytes: number) => {
      const now = Date.now();
      const elapsed = (now - startTime) / 1000;
      if (elapsed > 1 && now - lastUpdate > 500) {
        const speedBps = loadedBytes / elapsed;
        setSpeedStr(`${fmtBytes(speedBps)}/s`);
        const remainingBytes = file.size - loadedBytes;
        const etaSecs = Math.max(0, remainingBytes / Math.max(speedBps, 1));
        if (etaSecs > 60) setEtaStr(`${Math.ceil(etaSecs / 60)} mins left`);
        else setEtaStr(`${Math.ceil(etaSecs)} secs left`);
        lastUpdate = now;
      }
    };

    try {
      // 1. Presign
      const initRes = await fetch(`${BASE_URL()}/api/uploads/presign`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, size: file.size, mimeType: file.type || "application/octet-stream", visibility, title, description }),
        signal
      });
      if (!initRes.ok) { const e = await initRes.json().catch(() => ({})); throw new Error((e as any).error ?? "Init failed"); }
      const init = await initRes.json() as any;

      // 2. Upload
      if (init.uploadType === "single") {
        await uploadSingle(init.presignedUrl, file, file.type || "application/octet-stream", (pct, loaded) => {
          setProgress(pct); updateStats(loaded);
        }, signal);
        setProgress(99);
      } else {
        // Multipart — upload CONCURRENCY parts at a time
        const parts = init.parts as { partNumber: number; signedUrl: string }[];
        const results: { partNumber: number; etag: string }[] = [];
        let uploadedBytes = 0;

        for (let i = 0; i < parts.length; i += CONCURRENCY) {
          if (signal.aborted) throw new Error("aborted");
          const batch = parts.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async (p) => {
            const start = (p.partNumber - 1) * PART_SIZE;
            const chunk = file.slice(start, start + PART_SIZE);
            let partLoaded = 0;
            const etag = await uploadPart(p.signedUrl, chunk, (loaded) => {
              const diff = loaded - partLoaded;
              partLoaded = loaded;
              updateStats(uploadedBytes + diff);
              setProgress(Math.min(98, Math.round((uploadedBytes + diff) / file.size * 100)));
            }, signal);
            uploadedBytes += chunk.size;
            results.push({ partNumber: p.partNumber, etag });
          }));
          setProgress(Math.min(98, Math.round(uploadedBytes / file.size * 100)));
        }
        results.sort((a, b) => a.partNumber - b.partNumber);
        setProgress(99);

        // 3. Complete multipart
        const compRes = await fetch(`${BASE_URL()}/api/uploads/complete`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: init.fileId, parts: results }),
          signal
        });
        if (!compRes.ok) throw new Error("Complete failed");
        const comp = await compRes.json() as any;
        setProgress(100);
        const frontendShareUrl = `${window.location.origin}${BASE_URL()}/api/uploads/file/${comp.fileId}`;
        setDone({ shareUrl: frontendShareUrl, fileId: comp.fileId, filename: comp.filename, size: comp.size });
        saveLocalUpload({ fileId: comp.fileId, filename: comp.filename, title, description, size: comp.size, mimeType: file.type || "application/octet-stream", visibility, uploadedAt: Date.now(), downloadCount: 0 });
        setUploading(false); return;
      }

      // Complete single
      const compRes = await fetch(`${BASE_URL()}/api/uploads/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: init.fileId }),
        signal
      });
      if (!compRes.ok) throw new Error("Complete failed");
      const comp = await compRes.json() as any;
      setProgress(100);
      const frontendShareUrl = `${window.location.origin}${BASE_URL()}/api/uploads/file/${comp.fileId}`;
      setDone({ shareUrl: frontendShareUrl, fileId: comp.fileId, filename: comp.filename, size: comp.size });
      saveLocalUpload({ fileId: comp.fileId, filename: comp.filename, title, description, size: comp.size, mimeType: file.type || "application/octet-stream", visibility, uploadedAt: Date.now(), downloadCount: 0 });
    } catch (err) {
      if ((err as Error).message === "aborted" || signal.aborted) {
        setError("Upload cancelled.");
      } else {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    } finally {
      setUploading(false);
    }
  };

  const copyLink = () => {
    if (!done) return;
    navigator.clipboard.writeText(done.shareUrl).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000);
      toast({ title: "Link copied!", description: done.shareUrl });
    });
  };

  const reset = () => {
    setFile(null); setTitle(""); setDescription(""); setVisibility("public");
    setShowMeta(false); setProgress(0); setDone(null); setError(null); setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.10)"}}>
          <Cloud className="w-5 h-5 text-white/70" />
        </div>
        <div className="flex-1">
          <h2 className="text-base font-semibold text-white tracking-tight">File Share</h2>
          <p className="text-xs" style={{color:"rgba(255,255,255,0.40)"}}>Upload any file up to 3 GB — get a shareable link</p>
        </div>
        <div className="px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)"}}>
           <Info className="w-3.5 h-3.5 text-amber-400" />
           <span className="text-[10px] font-medium text-white/50 tracking-wide uppercase">Auto-deletes in 7 days</span>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-lg" style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)"}}>
        <button onClick={() => setTab("upload")} className={cn("flex-1 py-1.5 text-xs font-medium rounded-md transition-all", tab === "upload" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70")}>↑ Upload</button>
        <button onClick={() => setTab("my-uploads")} className={cn("flex-1 py-1.5 text-xs font-medium rounded-md transition-all", tab === "my-uploads" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70")}>Folder My Uploads</button>
        <button onClick={() => setTab("gallery")} className={cn("flex-1 py-1.5 text-xs font-medium rounded-md transition-all", tab === "gallery" ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70")}>⊞ Public Gallery</button>
      </div>

      <AnimatePresence mode="wait">

        {/* ── Upload Tab ── */}
        {tab === "upload" && (
          <motion.div key="upload" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0}} className="space-y-4">

            {/* Success state */}
            {done && (
              <div className="rounded-xl p-5 space-y-4" style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.10)"}}>
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-white">Upload complete!</p>
                    <p className="text-xs" style={{color:"rgba(255,255,255,0.45)"}}>{done.filename} · {fmtBytes(done.size)}</p>
                  </div>
                </div>
                <div className="rounded-lg p-3 flex items-center gap-2" style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.08)"}}>
                  <Link2 className="w-4 h-4 shrink-0" style={{color:"rgba(255,255,255,0.40)"}} />
                  <span className="flex-1 text-xs font-mono truncate" style={{color:"rgba(255,255,255,0.70)"}}>{done.shareUrl}</span>
                  <button onClick={copyLink}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all"
                    style={{background: copied ? "rgba(52,211,153,0.2)" : "rgba(255,255,255,0.08)", color: copied ? "#6ee7b7" : "rgba(255,255,255,0.70)"}}>
                    {copied ? <><Check className="w-3.5 h-3.5"/>Copied</> : <><Copy className="w-3.5 h-3.5"/>Copy link</>}
                  </button>
                </div>
                <button onClick={reset} className="text-xs underline" style={{color:"rgba(255,255,255,0.35)"}}>Upload another file</button>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="rounded-xl p-4 flex gap-3" style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.20)"}}>
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-red-300">{error}</p>
                  <button onClick={() => setError(null)} className="mt-1 text-xs text-red-400/70 underline">Dismiss</button>
                </div>
              </div>
            )}

            {/* Drop zone — hidden when done */}
            {!done && (
              <>
                <div
                  onClick={() => !uploading && fileInputRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  className={cn("relative rounded-xl cursor-pointer transition-all duration-200 flex flex-col items-center justify-center gap-3 py-10 px-6 text-center",
                    dragging ? "scale-[1.01]" : "")}
                  style={{
                    background: dragging ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.03)",
                    border: `2px dashed ${dragging ? "rgba(255,255,255,0.30)" : file ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.10)"}`,
                  }}
                >
                  <input ref={fileInputRef} type="file" className="hidden" onChange={handleFile} disabled={uploading} />
                  {file ? (
                    <>
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{background:"rgba(255,255,255,0.07)"}}>
                        <span className={fileColor(file.type)}>{fileIcon(file.type)}</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-white/90 max-w-xs truncate">{file.name}</p>
                        <p className="text-xs mt-0.5" style={{color:"rgba(255,255,255,0.40)"}}>{fmtBytes(file.size)} · {file.type || "unknown type"}</p>
                      </div>
                      {!uploading && (
                        <button onClick={e => { e.stopPropagation(); reset(); }}
                          className="absolute top-3 right-3 p-1.5 rounded-lg transition-colors"
                          style={{background:"rgba(255,255,255,0.06)"}}>
                          <X className="w-3.5 h-3.5 text-white/50" />
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{background:"rgba(255,255,255,0.05)"}}>
                        <Upload className="w-5 h-5 text-white/40" />
                      </div>
                      <div>
                        <p className="text-sm font-medium" style={{color:"rgba(255,255,255,0.70)"}}>Drop file here or <span className="text-white underline">browse</span></p>
                        <p className="text-xs mt-0.5" style={{color:"rgba(255,255,255,0.30)"}}>Any file type · Up to 3 GB</p>
                      </div>
                    </>
                  )}
                </div>

                {/* Options row */}
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Visibility toggle */}
                  <button onClick={() => setVisibility(v => v === "public" ? "private" : "public")} disabled={uploading}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
                    style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)", color:"rgba(255,255,255,0.65)"}}>
                    {visibility === "public"
                      ? <><Globe className="w-3.5 h-3.5 text-emerald-400"/>Public</>
                      : <><Lock className="w-3.5 h-3.5 text-amber-400"/>Private</>}
                  </button>

                  {/* Meta toggle */}
                  <button onClick={() => setShowMeta(v => !v)} disabled={uploading}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
                    style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.45)"}}>
                    {showMeta ? <ChevronUp className="w-3.5 h-3.5"/> : <ChevronDown className="w-3.5 h-3.5"/>}
                    Add details
                  </button>
                </div>

                {/* Meta fields */}
                <AnimatePresence>
                  {showMeta && (
                    <motion.div initial={{opacity:0,height:0}} animate={{opacity:1,height:"auto"}} exit={{opacity:0,height:0}} className="space-y-2 overflow-hidden">
                      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (optional)" disabled={uploading}
                        className="w-full px-4 py-2.5 rounded-lg text-sm text-white placeholder-white/25 bg-white/5 border border-white/10 outline-none focus:border-white/25 transition-colors disabled:opacity-50" />
                      <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional)" rows={3} disabled={uploading}
                        className="w-full px-4 py-2.5 rounded-lg text-sm text-white placeholder-white/25 bg-white/5 border border-white/10 outline-none focus:border-white/25 transition-colors resize-none disabled:opacity-50" />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Progress bar */}
                {uploading && (
                  <div>
                    <div className="flex justify-between items-end text-xs mb-1.5">
                      <div className="flex flex-col gap-1">
                        <span className="flex items-center gap-1.5" style={{color:"rgba(255,255,255,0.65)"}}>
                          <Loader2 className="w-3 h-3 animate-spin text-white/50"/>
                          Uploading{file && file.size > 50*1024*1024 ? " (multipart)…" : "…"}
                        </span>
                        <span style={{color:"rgba(255,255,255,0.30)"}} className="ml-4.5">{speedStr} · {etaStr}</span>
                      </div>
                      <span style={{color:"rgba(255,255,255,0.55)"}}>{progress}%</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="h-1.5 rounded-full overflow-hidden flex-1" style={{background:"rgba(255,255,255,0.08)"}}>
                        <motion.div className="h-full rounded-full" style={{background:"rgba(255,255,255,0.70)"}}
                          animate={{width:`${progress}%`}} transition={{ease:"easeOut",duration:0.4}} />
                      </div>
                      <button onClick={handleCancel} title="Cancel Upload" className="p-1.5 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
                        <XOctagon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Upload button */}
                {!uploading && (
                  <button
                    onClick={handleUpload}
                    disabled={!file}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{background: file ? "rgba(255,255,255,0.90)" : "rgba(255,255,255,0.08)", color: file ? "#111" : "rgba(255,255,255,0.40)"}}>
                    {!file ? "Select a file to upload" : `Upload ${fmtBytes(file.size)} · ${visibility}`}
                  </button>
                )}
              </>
            )}
          </motion.div>
        )}

        {/* ── My Uploads Tab ── */}
        {tab === "my-uploads" && (
          <motion.div key="my-uploads" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0}} className="space-y-3">
            {myUploads.length === 0 ? (
              <div className="py-16 text-center text-sm" style={{color:"rgba(255,255,255,0.30)"}}>You haven't uploaded anything yet.</div>
            ) : (
              <>
                {myUploads.map(f => <GalleryCard key={f.fileId} file={f} onDelete={() => {
                  removeLocalUpload(f.fileId);
                  setMyUploads(getLocalUploads());
                  toast({ title: "Deleted", description: f.filename });
                }} />)}
              </>
            )}
          </motion.div>
        )}

        {/* ── Gallery Tab ── */}
        {tab === "gallery" && (
          <motion.div key="gallery" initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0}} className="space-y-3">
            {galleryLoading && gallery.length === 0 ? (
              <div className="flex items-center justify-center py-16 gap-2 text-sm" style={{color:"rgba(255,255,255,0.30)"}}>
                <Loader2 className="w-4 h-4 animate-spin"/><span>Loading…</span>
              </div>
            ) : gallery.length === 0 ? (
              <div className="py-16 text-center text-sm" style={{color:"rgba(255,255,255,0.30)"}}>No public files yet. Be the first to upload!</div>
            ) : (
              <>
                {gallery.map(f => <GalleryCard key={f.fileId} file={f} onDelete={() => {
                  setGallery(g => g.filter(x => x.fileId !== f.fileId));
                  toast({ title: "Deleted", description: f.filename });
                }} />)}
                {nextCursor && (
                  <button onClick={() => loadGallery(nextCursor)} disabled={galleryLoading}
                    className="w-full py-2 rounded-xl text-xs font-medium transition-all"
                    style={{background:"rgba(255,255,255,0.05)",color:"rgba(255,255,255,0.50)"}}>
                    {galleryLoading ? "Loading…" : "Load more"}
                  </button>
                )}
              </>
            )}
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}

// ── Gallery card ─────────────────────────────────────────────────────────────
function GalleryCard({ file, onDelete }: { file: PublicFile; onDelete: () => void }) {
  const BASE = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const canPreview = file.mimeType.startsWith("image/") || file.mimeType.startsWith("video/");

  const handlePreview = async () => {
    if (previewUrl) {
      setPreviewing(true);
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch(`${BASE()}/api/uploads/file/${file.fileId}?preview=1`);
      const data = await res.json() as { downloadUrl: string };
      setPreviewUrl(data.downloadUrl);
      setPreviewing(true);
    } catch { /* ignore */ }
    finally { setDownloading(false); }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`${BASE()}/api/uploads/file/${file.fileId}`);
      const data = await res.json() as { downloadUrl: string; filename: string };
      const a = document.createElement("a");
      a.href = data.downloadUrl; a.download = data.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch { /* ignore */ }
    finally { setDownloading(false); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await fetch(`${BASE()}/api/uploads/file/${file.fileId}`, { method: "DELETE" });
      onDelete();
    } catch { setDeleting(false); }
  };

  const copyLink = () => {
    const url = `${window.location.origin}${BASE()}/api/uploads/file/${file.fileId}`;
    navigator.clipboard.writeText(url).catch(() => {});
  };

  return (
    <>
      <div className="rounded-xl p-4 flex items-start gap-3 transition-all" style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)"}}>
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => canPreview ? handlePreview() : null} style={{background:"rgba(255,255,255,0.06)"}}>
          <span className={fileColor(file.mimeType)}>{fileIcon(file.mimeType)}</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white/90 truncate">{file.title || file.filename}</p>
          {file.description && <p className="text-xs mt-0.5 line-clamp-1" style={{color:"rgba(255,255,255,0.40)"}}>{file.description}</p>}
          <div className="flex items-center gap-3 mt-1 text-[10px]" style={{color:"rgba(255,255,255,0.30)"}}>
            <span>{file.visibility === "private" ? <><Lock className="w-2.5 h-2.5 inline mr-0.5 text-amber-400"/> Private</> : <><Globe className="w-2.5 h-2.5 inline mr-0.5 text-emerald-400"/> Public</>}</span>
            <span>{fmtBytes(file.size)}</span>
            <span>{fmtTime(file.uploadedAt)}</span>
            {file.downloadCount > 0 && <span><Download className="w-2.5 h-2.5 inline mr-0.5"/>{file.downloadCount}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canPreview && (
            <button onClick={handlePreview} disabled={downloading} title="Preview" className="p-1.5 rounded-lg transition-colors bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/90">
              <Eye className="w-3.5 h-3.5"/>
            </button>
          )}
          <button onClick={copyLink} title="Copy link" className="p-1.5 rounded-lg transition-colors bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/90"><Link2 className="w-3.5 h-3.5"/></button>
          <button onClick={handleDownload} disabled={downloading} title="Download" className="p-1.5 rounded-lg transition-colors bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/90">
            {downloading && !previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <Download className="w-3.5 h-3.5"/>}
          </button>
          <button onClick={handleDelete} disabled={deleting} title="Delete" className="p-1.5 rounded-lg transition-colors hover:bg-red-500/15 text-white/30 hover:text-red-400">
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <Trash2 className="w-3.5 h-3.5"/>}
          </button>
        </div>
      </div>

      {/* Preview Modal */}
      <AnimatePresence>
        {previewing && previewUrl && (
          <motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}} className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 bg-black/90 backdrop-blur-sm" onClick={() => setPreviewing(false)}>
            <div className="relative w-full h-full max-w-5xl flex flex-col items-center justify-center" onClick={e => e.stopPropagation()}>
              <button onClick={() => setPreviewing(false)} className="absolute top-0 right-0 p-3 bg-white/10 hover:bg-white/20 rounded-xl text-white transition-colors z-10">
                <X className="w-6 h-6"/>
              </button>
              {file.mimeType.startsWith("video/") ? (
                <video src={previewUrl} controls autoPlay className="max-w-full max-h-full rounded-lg shadow-2xl" />
              ) : (
                <img src={previewUrl} alt={file.filename} className="max-w-full max-h-full rounded-lg shadow-2xl object-contain" />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
