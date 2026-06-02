import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Trash2, Loader2, Pencil, ImagePlus, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const PRESET_MIN_IMAGES = 5;
const PRESET_MAX_IMAGES = 12;

// Shape returned by GET /api/thumbnail/presets
export type PresetSummary = {
  id: string;
  name: string;
  stylePrompt: string;
  imageCount: number;
  images: Array<{ key: string; url: string }>;
  updatedAt: number;
};

// A locally-held image in the editor (either freshly added base64, or an
// existing one we keep by reference — existing ones can't be re-read, so on
// save we only re-upload images that have base64 `data`).
type DraftImage = {
  id: string;
  previewUrl: string;
  mimeType: string;
  data?: string; // base64 (no prefix) — present only for newly-added images
};

type Draft = { id?: string; name: string; stylePrompt: string; images: DraftImage[] };

// ── Downscale a File to a capped edge, return base64 + preview ──────────────
async function downscale(file: File, maxEdge = 1280, quality = 0.82): Promise<DraftImage> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
  const toResult = (url: string, mime: string): DraftImage => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    previewUrl: url,
    mimeType: mime,
    data: url.includes(",") ? url.split(",")[1] : url,
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("decode failed"));
      im.src = dataUrl;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    if (scale >= 1 && file.size < 600_000) return toResult(dataUrl, file.type || "image/png");
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return toResult(dataUrl, file.type || "image/png");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return toResult(canvas.toDataURL("image/jpeg", quality), "image/jpeg");
  } catch {
    return toResult(dataUrl, file.type || "image/png");
  }
}

