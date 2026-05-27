// Phase 5 — Full settings editor:
//   * Master thumbnail prompt (textarea)
//   * Per-clip analysis instructions (textarea)
//   * Speaker images (drag-drop upload, max 5, with name labels + delete)
//   * Reference thumbnails (drag-drop upload, max 10, with delete)

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cog,
  Image as ImageIcon,
  Users,
  Upload,
  X,
  Loader2,
  Check,
  Plus,
  Save,
} from "lucide-react";
import {
  getPitajiSettings,
  savePitajiSettings,
  uploadSpeakerImage,
  deleteSpeakerImage,
  uploadReferenceImage,
  deleteReferenceImage,
  type PitajiSettings as PitajiSettingsT,
} from "@/lib/pitaji-api";

type Speaker = PitajiSettingsT["speakers"][number];
type Reference = PitajiSettingsT["references"][number];

export default function PitajiSettings() {
  const [settings, setSettings] = useState<PitajiSettingsT | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [thumbPrompt, setThumbPrompt] = useState("");
  const [clipInstructions, setClipInstructions] = useState("");
  const [uploading, setUploading] = useState<"speaker" | "reference" | null>(null);

  // New speaker form
  const [newSpeakerLabel, setNewSpeakerLabel] = useState("");
  const speakerFileRef = useRef<HTMLInputElement>(null);
  const referenceFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getPitajiSettings();
      setSettings(s);
      setThumbPrompt(s.thumbnailPrompt ?? "");
      setClipInstructions(s.clipInstructions ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      await savePitajiSettings({ thumbnailPrompt: thumbPrompt, clipInstructions });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const handleSpeakerUpload = async (file: File) => {
    const label = newSpeakerLabel.trim() || file.name.replace(/\.[^.]+$/, "");
    setUploading("speaker");
    setError("");
    try {
      const dataUrl = await fileToDataUrl(file);
      await uploadSpeakerImage(label, dataUrl);
      // Refresh settings
      const fresh = await getPitajiSettings();
      setSettings(fresh);
      setNewSpeakerLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
      if (speakerFileRef.current) speakerFileRef.current.value = "";
    }
  };

  const handleReferenceUpload = async (file: File) => {
    setUploading("reference");
    setError("");
    try {
      const dataUrl = await fileToDataUrl(file);
      await uploadReferenceImage(dataUrl);
      const fresh = await getPitajiSettings();
      setSettings(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(null);
      if (referenceFileRef.current) referenceFileRef.current.value = "";
    }
  };

  const handleDeleteSpeaker = async (id: string) => {
    try {
      await deleteSpeakerImage(id);
      const fresh = await getPitajiSettings();
      setSettings(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleDeleteReference = async (id: string) => {
    try {
      await deleteReferenceImage(id);
      const fresh = await getPitajiSettings();
      setSettings(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const speakers = settings?.speakers ?? [];
  const references = settings?.references ?? [];

  return (
    <section className="pj-settings">
      <header className="pj-settings-header">
        <div>
          <p className="pj-eyebrow">Workspace</p>
          <h1 className="pj-h1">
            <Cog size={22} strokeWidth={2} aria-hidden /> Settings
          </h1>
          <p className="pj-settings-subtitle">
            Configure the analysis prompt and thumbnail generation parameters.
          </p>
        </div>
        <button
          type="button"
          className="pj-button-primary"
          disabled={saving || loading}
          onClick={handleSave}
        >
          {saving ? (
            <Loader2 size={14} className="pj-spin" />
          ) : saved ? (
            <Check size={14} strokeWidth={2.5} />
          ) : (
            <Save size={14} strokeWidth={2} />
          )}
          <span>{saving ? "Saving…" : saved ? "Saved!" : "Save prompts"}</span>
        </button>
      </header>

      {error ? <div className="pj-alert">{error}</div> : null}

      <div className="pj-settings-grid">
        {/* Thumbnail prompt */}
        <article className="pj-settings-card pj-settings-card--wide">
          <h3>Master thumbnail prompt</h3>
          <p className="pj-settings-help">
            One prompt used for every clip&apos;s thumbnail. Speaker face and reference style images are
            added automatically.
          </p>
          <textarea
            className="pj-settings-textarea"
            rows={6}
            value={thumbPrompt}
            onChange={(e) => setThumbPrompt(e.target.value)}
            placeholder="e.g. Create a professional, eye-catching YouTube thumbnail with bold typography…"
            disabled={loading}
          />
        </article>

        {/* Clip instructions */}
        <article className="pj-settings-card pj-settings-card--wide">
          <h3>Per-clip analysis instructions</h3>
          <p className="pj-settings-help">
            Optional extra guidance appended to the analysis prompt — e.g. to emphasise certain topics or
            skip certain categories.
          </p>
          <textarea
            className="pj-settings-textarea"
            rows={4}
            value={clipInstructions}
            onChange={(e) => setClipInstructions(e.target.value)}
            placeholder="e.g. Always extract spiritual discourses as Topics, not Q&A…"
            disabled={loading}
          />
        </article>

        {/* Speaker images */}
        <article className="pj-settings-card">
          <h3>
            <Users size={16} strokeWidth={2} aria-hidden /> Speaker images
          </h3>
          <p className="pj-settings-help">
            Up to 5 portraits the thumbnail agent can choose from. Name each speaker.
          </p>

          <div className="pj-settings-images">
            {speakers.map((s) => (
              <div key={s.id} className="pj-settings-image-chip">
                <div className="pj-settings-image-avatar" title={s.label}>
                  {s.url ? (
                    <img src={s.url} alt="" loading="lazy" />
                  ) : (
                    s.label?.charAt(0)?.toUpperCase() ?? "?"
                  )}
                </div>
                <span className="pj-settings-image-label">{s.label}</span>
                <button
                  type="button"
                  className="pj-settings-image-delete"
                  onClick={() => handleDeleteSpeaker(s.id)}
                  title="Remove"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>

          {speakers.length < 5 ? (
            <div className="pj-settings-upload-row">
              <input
                className="pj-settings-input-sm"
                placeholder="Speaker name"
                value={newSpeakerLabel}
                onChange={(e) => setNewSpeakerLabel(e.target.value)}
              />
              <input
                ref={speakerFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="pj-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleSpeakerUpload(f);
                }}
              />
              <button
                type="button"
                className="pj-button-ghost"
                disabled={uploading === "speaker"}
                onClick={() => speakerFileRef.current?.click()}
              >
                {uploading === "speaker" ? (
                  <Loader2 size={13} className="pj-spin" />
                ) : (
                  <Plus size={13} strokeWidth={2} />
                )}
                <span>{uploading === "speaker" ? "Uploading…" : "Add speaker"}</span>
              </button>
            </div>
          ) : (
            <p className="pj-settings-count">5 / 5 — maximum reached</p>
          )}
        </article>

        {/* Reference thumbnails */}
        <article className="pj-settings-card">
          <h3>
            <ImageIcon size={16} strokeWidth={2} aria-hidden /> Reference thumbnails
          </h3>
          <p className="pj-settings-help">
            Up to 10 reference designs the thumbnail agent can match the style of.
          </p>

          <div className="pj-settings-images">
            {references.map((r) => (
              <div key={r.id} className="pj-settings-image-chip">
                <div className="pj-settings-image-avatar pj-settings-image-avatar--ref">
                  {r.url ? (
                    <img src={r.url} alt="" loading="lazy" />
                  ) : (
                    <ImageIcon size={14} strokeWidth={2} />
                  )}
                </div>
                <span className="pj-settings-image-label">{r.id.slice(0, 10)}</span>
                <button
                  type="button"
                  className="pj-settings-image-delete"
                  onClick={() => handleDeleteReference(r.id)}
                  title="Remove"
                >
                  <X size={12} strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>

          {references.length < 10 ? (
            <div className="pj-settings-upload-row">
              <input
                ref={referenceFileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="pj-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleReferenceUpload(f);
                }}
              />
              <button
                type="button"
                className="pj-button-ghost"
                disabled={uploading === "reference"}
                onClick={() => referenceFileRef.current?.click()}
              >
                {uploading === "reference" ? (
                  <Loader2 size={13} className="pj-spin" />
                ) : (
                  <Upload size={13} strokeWidth={2} />
                )}
                <span>{uploading === "reference" ? "Uploading…" : "Add reference"}</span>
              </button>
            </div>
          ) : (
            <p className="pj-settings-count">10 / 10 — maximum reached</p>
          )}
        </article>
      </div>
    </section>
  );
}
