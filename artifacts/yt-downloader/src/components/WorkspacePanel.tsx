/**
 * WorkspacePanel — slide-in drawer for the agent's persistent workspace.
 *
 * Tabs:
 *   - Files: list workspace files, upload new ones (presigned PUT), delete, copy share link
 *   - Drive: browse the allowed Google Drive folder, import into workspace
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X, Upload, RefreshCw, Trash2, Copy, Check, FolderOpen, FileText,
  Image as ImageIcon, Film, Music, FileArchive, Loader2, ChevronRight,
  CloudDownload, AlertTriangle, ArrowLeft, Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  workspaceApi,
  formatBytes,
  type WorkspaceFile,
  type WorkspaceInfo,
  type DriveFile,
} from "@/lib/workspace-api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Tab = "files" | "drive";

type Props = {
  open: boolean;
  onClose: () => void;
};

function pickFileIcon(name: string, contentType?: string) {
  const lower = name.toLowerCase();
  const cls = "w-4 h-4 text-white/60 shrink-0";
  if (contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return <ImageIcon className={cls} />;
  if (contentType?.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/.test(lower)) return <Film className={cls} />;
  if (contentType?.startsWith("audio/") || /\.(mp3|wav|m4a|flac|ogg)$/.test(lower)) return <Music className={cls} />;
  if (/\.(zip|tar|gz|7z)$/.test(lower)) return <FileArchive className={cls} />;
  return <FileText className={cls} />;
}

export function WorkspacePanel({ open, onClose }: Props) {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("files");
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Drive state
  const [driveReady, setDriveReady] = useState<boolean | null>(null);
  const [driveReason, setDriveReason] = useState<string | null>(null);
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [driveStack, setDriveStack] = useState<{ id?: string; name: string }[]>([{ name: "Drive Root" }]);
  const [loadingDrive, setLoadingDrive] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);

  // Preview state
  const [previewFile, setPreviewFile] = useState<{ path: string; url: string; type: string } | null>(null);

  // ── Initial load ────────────────────────────────────────────────────────
  const refreshFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const listing = await workspaceApi.listFiles("", 200);
      setFiles(listing.files);
    } catch (err) {
      toast({ title: "Failed to load workspace", description: (err as Error).message, variant: "destructive" });
    } finally {
      setLoadingFiles(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    workspaceApi.info().then(setInfo).catch(() => { /* non-fatal */ });
    refreshFiles();
  }, [open, refreshFiles]);

  // ── Drive load ──────────────────────────────────────────────────────────
  const loadDrive = useCallback(async (folderId?: string) => {
    setLoadingDrive(true);
    try {
      const status = await workspaceApi.driveStatus();
      if (!status.configured || status.reachable === false) {
        setDriveReady(false);
        setDriveReason(status.reason ?? "Google Drive connector is not configured.");
        return;
      }
      setDriveReady(true);
      const listing = await workspaceApi.driveList({ folderId, pageSize: 100 });
      setDriveFiles(listing.files);
    } catch (err) {
      setDriveReady(false);
      setDriveReason((err as Error).message);
    } finally {
      setLoadingDrive(false);
    }
  }, []);

  useEffect(() => {
    if (open && tab === "drive") loadDrive(driveStack[driveStack.length - 1]?.id);
  }, [open, tab, driveStack, loadDrive]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const onPickFile = () => fileInputRef.current?.click();

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const maxBytes = info?.adapters.s3.limits.MAX_FILE_BYTES ?? 1024 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast({ title: "File too large", description: `Limit: ${formatBytes(maxBytes)}`, variant: "destructive" });
      return;
    }

    const safeName = file.name.replace(/[^\w.\-() ]/g, "_").slice(0, 160);
    const path = `uploads/${safeName}`;

    setUploading(true);
    setUploadProgress(0);
    try {
      await workspaceApi.uploadFile(path, file, setUploadProgress);
      toast({ title: "Uploaded", description: path });
      await refreshFiles();
    } catch (err) {
      toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDelete = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    try {
      await workspaceApi.deleteFile(path);
      setFiles((prev) => prev.filter((f) => f.path !== path));
      toast({ title: "Deleted", description: path });
    } catch (err) {
      toast({ title: "Delete failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handleCopyLink = async (path: string) => {
    try {
      try {
        const { content } = await workspaceApi.readText(path);
        await navigator.clipboard.writeText(content);
        toast({ title: "Copied", description: "File contents copied to clipboard" });
      } catch {
        // Fallback for binary files
        const { url } = await workspaceApi.getFile(path);
        await navigator.clipboard.writeText(url);
        toast({ title: "Copied Link", description: "Copied URL for binary file" });
      }
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(null), 1500);
    } catch (err) {
      toast({ title: "Could not copy", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handleDownload = async (path: string) => {
    try {
      toast({ title: "Downloading...", description: path });
      const { url } = await workspaceApi.getFile(path);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = path.split("/").pop() || "download";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      toast({ title: "Download failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handlePreview = async (path: string) => {
    try {
      const { url, stat } = await workspaceApi.getFile(path, { inline: true });
      const fileExt = path.split('.').pop()?.toLowerCase() || '';
      const type = stat.contentType || (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fileExt) ? 'image' : 
                                        ['mp4', 'webm', 'mov'].includes(fileExt) ? 'video' : 'text');
      setPreviewFile({ path, url, type });
    } catch (err) {
      toast({ title: "Preview failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handleDriveImport = async (f: DriveFile) => {
    if (f.isFolder) {
      setDriveStack((prev) => [...prev, { id: f.id, name: f.name }]);
      return;
    }
    const safeName = f.name.replace(/[^\w.\-() ]/g, "_").slice(0, 160);
    const path = `drive-imports/${safeName}`;
    setImportingId(f.id);
    try {
      await workspaceApi.driveImport(f.id, path);
      toast({ title: "Imported from Drive", description: path });
      if (tab === "files") refreshFiles();
    } catch (err) {
      toast({ title: "Import failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setImportingId(null);
    }
  };

  const driveBreadcrumb = useMemo(
    () => driveStack.map((s) => s.name).join(" / "),
    [driveStack],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 bg-black/50 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed top-0 right-0 bottom-0 w-full sm:w-[420px] bg-[#111] border-l border-white/10 z-50 flex flex-col shadow-2xl"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 280 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-white/70" />
                <div className="text-sm font-semibold text-white/90">Workspace</div>
                {info && (
                  <div className="text-[10px] text-white/40">
                    {info.authMethod}
                  </div>
                )}
              </div>
              <button
                onClick={onClose}
                className="text-white/40 hover:text-white p-1 rounded"
                aria-label="Close workspace"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/10 shrink-0">
              <button
                onClick={() => setTab("files")}
                className={`flex-1 px-4 py-2.5 text-xs font-medium transition-colors ${
                  tab === "files" ? "text-white border-b-2 border-white" : "text-white/50 hover:text-white/80"
                }`}
              >
                Files
              </button>
              <button
                onClick={() => setTab("drive")}
                className={`flex-1 px-4 py-2.5 text-xs font-medium transition-colors ${
                  tab === "drive" ? "text-white border-b-2 border-white" : "text-white/50 hover:text-white/80"
                }`}
              >
                Google Drive
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {tab === "files" ? (
                <div className="p-3 space-y-2">
                  {/* Upload row */}
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      onClick={onPickFile}
                      disabled={uploading}
                      className="flex items-center gap-2 px-3 py-2 bg-white text-black rounded-lg text-xs font-medium disabled:opacity-40 hover:bg-white/90"
                    >
                      {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                      {uploading ? `Uploading ${(uploadProgress * 100).toFixed(0)}%` : "Upload file"}
                    </button>
                    <button
                      onClick={refreshFiles}
                      disabled={loadingFiles}
                      className="p-2 text-white/50 hover:text-white rounded"
                      aria-label="Refresh"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingFiles ? "animate-spin" : ""}`} />
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleUpload}
                    />
                  </div>

                  {/* Empty state */}
                  {!loadingFiles && files.length === 0 && (
                    <div className="text-center py-12 text-white/40 text-xs">
                      <FolderOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
                      Workspace is empty.<br />Upload a file or ask the agent to save something.
                    </div>
                  )}

                  {/* File list */}
                  {files.map((f) => (
                    <div
                      key={f.path}
                      className="flex items-center gap-2 px-2 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-lg border border-white/5"
                    >
                      {pickFileIcon(f.path, f.contentType)}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-white/90 truncate">{f.path}</div>
                        <div className="text-[10px] text-white/40">
                          {formatBytes(f.size)} · {new Date(f.modifiedAt).toLocaleString()}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handlePreview(f.path)}
                          className="p-2 text-white/60 hover:text-white rounded-md hover:bg-white/10"
                          title="Preview"
                          aria-label={`Preview ${f.path}`}
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleCopyLink(f.path)}
                          className="p-2 text-white/60 hover:text-white rounded-md hover:bg-white/10"
                          title="Copy share link"
                          aria-label={`Copy link for ${f.path}`}
                        >
                          {copiedPath === f.path ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={() => handleDownload(f.path)}
                          className="p-2 text-white/60 hover:text-white rounded-md hover:bg-white/10"
                          title="Download"
                          aria-label={`Download ${f.path}`}
                        >
                          <CloudDownload className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(f.path)}
                          className="p-2 text-white/60 hover:text-red-400 rounded-md hover:bg-red-500/10"
                          title="Delete"
                          aria-label={`Delete ${f.path}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-3 space-y-2">
                  {driveReady === false && (
                    <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-200">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-medium mb-1">Drive not connected</div>
                        <div className="text-amber-200/70">{driveReason}</div>
                      </div>
                    </div>
                  )}

                  {driveReady && (
                    <>
                      {/* Breadcrumb */}
                      <div className="flex items-center gap-2 mb-2">
                        {driveStack.length > 1 && (
                          <button
                            onClick={() => setDriveStack((prev) => prev.slice(0, -1))}
                            className="p-1 text-white/50 hover:text-white"
                            aria-label="Back"
                          >
                            <ArrowLeft className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <div className="text-[10px] text-white/50 truncate flex-1">{driveBreadcrumb}</div>
                        <button
                          onClick={() => loadDrive(driveStack[driveStack.length - 1]?.id)}
                          disabled={loadingDrive}
                          className="p-1 text-white/50 hover:text-white"
                          aria-label="Refresh"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${loadingDrive ? "animate-spin" : ""}`} />
                        </button>
                      </div>

                      {!loadingDrive && driveFiles.length === 0 && (
                        <div className="text-center py-12 text-white/40 text-xs">
                          Folder is empty.
                        </div>
                      )}

                      {driveFiles.map((f) => (
                        <button
                          key={f.id}
                          onClick={() => handleDriveImport(f)}
                          disabled={importingId === f.id}
                          className="w-full flex items-center gap-2 px-2 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-lg border border-white/5 text-left disabled:opacity-50"
                        >
                          {f.isFolder ? <FolderOpen className="w-4 h-4 text-white/60 shrink-0" /> : pickFileIcon(f.name, f.mimeType)}
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-white/90 truncate">{f.name}</div>
                            <div className="text-[10px] text-white/40">
                              {f.isFolder ? "Folder" : `${f.size ? formatBytes(f.size) : "—"} · ${f.mimeType.split("/").pop()}`}
                            </div>
                          </div>
                          {f.isFolder ? (
                            <ChevronRight className="w-3.5 h-3.5 text-white/40 shrink-0" />
                          ) : importingId === f.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-white/60 shrink-0" />
                          ) : (
                            <CloudDownload className="w-3.5 h-3.5 text-white/40 shrink-0" />
                          )}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-white/10 text-[10px] text-white/40 shrink-0">
              Files persist across chats · isolated per user
            </div>
          </motion.aside>

          {/* Preview Dialog */}
          <Dialog open={!!previewFile} onOpenChange={(open) => !open && setPreviewFile(null)}>
            <DialogContent className="max-w-4xl w-[90vw] h-[85vh] flex flex-col bg-[#111] border-white/10 text-white">
              <DialogHeader>
                <DialogTitle className="truncate">{previewFile?.path.split('/').pop()}</DialogTitle>
              </DialogHeader>
              <div className="flex-1 min-h-0 relative bg-white/5 rounded-md overflow-hidden flex items-center justify-center">
                {previewFile?.type.startsWith('image') || ['png','jpg','jpeg','gif','webp'].some(ext => previewFile?.path.toLowerCase().endsWith(ext)) ? (
                  <img src={previewFile.url} className="w-full h-full object-contain" alt="preview" />
                ) : previewFile?.type.startsWith('video') || ['mp4','webm','mov'].some(ext => previewFile?.path.toLowerCase().endsWith(ext)) ? (
                  <video src={previewFile.url} controls className="w-full h-full object-contain" autoPlay />
                ) : (
                  <iframe src={previewFile?.url} className="w-full h-full border-0 bg-white" title="preview" sandbox="allow-scripts allow-same-origin" />
                )}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </AnimatePresence>
  );
}