export function ThumbnailPresets({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged?: (presets: PresetSummary[]) => void;
}) {
  const { toast } = useToast();
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"list" | "edit">("list");
  const [draft, setDraft] = useState<Draft>({ name: "", stylePrompt: "", images: [] });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/thumbnail/presets`, { credentials: "include" });
      const data = await r.json().catch(() => ({}));
      const rows: PresetSummary[] = Array.isArray(data?.presets) ? data.presets : [];
      setPresets(rows);
      setCanEdit(Boolean(data?.canEdit));
      onChanged?.(rows);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [onChanged]);

  useEffect(() => { if (open) { void refresh(); setView("list"); } }, [open, refresh]);

  const startNew = () => { setDraft({ name: "", stylePrompt: "", images: [] }); setView("edit"); };
  const startEdit = (p: PresetSummary) => {
    setDraft({
      id: p.id,
      name: p.name,
      stylePrompt: p.stylePrompt,
      images: p.images.map((im, i) => ({ id: `${p.id}-${i}`, previewUrl: im.url, mimeType: "image/jpeg" })),
    });
    setView("edit");
  };

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    const room = PRESET_MAX_IMAGES - draft.images.length;
    if (room <= 0) { toast({ title: "Image limit reached", description: `Up to ${PRESET_MAX_IMAGES} images.` }); return; }
    setImporting(true);
    try {
      const take = files.filter(f => f.type.startsWith("image/")).slice(0, room);
      const added: DraftImage[] = [];
      for (const f of take) added.push(await downscale(f));
      setDraft(d => ({ ...d, images: [...d.images, ...added] }));
      if (files.length > take.length) toast({ title: "Some images skipped", description: `Max ${PRESET_MAX_IMAGES} per preset.` });
    } catch {
      toast({ title: "Couldn't import images", variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const removeImage = (id: string) => setDraft(d => ({ ...d, images: d.images.filter(i => i.id !== id) }));

  const canSave = draft.name.trim().length > 0 && draft.images.length >= PRESET_MIN_IMAGES;

  const save = async () => {
    if (!canSave) {
      toast({ title: "Almost there", description: `Add a channel name and at least ${PRESET_MIN_IMAGES} reference images.` });
      return;
    }
    // When editing, images without `data` are existing ones. The API replaces
    // the whole set, so an edit must include base64 for ALL images. If the user
    // didn't re-add existing ones, we keep them by requiring re-upload only when
    // they changed. Simplest robust rule: require all images to have data on save.
    const missing = draft.images.some(im => !im.data);
    if (missing && draft.id) {
      // Existing preset, user kept old images without re-uploading — we can't
      // re-read their bytes from a signed URL reliably across origins, so ask.
      toast({
        title: "Re-add images to update",
        description: "Editing replaces images. Please re-add the reference images you want to keep.",
      });
    }
    setSaving(true);
    try {
      const payload = {
        id: draft.id,
        name: draft.name.trim(),
        stylePrompt: draft.stylePrompt.trim(),
        images: draft.images.filter(im => im.data).map(im => ({ mimeType: im.mimeType, data: im.data })),
      };
      if (payload.images.length < PRESET_MIN_IMAGES) {
        setSaving(false);
        toast({ title: "Add reference images", description: `Need at least ${PRESET_MIN_IMAGES} images with data.` });
        return;
      }
      const r = await fetch(`${BASE}/api/thumbnail/presets`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error || `Save failed (${r.status})`); }
      await refresh();
      setView("list");
      toast({ title: "Preset saved", description: payload.name });
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message ?? "Try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: PresetSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`${BASE}/api/thumbnail/presets/${encodeURIComponent(p.id)}`, { method: "DELETE", credentials: "include" });
      await refresh();
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="tp-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="tp-modal"
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={e => e.stopPropagation()}
          >
            <div className="tp-head">
              <div className="tp-head-title">
                {view === "edit" ? (draft.name.trim() || "New preset") : "Brand presets"}
              </div>
              <button className="tp-icon-btn" onClick={onClose} title="Close" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>

            {view === "list" ? (
              <div className="tp-body">
                <p className="tp-intro">
                  {canEdit
                    ? `Save a channel's look once — name, a style brief, and ${PRESET_MIN_IMAGES}–${PRESET_MAX_IMAGES} reference thumbnails. Anyone can then pick it in the chat to generate on-brand thumbnails.`
                    : "These are the channel brand presets. Pick one in the chat to generate on-brand thumbnails. Only admins can add or edit presets."}
                </p>

                {canEdit && (
                  <button className="tp-new-btn" onClick={startNew}>
                    <Plus className="w-4 h-4" />
                    <span>New preset</span>
                  </button>
                )}

                {loading ? (
                  <div className="tp-empty"><Loader2 className="w-5 h-5 animate-spin" /></div>
                ) : presets.length === 0 ? (
                  <div className="tp-empty">
                    {canEdit ? "No presets yet. Create one to lock in a channel style." : "No brand presets have been set up yet."}
                  </div>
                ) : (
                  <div className="tp-list">
                    {presets.map(p => (
                      <div
                        key={p.id}
                        className={cn("tp-card", !canEdit && "tp-card-readonly")}
                        onClick={() => canEdit && startEdit(p)}
                        role={canEdit ? "button" : undefined}
                        tabIndex={canEdit ? 0 : undefined}
                        onKeyDown={e => { if (canEdit && e.key === "Enter") startEdit(p); }}
                      >
                        <div className="tp-card-thumbs">
                          {p.images.slice(0, 4).map((img, i) => (
                            <img key={i} src={img.url} alt="" />
                          ))}
                          {p.imageCount > 4 && <span className="tp-card-more">+{p.imageCount - 4}</span>}
                        </div>
                        <div className="tp-card-info">
                          <span className="tp-card-name">{p.name}</span>
                          <span className="tp-card-meta">{p.imageCount} reference images</span>
                        </div>
                        {canEdit && (
                          <div className="tp-card-actions">
                            <button className="tp-icon-btn" onClick={(e) => { e.stopPropagation(); startEdit(p); }} title="Edit" aria-label="Edit preset">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button className="tp-icon-btn tp-del" onClick={(e) => remove(p, e)} title="Delete" aria-label="Delete preset">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="tp-body">
                <label className="tp-field">
                  <span className="tp-label">Channel name</span>
                  <input
                    className="tp-input"
                    value={draft.name}
                    onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                    placeholder="e.g. Bhavishya Malika"
                    maxLength={60}
                  />
                </label>

                <label className="tp-field">
                  <span className="tp-label">Style brief <span className="tp-label-hint">(optional but recommended)</span></span>
                  <textarea
                    className="tp-textarea"
                    value={draft.stylePrompt}
                    onChange={e => setDraft(d => ({ ...d, stylePrompt: e.target.value }))}
                    placeholder="Describe the channel's look: colors, fonts, mood, layout, recurring elements, how faces/text are placed…"
                    rows={4}
                    maxLength={1500}
                  />
                </label>

                <div className="tp-field">
                  <span className="tp-label">
                    Reference images
                    <span className={cn("tp-count", draft.images.length < PRESET_MIN_IMAGES && "tp-count-low")}>
                      {draft.images.length}/{PRESET_MAX_IMAGES} · min {PRESET_MIN_IMAGES}
                    </span>
                  </span>
                  {draft.id && (
                    <p className="tp-edit-note">Editing replaces the image set — re-add the references you want to keep.</p>
                  )}
                  <div className="tp-img-grid">
                    {draft.images.map(img => (
                      <div key={img.id} className={cn("tp-img", !img.data && "tp-img-existing")}>
                        <img src={img.previewUrl} alt="" />
                        <button onClick={() => removeImage(img.id)} title="Remove" aria-label="Remove image">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {draft.images.length < PRESET_MAX_IMAGES && (
                      <button
                        className="tp-img-add"
                        onClick={() => fileRef.current?.click()}
                        disabled={importing}
                        title="Add reference images"
                      >
                        {importing ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
                        <span>Add</span>
                      </button>
                    )}
                  </div>
                  <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onPickFiles} />
                </div>
              </div>
            )}

            {view === "edit" && (
              <div className="tp-foot">
                <button className="tp-btn-ghost" onClick={() => setView("list")} disabled={saving}>Cancel</button>
                <button className="tp-btn-primary" onClick={save} disabled={!canSave || saving}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span>Save preset</span>
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
