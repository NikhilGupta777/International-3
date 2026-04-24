import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { compressImage, mapWithConcurrency } from "@/lib/image-utils";
import { useObjectUrls } from "@/hooks/use-object-urls";
import { BUCKET, MAX_BATCH_FILES, MAX_FILE_MB } from "@/lib/katha-types";

const UPLOAD_CONCURRENCY = 4;

interface Props {
  onAdded: () => void;
}

export function AddReferenceForm({ onAdded }: Props) {
  const [placeName, setPlaceName] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const previewUrls = useObjectUrls(files);

  function addFiles(incoming: File[]) {
    const valid: File[] = [];
    let oversized = 0;
    for (const f of incoming) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_FILE_MB * 1024 * 1024) { oversized++; continue; }
      valid.push(f);
    }
    if (oversized) toast.error(`${oversized} file(s) skipped (over ${MAX_FILE_MB}MB)`);
    setFiles((prev) => {
      const merged = [...prev, ...valid];
      if (merged.length > MAX_BATCH_FILES) {
        toast.error(`Max ${MAX_BATCH_FILES} files at a time`);
        return merged.slice(0, MAX_BATCH_FILES);
      }
      return merged;
    });
  }

  async function uploadAll() {
    if (!placeName.trim()) { toast.error("Place name is required"); return; }
    if (files.length === 0) { toast.error("Select at least one image"); return; }

    setUploading(true);
    setProgress({ done: 0, total: files.length });
    let done = 0;
    const failures: string[] = [];

    const settled = await mapWithConcurrency(files, UPLOAD_CONCURRENCY, async (file) => {
      const { blob } = await compressImage(file, 1280, 0.85);
      const path = `refs/${crypto.randomUUID()}.jpg`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
      if (upErr) throw new Error(`${file.name}: ${upErr.message}`);
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const { error: insErr } = await supabase.from("katha_references").insert({
        place_name: placeName.trim(),
        location: location.trim() || null,
        notes: notes.trim() || null,
        image_url: pub.publicUrl,
        storage_path: path,
      });
      if (insErr) throw new Error(`${file.name}: ${insErr.message}`);
      return true;
    }, () => {
      done++;
      setProgress({ done, total: files.length });
    });

    settled.forEach((s, i) => {
      if (s.status === "rejected") failures.push(files[i].name);
    });

    const ok = files.length - failures.length;
    if (ok > 0) toast.success(`Added ${ok} image(s) to "${placeName}"`);
    if (failures.length) toast.error(`${failures.length} failed: ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? "…" : ""}`);

    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
    setUploading(false);
    setProgress({ done: 0, total: 0 });
    onAdded();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add reference images</CardTitle>
        <CardDescription>Upload multiple photos for the same venue. More angles = better identification.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="place">Place name *</Label>
            <Input id="place" value={placeName} onChange={(e) => setPlaceName(e.target.value)}
              placeholder="e.g. Shri Ram Mandir, Ayodhya" />
          </div>
          <div>
            <Label htmlFor="loc">Location / date</Label>
            <Input id="loc" value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Ayodhya, UP · 12 Mar 2024" />
          </div>
        </div>
        <div>
          <Label htmlFor="notes">Notes (optional)</Label>
          <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            placeholder="Distinct features: red velvet vyas peeth, marigold backdrop…" />
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            addFiles(Array.from(e.dataTransfer.files));
          }}
          onClick={() => fileInput.current?.click()}
          className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
            dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 bg-muted/30"
          }`}
        >
          <Upload className="h-7 w-7 mx-auto text-muted-foreground mb-1" />
          <p className="text-sm">
            {files.length > 0 ? `${files.length} file(s) ready` : "Drop or click to add images"}
          </p>
          <p className="text-xs text-muted-foreground">
            Multi-select · max {MAX_FILE_MB}MB each · up to {MAX_BATCH_FILES}
          </p>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; }}
          />
        </div>

        {files.length > 0 && (
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {files.map((f, i) => (
              <div key={i} className="relative aspect-square">
                <img src={previewUrls[i]} alt={f.name} loading="lazy"
                  className="w-full h-full object-cover rounded" />
                <button
                  onClick={() => setFiles((p) => p.filter((_, idx) => idx !== i))}
                  className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center"
                  aria-label={`Remove ${f.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {uploading && progress.total > 0 && (
          <div className="space-y-1">
            <Progress value={(progress.done / progress.total) * 100} />
            <p className="text-xs text-muted-foreground text-center">
              Uploading {progress.done} / {progress.total} (parallel)
            </p>
          </div>
        )}

        <Button
          onClick={uploadAll}
          disabled={uploading || files.length === 0 || !placeName.trim()}
          style={{ background: "var(--gradient-warm)" }}
        >
          {uploading ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Uploading…</>
          ) : (
            <><Upload className="h-4 w-4 mr-2" /> Add to library</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
