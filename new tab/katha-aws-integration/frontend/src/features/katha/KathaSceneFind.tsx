import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Check, ImagePlus, Loader2, MapPin, Pencil, RefreshCw,
  Search, Sparkles, Trash2, Upload, X,
} from "lucide-react";
import {
  createKathaReference, deleteKathaPlace, deleteKathaReference, getKathaUploadUrl,
  identifyKatha, KathaMatch, KathaReference, listKathaReferences, MAX_BATCH_FILES,
  MAX_FILE_MB, updateKathaPlace, uploadToSignedUrl,
} from "../../lib/katha-api";
import { compressImage, mapWithConcurrency } from "../../lib/image-utils";

type Tab = "identify" | "library";
type Toast = { type: "success" | "error"; text: string } | null;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" | "danger" }) {
  const { className, tone = "ghost", ...rest } = props;
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
        tone === "primary" && "bg-amber-600 text-white hover:bg-amber-700",
        tone === "ghost" && "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50",
        tone === "danger" && "bg-red-600 text-white hover:bg-red-700",
        className,
      )}
    />
  );
}

function useObjectUrls(files: File[]) {
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);
  return urls;
}

export default function KathaSceneFind() {
  const [tab, setTab] = useState<Tab>("identify");
  const [references, setReferences] = useState<KathaReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  async function loadRefs() {
    setLoading(true);
    try {
      const data = await listKathaReferences();
      setReferences(data.references || []);
    } catch (error: any) {
      setToast({ type: "error", text: error.message || "Failed to load references" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadRefs(); }, []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  return (
    <section className="min-h-screen bg-slate-50 text-slate-950">
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-600 text-white shadow-sm">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold">Katha Scene Find</h1>
            <p className="text-xs text-slate-500">AI venue matching from your reference library</p>
          </div>
          <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 sm:inline-flex">
            {references.length} images
          </span>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 grid max-w-md grid-cols-2 rounded-lg bg-slate-200 p-1">
          <button onClick={() => setTab("identify")} className={cx("rounded-md px-3 py-2 text-sm font-medium", tab === "identify" && "bg-white shadow-sm")}>Identify</button>
          <button onClick={() => setTab("library")} className={cx("rounded-md px-3 py-2 text-sm font-medium", tab === "library" && "bg-white shadow-sm")}>Library ({references.length})</button>
        </div>

        {tab === "identify" ? (
          <IdentifyPanel references={references} onOpenLightbox={setLightbox} onToast={setToast} />
        ) : (
          <div className="space-y-6">
            <AddReferencePanel onAdded={loadRefs} onToast={setToast} />
            <LibraryPanel references={references} loading={loading} onChanged={loadRefs} onOpenLightbox={setLightbox} onToast={setToast} />
          </div>
        )}
      </main>

      {toast && (
        <div className={cx("fixed left-1/2 top-4 z-50 max-w-[92vw] -translate-x-1/2 rounded-lg px-4 py-3 text-sm shadow-lg", toast.type === "error" ? "bg-red-600 text-white" : "bg-emerald-600 text-white")}>
          {toast.text}
        </div>
      )}

      {lightbox && (
        <button className="fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4" onClick={() => setLightbox(null)} aria-label="Close image preview">
          <img src={lightbox} alt="Preview" className="max-h-full max-w-full rounded-lg object-contain" />
        </button>
      )}
    </section>
  );
}

function IdentifyPanel({ references, onOpenLightbox, onToast }: { references: KathaReference[]; onOpenLightbox: (src: string) => void; onToast: (toast: Toast) => void }) {
  const [queryFile, setQueryFile] = useState<File | null>(null);
  const [queryPreview, setQueryPreview] = useState<string | null>(null);
  const [queryDataUrl, setQueryDataUrl] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [results, setResults] = useState<KathaMatch[] | null>(null);
  const [analysis, setAnalysis] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      onToast({ type: "error", text: `Image too large. Max ${MAX_FILE_MB}MB.` });
      return;
    }
    setQueryFile(file);
    setResults(null);
    setAnalysis("");
    setLastError(null);
    try {
      const { dataUrl } = await compressImage(file, 1280, 0.85);
      setQueryPreview(dataUrl);
      setQueryDataUrl(dataUrl);
    } catch (error: any) {
      onToast({ type: "error", text: error.message || "Could not read image" });
    }
  }

  async function identify() {
    if (!queryDataUrl) return onToast({ type: "error", text: "Upload a photo first" });
    if (!references.length) return onToast({ type: "error", text: "Add reference images first" });
    setIdentifying(true);
    setLastError(null);
    try {
      const data = await identifyKatha(queryDataUrl, references);
      setResults(data.matches || []);
      setAnalysis(data.overall_analysis || "");
      onToast({ type: "success", text: `Identification complete in ${((data.elapsed_ms || 0) / 1000).toFixed(1)}s` });
    } catch (error: any) {
      setLastError(error.message || "Identification failed");
      onToast({ type: "error", text: error.message || "Identification failed" });
    } finally {
      setIdentifying(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) handleFile(file); }}
          onClick={() => inputRef.current?.click()}
          className="cursor-pointer rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:border-amber-500"
        >
          {queryPreview ? (
            <img src={queryPreview} alt="Query" className="mx-auto max-h-72 w-auto rounded-lg shadow" />
          ) : (
            <div className="py-8">
              <ImagePlus className="mx-auto mb-2 h-10 w-10 text-slate-400" />
              <p className="text-sm font-medium">Click or drop an image</p>
              <p className="mt-1 text-xs text-slate-500">JPG/PNG · max {MAX_FILE_MB}MB</p>
            </div>
          )}
          <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleFile(file); e.currentTarget.value = ""; }} />
        </div>

        <div className="mt-4 flex gap-2">
          <Button tone="primary" onClick={identify} disabled={!queryFile || identifying || references.length === 0} className="flex-1 py-3">
            {identifying ? <><Loader2 className="h-4 w-4 animate-spin" /> Analyzing {references.length}…</> : <><Sparkles className="h-4 w-4" /> Identify location</>}
          </Button>
          {queryPreview && <Button onClick={() => { setQueryFile(null); setQueryPreview(null); setQueryDataUrl(null); setResults(null); }}><X className="h-4 w-4" /></Button>}
          {results && <Button onClick={identify}><RefreshCw className="h-4 w-4" /></Button>}
        </div>

        {identifying && <div className="mt-4 rounded-lg bg-slate-100 p-3 text-sm text-slate-600"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Comparing venue details…</div>}
        {lastError && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertTriangle className="mr-2 inline h-4 w-4" />{lastError}</div>}
      </div>

      {results && results.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold">Match results</h2>
          {analysis && <p className="mt-1 text-sm text-slate-600">{analysis}</p>}
          <div className="mt-4 space-y-4">
            {results.map((match, idx) => (
              <div key={idx} className="rounded-xl border border-slate-200 p-4">
                <div className="mb-3 flex flex-wrap gap-2">
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">#{idx + 1} · {Math.round(match.confidence)}% match</span>
                  {idx === 0 && match.confidence >= 70 && <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">Best match</span>}
                </div>
                <div className="mb-3 grid grid-cols-2 gap-3">
                  {queryPreview && <button onClick={() => onOpenLightbox(queryPreview)}><img src={queryPreview} alt="Query" className="aspect-square w-full rounded-lg object-cover" /></button>}
                  {match.reference && <button onClick={() => onOpenLightbox(match.reference!.image_url)}><img src={match.reference.image_url} alt={match.reference.place_name} className="aspect-square w-full rounded-lg object-cover" /></button>}
                </div>
                <h3 className="text-lg font-semibold">{match.reference?.place_name || "Unknown"}</h3>
                {match.reference?.location && <p className="flex items-center gap-1 text-sm text-slate-500"><MapPin className="h-3 w-3" />{match.reference.location}</p>}
                <p className="mt-3 text-xs font-medium"><Check className="mr-1 inline h-3 w-3" />Matched venue features</p>
                <ul className="mt-1 list-inside list-disc text-xs text-slate-600">
                  {match.matched_features.map((feature, i) => <li key={i}>{feature}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AddReferencePanel({ onAdded, onToast }: { onAdded: () => void; onToast: (toast: Toast) => void }) {
  const [placeName, setPlaceName] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const previewUrls = useObjectUrls(files);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(incoming: File[]) {
    const valid = incoming.filter((file) => file.type.startsWith("image/") && file.size <= MAX_FILE_MB * 1024 * 1024);
    setFiles((prev) => [...prev, ...valid].slice(0, MAX_BATCH_FILES));
  }

  async function uploadAll() {
    if (!placeName.trim()) return onToast({ type: "error", text: "Place name is required" });
    if (!files.length) return onToast({ type: "error", text: "Select at least one image" });
    setUploading(true);
    try {
      const settled = await mapWithConcurrency(files, 4, async (file) => {
        const { blob } = await compressImage(file, 1280, 0.85);
        const signed = await getKathaUploadUrl({ type: "reference", contentType: "image/jpeg" });
        await uploadToSignedUrl(signed.uploadUrl, blob, "image/jpeg");
        await createKathaReference({ place_name: placeName.trim(), location: location.trim() || null, notes: notes.trim() || null, s3_key: signed.s3Key });
      });
      const ok = settled.filter((s) => s.status === "fulfilled").length;
      const failed = settled.length - ok;
      if (ok) onToast({ type: "success", text: `Added ${ok} image(s)` });
      if (failed) onToast({ type: "error", text: `${failed} upload(s) failed` });
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
      onAdded();
    } catch (error: any) {
      onToast({ type: "error", text: error.message || "Upload failed" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold">Add reference images</h2>
      <p className="text-sm text-slate-500">Upload multiple photos for the same venue.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <input value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="Place name *" className="rounded-lg border border-slate-300 px-3 py-2" />
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location / date" className="rounded-lg border border-slate-300 px-3 py-2" />
      </div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes: backdrop, decoration, chair, idols…" rows={2} className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-2" />
      <div onClick={() => inputRef.current?.click()} onDrop={(e) => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); }} onDragOver={(e) => e.preventDefault()} className="mt-4 cursor-pointer rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-5 text-center hover:border-amber-500">
        <Upload className="mx-auto mb-1 h-7 w-7 text-slate-400" />
        <p className="text-sm">{files.length ? `${files.length} file(s) ready` : "Drop or click to add images"}</p>
        <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.currentTarget.value = ""; }} />
      </div>
      {files.length > 0 && <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-6">{files.map((file, i) => <img key={`${file.name}-${i}`} src={previewUrls[i]} alt={file.name} className="aspect-square rounded object-cover" />)}</div>}
      <Button tone="primary" onClick={uploadAll} disabled={uploading || !files.length || !placeName.trim()} className="mt-4">
        {uploading ? <><Loader2 className="h-4 w-4 animate-spin" /> Uploading…</> : <><Upload className="h-4 w-4" /> Add to library</>}
      </Button>
    </div>
  );
}

function LibraryPanel({ references, loading, onChanged, onOpenLightbox, onToast }: { references: KathaReference[]; loading: boolean; onChanged: () => void; onOpenLightbox: (src: string) => void; onToast: (toast: Toast) => void }) {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const grouped = useMemo(() => {
    const map: Record<string, KathaReference[]> = {};
    for (const ref of references) (map[ref.place_name] ||= []).push(ref);
    return map;
  }, [references]);

  const places = Object.entries(grouped).filter(([place, items]) => {
    const q = search.trim().toLowerCase();
    return !q || place.toLowerCase().includes(q) || items.some((item) => `${item.location || ""} ${item.notes || ""}`.toLowerCase().includes(q));
  });

  async function removeOne(ref: KathaReference) {
    if (!confirm("Delete this image?")) return;
    await deleteKathaReference(ref.id);
    onToast({ type: "success", text: "Image deleted" });
    onChanged();
  }

  async function removePlace(place: string) {
    if (!confirm(`Delete all images for ${place}?`)) return;
    await deleteKathaPlace(place);
    onToast({ type: "success", text: "Place deleted" });
    onChanged();
  }

  function startEdit(place: string, items: KathaReference[]) {
    setEditing(place);
    setEditName(place);
    setEditLocation(items[0]?.location || "");
    setEditNotes(items[0]?.notes || "");
  }

  async function saveEdit() {
    if (!editing || !editName.trim()) return;
    await updateKathaPlace({ old_place_name: editing, place_name: editName.trim(), location: editLocation.trim() || null, notes: editNotes.trim() || null });
    setEditing(null);
    onToast({ type: "success", text: "Updated" });
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Saved places ({Object.keys(grouped).length})</h2>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search places…" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3" />
        </div>
      </div>
      {loading ? <div className="py-12 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin" /></div> : places.map(([place, items]) => (
        <div key={place} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold">{place}</h3>
              {items[0]?.location && <p className="flex items-center gap-1 text-sm text-slate-500"><MapPin className="h-3 w-3" />{items[0].location}</p>}
              {items[0]?.notes && <p className="text-xs text-slate-500">{items[0].notes}</p>}
            </div>
            <div className="flex gap-1">
              <Button onClick={() => startEdit(place, items)}><Pencil className="h-4 w-4" /></Button>
              <Button tone="danger" onClick={() => removePlace(place)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-7">
            {items.map((ref) => <div key={ref.id} className="group relative aspect-square"><button onClick={() => onOpenLightbox(ref.image_url)}><img src={ref.image_url} alt={ref.place_name} className="h-full w-full rounded-md object-cover" /></button><button onClick={() => removeOne(ref)} className="absolute right-1 top-1 hidden rounded bg-red-600 p-1 text-white group-hover:block"><Trash2 className="h-3 w-3" /></button></div>)}
          </div>
        </div>
      ))}
      {!loading && places.length === 0 && <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">No references found.</div>}
      {editing && <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"><div className="w-full max-w-md rounded-xl bg-white p-4 shadow-xl"><h3 className="text-lg font-semibold">Edit place</h3><input value={editName} onChange={(e) => setEditName(e.target.value)} className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2" /><input value={editLocation} onChange={(e) => setEditLocation(e.target.value)} className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2" /><textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={2} className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2" /><div className="mt-4 flex justify-end gap-2"><Button onClick={() => setEditing(null)}>Cancel</Button><Button tone="primary" onClick={saveEdit}>Save</Button></div></div></div>}
    </div>
  );
}
