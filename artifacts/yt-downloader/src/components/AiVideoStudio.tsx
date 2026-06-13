import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type DragEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  videoEditorApi,
  type EditorProject,
  type EditorProjectSummary,
  type EditorChatEvent,
  type Proposal,
  type ProposalDiffItem,
  type Timeline,
  type EditorJobSummary,
  type EditorChatMessage,
} from "@/lib/video-editor-api";
import { workspaceApi } from "@/lib/workspace-api";
import {
  upsertActiveVideoStudioRender,
  removeActiveVideoStudioRender,
  saveVideoStudioRenderHistory,
} from "@/lib/video-studio-history";

// ─── Types ────────────────────────────────────────────────────────────────────
type ViewState = "landing" | "chat" | "artifact";

type AttachedAsset = {
  id: string;
  name: string;
  type: "video" | "image" | "audio" | "youtube";
  path?: string;
  file?: File;
  url?: string;
  /**
   * Upload progress in 0..1 once an asset is being sent to the workspace.
   * `undefined` means "not in flight"; `1` means "done". The user bubble
   * renders a thin progress bar on each chip while < 1.
   */
  uploadProgress?: number;
  uploadError?: string;
};

type ChatBubble =
  | { kind: "user"; id: string; text: string; assets: AttachedAsset[] }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "thinking"; id: string; steps: string[] }
  | { kind: "system"; id: string; text: string }
  | { kind: "render-progress"; id: string; jobId: string; progress: number; message: string; status: string }
  | {
      kind: "proposal";
      id: string;
      status?: "pending" | "approved" | "rejected";
      proposal: {
        proposalId: string;
        summary: string;
        diff: ProposalDiffItem[];
        timeline: Timeline;
        duration: number;
      };
    }
  | {
      kind: "artifact";
      id: string;
      title: string;
      jobId: string;
      outputPath: string;
      projectId: string;
    }
  | { kind: "tool"; id: string; name: string; message: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Safe UUID generator that falls back when crypto.randomUUID is unavailable
 *  (e.g. iframe / insecure context). */
function safeUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* fallthrough */ }
  // RFC4122 v4 fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function fileTypeFromFile(file: File): AttachedAsset["type"] {
  const mime = (file.type || "").toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  // Fall back to extension when the browser doesn't supply a mime type.
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  return "image";
}

const FEATURE_TILES = [
  { icon: "✂️", title: "Cut & Join Clips", desc: "Trim, join, and rearrange video segments", prefill: "I'll help you cut and join video clips. Upload your videos to start." },
  { icon: "🎨", title: "Add Branding", desc: "Logo, date text, watermarks", prefill: "Upload your video and logo — I'll add branding and polish it." },
  { icon: "📱", title: "Make Reels", desc: "Vertical format for social media", prefill: "Upload your video — I'll make it vertical for Instagram Reels or YouTube Shorts." },
  { icon: "🔗", title: "From YouTube", desc: "Download and edit from a link", prefill: "" },
  { icon: "✨", title: "Clean & Polish", desc: "Trim, fix audio, color grade", prefill: "Upload a video and I'll clean it up — trim dead air, fix audio, color grade." },
];

const CAPABILITY_PILLS: Array<{ key: string; icon: string; label: string }> = [
  { key: "auto-edit", icon: "🎬", label: "Auto Edit" },
  { key: "auto-format", icon: "📐", label: "Auto Format" },
  { key: "auto-brand", icon: "🎨", label: "Auto Brand" },
];

const LAST_VIDEO_STUDIO_PROJECT_KEY = "videomaking-ai-video-studio-last-project-v1";
const STALE_RENDER_MS = 2 * 60_000;

function restoreBubblesFromProject(messages: EditorChatMessage[], project: EditorProject): ChatBubble[] {
  // Build a chronologically-ordered list. Previously the chat messages were
  // listed first and proposals/renders were always appended afterwards, so
  // an old proposal from yesterday would visually appear after today's
  // questions. Tag each bubble with a sort key and merge.
  type Tagged = { ts: number; bubble: ChatBubble };
  const tagged: Tagged[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.role === "user") {
      tagged.push({ ts: m.createdAt, bubble: { kind: "user", id: m.id, text: m.content, assets: [] } });
    } else {
      tagged.push({ ts: m.createdAt, bubble: { kind: "assistant", id: m.id, text: m.content } });
    }
  }

  for (const proposal of project.proposals || []) {
    tagged.push({
      ts: proposal.createdAt,
      bubble: {
        kind: "proposal",
        id: `proposal-${proposal.proposalId}`,
        status: proposal.status === "applied" ? "approved" : proposal.status === "rejected" ? "rejected" : "pending",
        proposal: {
          proposalId: proposal.proposalId,
          summary: proposal.summary,
          diff: proposal.diff || [],
          timeline: proposal.timeline,
          duration: computeTimelineDuration(proposal.timeline),
        },
      },
    });
  }

  // Show up to the 3 most-recent successful renders, oldest-first relative to
  // each other so the newest sits at the bottom of the chat.
  const doneRenders = (project.renders || [])
    .filter((r) => r.status === "done" && r.outputPath)
    .slice(0, 3);
  for (const render of doneRenders) {
    tagged.push({
      ts: render.completedAt ?? render.createdAt ?? 0,
      bubble: {
        kind: "artifact",
        id: `artifact-${render.jobId}`,
        title: project.title || "Rendered Video",
        jobId: render.jobId,
        outputPath: render.outputPath!,
        projectId: project.projectId,
      },
    });
  }

  // Stable sort by timestamp; ties keep insertion order (chat messages first).
  tagged.sort((a, b) => a.ts - b.ts);
  return tagged.map((t) => t.bubble);
}

function computeTimelineDuration(timeline: Timeline): number {
  return timeline.tracks.video.reduce((max, clip) => {
    const sourceDuration = clip.srcOut > clip.srcIn ? clip.srcOut - clip.srcIn : 0;
    return Math.max(max, clip.tlStart + sourceDuration / (clip.speed || 1));
  }, 0);
}

// ─── Component ────────────────────────────────────────────────────────────────
export function AiVideoStudio() {
  const [view, setView] = useState<ViewState>("landing");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<EditorProject | null>(null);
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [inputText, setInputText] = useState("");
  const [attachedAssets, setAttachedAssets] = useState<AttachedAsset[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [applyingProposalId, setApplyingProposalId] = useState<string | null>(null);
  const [showAttachPopover, setShowAttachPopover] = useState(false);
  const [artifactView, setArtifactView] = useState<{
    jobId: string;
    outputPath: string;
    title: string;
    projectId: string;
  } | null>(null);
  const [artifactPreviewUrl, setArtifactPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeCapabilities, setActiveCapabilities] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const [historyProjects, setHistoryProjects] = useState<EditorProjectSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user is currently looking at the bottom. Auto-scroll
  // only fires when this is true so scrolling up to read older messages
  // doesn't yank the user back down each time a new event lands.
  const followBottomRef = useRef<boolean>(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<{ cancel: () => void } | null>(null);
  const projectRef = useRef<EditorProject | null>(null);
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Monotonic session token. Bumped on every project switch / delete /
  // unmount so any in-flight async callback inside startRenderPolling can
  // detect "I'm running for an old project" and bail before it stomps on
  // the bubbles of the *new* project. Without this, switching projects
  // mid-render briefly shows the old render's progress in the new chat.
  const renderPollSessionRef = useRef<number>(0);
  projectRef.current = project;

  // Project restore can load a completed render even when chat history is
  // empty. Surface those renders as artifact cards so refresh/history restore
  // never lands on a blank chat with only the project title.
  useEffect(() => {
    if (!project?.projectId) return;
    const completed = (project.renders || [])
      .filter((r) => r.status === "done" && r.outputPath)
      .slice(0, 3);
    if (!completed.length) return;
    setBubbles((prev) => {
      const existingJobIds = new Set(
        prev
          .filter((b) => b.kind === "artifact")
          .map((b) => (b as Extract<ChatBubble, { kind: "artifact" }>).jobId)
      );
      const missing = completed.filter((r) => !existingJobIds.has(r.jobId));
      if (!missing.length) return prev;
      return [
        ...prev,
        ...missing.map((render) => ({
          kind: "artifact" as const,
          id: `artifact-${render.jobId}`,
          title: project.title || "Rendered Video",
          jobId: render.jobId,
          outputPath: render.outputPath!,
          projectId: project.projectId,
        })),
      ];
    });
  }, [project]);

  // Auto-scroll to bottom on new messages — but only when the user is
  // already at the bottom. Otherwise, respect the user's reading position
  // and surface a "new messages" hint via the bubble pulse instead.
  useEffect(() => {
    if (!followBottomRef.current) return;
    // `instant` for streaming text updates; smooth scroll competing with
    // every chunk causes visible jitter. The browser will still scroll
    // smoothly when the user navigates manually.
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [bubbles]);

  // Track scroll position on the messages container. We're at the "bottom"
  // when within 80px of the end — within one bubble of the floor, which
  // accommodates iOS rubber-banding without flipping the flag.
  const handleMessagesScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followBottomRef.current = distanceFromBottom < 80;
  }, []);

  // Load history when panel opens. Result is cached for HISTORY_CACHE_MS so
  // tapping the icon repeatedly doesn't burn a /projects request each time;
  // the panel still shows live data while a background refresh runs after
  // the cache window has elapsed.
  const historyFetchedAtRef = useRef<number>(0);
  const historyProjectsRef = useRef<EditorProjectSummary[]>([]);
  historyProjectsRef.current = historyProjects;
  useEffect(() => {
    if (!showHistory) return;
    const HISTORY_CACHE_MS = 30_000;
    const fresh = Date.now() - historyFetchedAtRef.current < HISTORY_CACHE_MS;
    // Only show the loading state if we have nothing cached at all.
    if (!fresh && historyProjectsRef.current.length === 0) setHistoryLoading(true);
    if (fresh) return; // skip refresh; user has up-to-date data
    let cancelled = false;
    videoEditorApi.listProjects()
      .then(({ projects }) => {
        if (cancelled) return;
        setHistoryProjects(projects.sort((a, b) => b.updatedAt - a.updatedAt));
        historyFetchedAtRef.current = Date.now();
      })
      .catch(() => { /* keep last-known list rather than blanking it */ })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [showHistory]);

  // Allow Esc to close the history modal even if focus isn't on the panel.
  useEffect(() => {
    if (!showHistory) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowHistory(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHistory]);

  // Load a project from history
  const startRenderPollingRef = useRef<(pid: string, job?: EditorJobSummary) => void>(() => {});
  const resumePollingIfRunning = useCallback((loaded: EditorProject) => {
    const active = loaded.renders?.find((r) => r.status === "pending" || r.status === "running");
    if (!active) return;
    startRenderPollingRef.current(loaded.projectId, active);
  }, []);

  const loadProject = useCallback(async (pid: string) => {
    try {
      // Cancel any in-flight stream / poll for the previous project before
      // replacing state. Stops a phantom progress bubble from another project.
      streamRef.current?.cancel();
      streamRef.current = null;
      if (renderPollRef.current) {
        clearInterval(renderPollRef.current);
        renderPollRef.current = null;
      }
      // Old polling callback may already be awaiting a fetch — ensure it
      // can detect the project switch and bail.
      renderPollSessionRef.current += 1;
      const { project: loaded } = await videoEditorApi.getProject(pid);
      setProjectId(loaded.projectId);
      setProject(loaded);
      setBubbles([]);
      setShowHistory(false);
      setView("chat");
      // Loading a project explicitly should land at the bottom so the
      // freshest activity is in view.
      followBottomRef.current = true;
      // Load chat history
      try {
        const { messages } = await videoEditorApi.getChat(pid);
        setBubbles(restoreBubblesFromProject(messages, loaded));
      } catch { /* no chat history */ }
      resumePollingIfRunning(loaded);
    } catch (err) {
      console.error("Failed to load project:", err);
    }
  }, [resumePollingIfRunning]);

  useEffect(() => {
    if (!projectId) return;
    try { window.localStorage.setItem(LAST_VIDEO_STUDIO_PROJECT_KEY, projectId); } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => {
    if (projectId) return;
    let cancelled = false;
    try {
      const saved = window.localStorage.getItem(LAST_VIDEO_STUDIO_PROJECT_KEY);
      if (!saved) return;
      let loadedProject: EditorProject | null = null;
      void videoEditorApi.getProject(saved)
        .then(({ project: loaded }) => {
          if (cancelled) return;
          loadedProject = loaded;
          setProjectId(loaded.projectId);
          setProject(loaded);
          setView("chat");
          return videoEditorApi.getChat(loaded.projectId);
        })
        .then((chat) => {
          if (cancelled || !chat) return;
          if (loadedProject) {
            setBubbles(restoreBubblesFromProject(chat.messages, loadedProject));
            // Resume the progress bubble if a render is mid-flight on reload.
            resumePollingIfRunning(loadedProject);
          }
        })
        .catch(() => {
          try { window.localStorage.removeItem(LAST_VIDEO_STUDIO_PROJECT_KEY); } catch { /* ignore */ }
        });
    } catch { /* ignore */ }
    return () => { cancelled = true; };
  }, [projectId, resumePollingIfRunning]);

  const handleDeleteProject = useCallback(async (pid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this project? This cannot be undone.")) return;
    try {
      // If we're deleting the active project, tear down any in-flight chat
      // stream and render polling first. Without this, the polling loop
      // keeps hitting the now-deleted project and surfaces "Lost connection
      // to render service." after a dozen 404s — confusing and noisy.
      if (projectId === pid) {
        streamRef.current?.cancel();
        streamRef.current = null;
        if (renderPollRef.current) {
          clearInterval(renderPollRef.current);
          renderPollRef.current = null;
        }
        // Bump the session token so any in-flight async callback inside
        // startRenderPolling drops its update on return.
        renderPollSessionRef.current += 1;
      }
      await videoEditorApi.deleteProject(pid);
      setHistoryProjects((prev) => prev.filter((p) => p.projectId !== pid));
      if (projectId === pid) {
        setView("landing");
        setProjectId(null);
        setProject(null);
        setBubbles([]);
        setIsStreaming(false);
        setApplyingProposalId(null);
        setArtifactView(null);
        setArtifactPreviewUrl(null);
        try { window.localStorage.removeItem(LAST_VIDEO_STUDIO_PROJECT_KEY); } catch { /* ignore */ }
      }
    } catch (err) {
      console.error("Failed to delete project:", err);
    }
  }, [projectId]);

  // Auto-resize textarea — but never below the CSS-defined min-height so the
  // landing card's 72px target isn't squashed to a single line. Coalesced
  // through requestAnimationFrame so a fast typist doesn't trigger one
  // layout pass per keystroke (which becomes visible jank on long messages).
  const adjustTextareaRafRef = useRef<number | null>(null);
  const adjustTextarea = useCallback(() => {
    if (adjustTextareaRafRef.current != null) return;
    adjustTextareaRafRef.current = requestAnimationFrame(() => {
      adjustTextareaRafRef.current = null;
      const el = inputRef.current;
      if (!el) return;
      const cs = window.getComputedStyle(el);
      const minH = parseFloat(cs.minHeight || "0") || 0;
      el.style.height = "auto";
      el.style.height = Math.max(minH, Math.min(el.scrollHeight, 160)) + "px";
    });
  }, []);

  useEffect(() => {
    adjustTextarea();
    return () => {
      if (adjustTextareaRafRef.current != null) {
        cancelAnimationFrame(adjustTextareaRafRef.current);
        adjustTextareaRafRef.current = null;
      }
    };
  }, [inputText, adjustTextarea]);

  // ─── File Handling ──────────────────────────────────────────────────────────
  const handleFileAttach = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files).filter((f): f is File => Boolean(f) && f.size > 0);
    if (arr.length === 0) return;
    const newAssets: AttachedAsset[] = arr.map((f) => ({
      id: safeUuid(),
      name: f.name,
      type: fileTypeFromFile(f),
      file: f,
    }));
    setAttachedAssets((prev) => [...prev, ...newAssets]);
    setShowAttachPopover(false);
    // Reset native input value so the user can re-pick the same file later.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const removeAsset = useCallback((id: string) => {
    setAttachedAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ─── Drag and Drop ─────────────────────────────────────────────────────────
  // Counter-based dragenter/leave avoids the flicker when the cursor moves
  // between child elements (each child fires its own dragleave).
  const dragDepthRef = useRef(0);
  const handleDragEnter = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  }, []);
  const handleDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  }, []);
  const handleDragLeave = useCallback((e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);
  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);
      if (e.dataTransfer.files.length) handleFileAttach(e.dataTransfer.files);
    },
    [handleFileAttach]
  );

  // ─── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!inputText.trim() && attachedAssets.length === 0) return;
    if (isStreaming) return;
    setIsStreaming(true);
    const text = inputText.trim();
    setInputText("");
    // Snapshot the assets we're submitting; clear staged list now so the user
    // can stage new ones while uploads are in flight.
    const stagedAssets = attachedAssets;
    setAttachedAssets([]);

    // Pre-create a stable id for the user bubble so we can update its asset
    // chips with live upload progress. Without this users tap Send and stare
    // at a blank chat for the upload duration — which on a 200MB clip can
    // be 30+ seconds and looks indistinguishable from a frozen UI.
    const userBubbleId = safeUuid();

    try {
      let pid = projectId;
      if (!pid) {
        const { project: newProject } = await videoEditorApi.createProject({
          title: text.slice(0, 60) || "New Edit",
        });
        pid = newProject.projectId;
        setProjectId(pid);
        setProject(newProject);
        setView("chat");
      }

      // Show the user message + upload chips immediately, before uploads
      // start. Each chip will paint its progress bar as the upload runs.
      const initialAssets: AttachedAsset[] = stagedAssets.map((a) => ({
        ...a,
        uploadProgress: a.file ? 0 : 1,
      }));
      // Force a scroll-to-bottom on the next render — a new user message
      // is an explicit action and should always be brought into view.
      followBottomRef.current = true;
      setBubbles((prev) => [
        ...prev,
        { kind: "user", id: userBubbleId, text, assets: initialAssets },
      ]);

      // Helper that patches one asset on the in-flight user bubble. We
      // re-derive from `prev` each call so concurrent uploads (Promise.all)
      // don't race each other to the same setBubbles update.
      const patchAsset = (assetId: string, patch: Partial<AttachedAsset>) => {
        setBubbles((prev) =>
          prev.map((b) =>
            b.kind === "user" && b.id === userBubbleId
              ? {
                  ...b,
                  assets: b.assets.map((a) =>
                    a.id === assetId ? { ...a, ...patch } : a,
                  ),
                }
              : b,
          ),
        );
      };

      // Upload attached files in parallel — sequential uploads on a 5-clip
      // request blocked the chat round-trip for tens of seconds.
      const uploaded: AttachedAsset[] = stagedAssets.map((a) => ({ ...a }));
      await Promise.all(
        uploaded.map(async (asset) => {
          if (!asset.file) {
            patchAsset(asset.id, { uploadProgress: 1 });
            return;
          }
          const role = asset.type === "video" ? "source" : asset.type === "audio" ? "audio" : "logo";
          try {
            // Throttle progress updates to every 5% to avoid bombarding
            // React with a setState per network packet on huge uploads.
            let lastReported = 0;
            const result = await videoEditorApi.uploadAsset(
              pid!,
              role,
              asset.file,
              (fraction) => {
                const pct = Math.min(0.99, Math.max(0, fraction));
                if (pct - lastReported >= 0.05 || pct >= 0.99) {
                  lastReported = pct;
                  patchAsset(asset.id, { uploadProgress: pct });
                }
              },
            );
            asset.path = result.path;
            patchAsset(asset.id, { uploadProgress: 1, path: result.path });
          } catch (uploadErr) {
            const msg = uploadErr instanceof Error ? uploadErr.message : "Upload failed";
            patchAsset(asset.id, { uploadProgress: undefined, uploadError: msg });
            // Re-throw so Promise.all rejects and the outer catch restores
            // the staged list + input text for retry.
            throw uploadErr;
          }
        })
      );

      // Build message with asset context
      const assetCtx = uploaded
        .filter((a) => a.path)
        .map((a) => `[Uploaded ${a.type}: ${a.name} → ${a.path}]`)
        .join(" ");
      const capCtx = activeCapabilities.size
        ? `[Active capabilities: ${[...activeCapabilities].join(", ")}] `
        : "";
      const fullMessage = capCtx + assetCtx + (assetCtx && text ? " " : "") + text;

      streamChat(pid, fullMessage);
    } catch (err) {
      console.error("Submit error:", err);
      // Restore the user's typed text and staged files so they don't have to
      // re-pick everything after a transient upload failure. Drop the
      // optimistic user bubble so the input row matches what they staged.
      setBubbles((prev) => prev.filter((b) => !(b.kind === "user" && b.id === userBubbleId)));
      setInputText(text);
      setAttachedAssets((prev) => [...stagedAssets, ...prev]);
      setBubbles((prev) => [
        ...prev,
        { kind: "assistant", id: safeUuid(), text: `Error: ${(err as Error).message}` },
      ]);
      setIsStreaming(false);
    }
  }, [inputText, attachedAssets, projectId, isStreaming, activeCapabilities]);

  // ─── Stream Chat ────────────────────────────────────────────────────────────
  const streamChat = useCallback(
    (pid: string, message: string) => {
      // Per-iteration bubble state. The agent loop emits a `thinking` event
      // at the start of each iteration; we treat that as a hard reset for
      // the steps array so the user doesn't see iteration-1's tool history
      // resurface inside iteration-2's thinking bubble. Same goes for the
      // assistant bubble — each `text` run produces its own bubble unless
      // it's contiguous chunks of the same iteration.
      let thinkingId: string | null = null;
      let thinkingSteps: string[] = [];
      let assistantId: string | null = null;
      let assistantText = "";

      const dropThinkingBubble = () => {
        if (thinkingId) {
          const dead = thinkingId;
          setBubbles((prev) => prev.filter((b) => b.id !== dead));
          thinkingId = null;
        }
        thinkingSteps = [];
      };
      const startNewAssistantStream = () => {
        // Reset assistant accumulator so the next `text` event creates a
        // fresh bubble rather than appending to a stale one (e.g. after a
        // tool completed mid-stream and the agent kicked off another iter).
        assistantId = null;
        assistantText = "";
      };

      const handle = videoEditorApi.streamChat(pid, message, {
        onEvent: (event: EditorChatEvent) => {
          switch (event.type) {
            case "thinking":
              // New iteration boundary — drop the previous iteration's
              // thinking bubble so its now-stale step list doesn't bleed
              // into the new pass, and ensure the next `text` chunk opens
              // a fresh assistant bubble.
              dropThinkingBubble();
              startNewAssistantStream();
              thinkingId = safeUuid();
              thinkingSteps = ["Thinking..."];
              setBubbles((prev) => [...prev, { kind: "thinking", id: thinkingId!, steps: [...thinkingSteps] }]);
              break;

            case "text":
              if (!assistantId) {
                assistantId = safeUuid();
                dropThinkingBubble();
                assistantText = event.content;
                const newId = assistantId;
                setBubbles((prev) => [...prev, { kind: "assistant", id: newId, text: assistantText }]);
              } else {
                assistantText += event.content;
                const idForUpdate = assistantId;
                setBubbles((prev) =>
                  prev.map((b) => (b.id === idForUpdate ? { ...b, text: assistantText } : b))
                );
              }
              break;

            case "tool_start": {
              const label = getToolLabel(event.name);
              // Avoid duplicating the same tool entry if a duplicate
              // tool_start somehow arrives (e.g. after retry). Find by
              // exact label prefix and bump it instead of pushing twice.
              const existing = thinkingSteps.findIndex((s) => s.startsWith(label));
              if (existing < 0) thinkingSteps.push(`${label}...`);
              else thinkingSteps[existing] = `${label}...`;
              if (thinkingId) {
                const idForUpdate = thinkingId;
                setBubbles((prev) =>
                  prev.map((b) => (b.id === idForUpdate ? { ...b, steps: [...thinkingSteps] } : b))
                );
              } else {
                thinkingId = safeUuid();
                setBubbles((prev) => [...prev, { kind: "thinking", id: thinkingId!, steps: [...thinkingSteps] }]);
              }
              break;
            }

            case "tool_progress":
              if (event.name && thinkingId) {
                const label = getToolLabel(event.name);
                const progressText = event.message ? `${label}: ${event.message}` : `${label}...`;
                const pidx = thinkingSteps.findIndex((s) => s.startsWith(label));
                if (pidx >= 0) thinkingSteps[pidx] = progressText;
                else thinkingSteps.push(progressText);
                const idForUpdate = thinkingId;
                setBubbles((prev) =>
                  prev.map((b) => (b.id === idForUpdate ? { ...b, steps: [...thinkingSteps] } : b))
                );
              }
              break;

            case "tool_done":
              if (event.name) {
                const label = getToolLabel(event.name);
                const idx = thinkingSteps.findIndex((s) => s.startsWith(label));
                if (idx >= 0) {
                  thinkingSteps[idx] = `✓ ${label}`;
                  if (thinkingId) {
                    const idForUpdate = thinkingId;
                    setBubbles((prev) =>
                      prev.map((b) => (b.id === idForUpdate ? { ...b, steps: [...thinkingSteps] } : b))
                    );
                  }
                }
              }
              if (event.project) setProject(event.project);
              // Check for completed renders. Dedupe by jobId so we don't get
              // a stacked artifact card from concurrent SSE + poll updates.
              if (event.job && event.job.status === "done" && event.job.outputPath && pid) {
                const j = event.job;
                setBubbles((prev) => {
                  const exists = prev.some((b) => b.kind === "artifact" && (b as any).jobId === j.jobId);
                  if (exists) return prev;
                  return [
                    ...prev,
                    {
                      kind: "artifact",
                      id: safeUuid(),
                      title: projectRef.current?.title || "Rendered Video",
                      jobId: j.jobId,
                      outputPath: j.outputPath!,
                      projectId: pid,
                    },
                  ];
                });
              }
              // If the agent itself launched a render via the start_render
              // tool, hook up the polling bubble immediately so the user
              // sees progress without waiting for the next poll cycle.
              if (event.name === "start_render" && event.job && pid) {
                startRenderPollingRef.current(pid, event.job);
              }
              break;

            case "proposal":
              dropThinkingBubble();
              startNewAssistantStream();
              setBubbles((prev) => [
                ...prev,
                {
                  kind: "proposal",
                  id: safeUuid(),
                  status: "pending" as const,
                  proposal: {
                    proposalId: (event as any).proposalId,
                    summary: (event as any).summary,
                    diff: (event as any).diff || [],
                    timeline: (event as any).timeline,
                    duration: (event as any).duration || 0,
                  },
                },
              ]);
              break;

            case "project":
              setProject(event.project);
              break;

            case "done":
              dropThinkingBubble();
              setIsStreaming(false);
              checkForCompletedRender(pid);
              break;

            case "error":
              dropThinkingBubble();
              setIsStreaming(false);
              setBubbles((prev) => [
                ...prev,
                { kind: "assistant", id: safeUuid(), text: `⚠️ ${event.message}` },
              ]);
              break;
          }
        },
        onError: (err) => {
          setIsStreaming(false);
          // Stream is dead; drop the cancel handle so a later cancelActiveStream
          // call doesn't fire abort() on a request that already errored.
          streamRef.current = null;
          setBubbles((prev) => [
            ...prev.filter((b) => b.kind !== "thinking"),
            { kind: "assistant", id: safeUuid(), text: `Connection error: ${err.message}` },
          ]);
        },
        onClose: () => {
          setIsStreaming(false);
          streamRef.current = null;
          // Belt-and-braces: drop any leftover thinking bubble if the stream
          // closed before a `done` frame arrived (e.g. proxy timeout).
          setBubbles((prev) => prev.filter((b) => b.kind !== "thinking"));
        },
      });
      streamRef.current = handle;
    },
    []
  );

  // Check for renders that completed
  const checkForCompletedRender = useCallback(
    async (pid: string) => {
      try {
        const { project: latest } = await videoEditorApi.getProject(pid);
        setProject(latest);
        const doneRender = latest.renders.find((r) => r.status === "done" && r.outputPath);
        if (doneRender) {
          // Only add if not already in bubbles
          setBubbles((prev) => {
            const exists = prev.some((b) => b.kind === "artifact" && (b as any).jobId === doneRender.jobId);
            if (exists) return prev;
            return [
              ...prev,
              {
                kind: "artifact" as const,
                id: safeUuid(),
                title: latest.title || "Rendered Video",
                jobId: doneRender.jobId,
                outputPath: doneRender.outputPath!,
                projectId: pid,
              },
            ];
          });
        }
      } catch {
        /* ignore */
      }
    },
    []
  );

  // ─── Proposal Actions ──────────────────────────────────────────────────────
  const handleApplyProposal = useCallback(
    async (proposalId: string) => {
      if (!projectId) return;
      if (applyingProposalId) return;
      setApplyingProposalId(proposalId);
      try {
        const { project: updated } = await videoEditorApi.applyProposal(projectId, proposalId);
        setProject(updated);
        // Mark proposal bubble as approved
        setBubbles((prev) =>
          prev.map((b) =>
            b.kind === "proposal" && b.proposal.proposalId === proposalId
              ? { ...b, status: "approved" as const }
              : b
          )
        );
        // Add system notification instead of full assistant bubble
        setBubbles((prev) => [
          ...prev,
          { kind: "system" as const, id: safeUuid(), text: "✅ Plan approved! Starting render..." },
        ]);
        // The agent's tool dispatcher may have already enqueued a render via
        // start_render. Skip a redundant call when an active job exists for
        // this project — otherwise we'd kick off two concurrent FFmpeg passes
        // racing to the same workspace path.
        const existingRender = updated.renders.find(
          (r) => r.status === "pending" || r.status === "running"
        );
        if (existingRender) {
          setProject(updated);
          startRenderPolling(projectId, existingRender);
        } else {
          const { project: renderingProject, job } = await videoEditorApi.startRender(projectId);
          setProject(renderingProject);
          startRenderPolling(projectId, job);
        }
      } catch (err) {
        console.error("Apply error:", err);
        setBubbles((prev) => [
          ...prev,
          { kind: "assistant" as const, id: safeUuid(), text: `Could not start render: ${(err as Error).message}` },
        ]);
      } finally {
        setApplyingProposalId(null);
      }
    },
    [applyingProposalId, projectId]
  );

  const handleRefineProposal = useCallback(
    async (proposalId: string) => {
      if (!projectId) return;
      try {
        await videoEditorApi.rejectProposal(projectId, proposalId);
        // Mark proposal bubble as rejected
        setBubbles((prev) =>
          prev.map((b) =>
            b.kind === "proposal" && b.proposal.proposalId === proposalId
              ? { ...b, status: "rejected" as const }
              : b
          )
        );
        inputRef.current?.focus();
      } catch (err) {
        console.error("Reject error:", err);
      }
    },
    [projectId]
  );

  // ─── Render Progress Polling ────────────────────────────────────────────────
  const renderPollErrorsRef = useRef(0);
  const renderPollStartRef = useRef(0);
  // Hard cap so a wedged backend never burns through forever — 30 minutes
  // is more than enough for a final render at 1080p.
  const MAX_POLL_MS = 30 * 60_000;
  const startRenderPolling = useCallback(
    (pid: string, initialJob?: EditorJobSummary) => {
      if (renderPollRef.current) clearInterval(renderPollRef.current);
      renderPollErrorsRef.current = 0;
      renderPollStartRef.current = Date.now();
      // Snapshot the current session token. Every async branch below checks
      // this before calling setBubbles / setProject / saveVideoStudioRenderHistory,
      // so an in-flight callback whose project was deleted or replaced
      // simply drops its update.
      const sessionToken = renderPollSessionRef.current;
      const isStaleSession = () => renderPollSessionRef.current !== sessionToken;
      const activityTitle = projectRef.current?.title || "AI Studio render";
      if (initialJob?.jobId) {
        upsertActiveVideoStudioRender({
          projectId: pid,
          jobId: initialJob.jobId,
          title: activityTitle,
          kind: initialJob.kind,
          startedAt: initialJob.createdAt || Date.now(),
          progress: initialJob.progress ?? 0,
          status: initialJob.status,
          message: initialJob.message || "Queued render...",
        });
      }
      const progressBubbleId = safeUuid();
      // If we already have a progress bubble for this job (e.g. resume after
      // reload), reuse it instead of stacking another one.
      setBubbles((prev) => {
        const existing = prev.find(
          (b) => b.kind === "render-progress" && initialJob?.jobId && (b as any).jobId === initialJob.jobId
        );
        if (existing) return prev;
        return [
          ...prev,
          {
            kind: "render-progress" as const,
            id: progressBubbleId,
            jobId: initialJob?.jobId ?? "",
            progress: initialJob?.progress ?? 0,
            message: initialJob?.message ?? "Starting render...",
            status: initialJob?.status ?? "pending",
          },
        ];
      });
      const targetBubbleId = initialJob?.jobId || progressBubbleId;
      // Capture the interval id locally so `stop()` clears *this* poll's
      // interval and never the next project's. Without the identity check
      // below, a stale-session callback racing against a fast project
      // switch could call clearInterval on the NEW project's interval id
      // (since renderPollRef.current is mutable), silently freezing the
      // new render's progress bubble.
      let intervalId: ReturnType<typeof setInterval> | null = null;
      const stop = () => {
        if (intervalId !== null) clearInterval(intervalId);
        if (renderPollRef.current === intervalId) renderPollRef.current = null;
      };
      intervalId = setInterval(async () => {
        if (isStaleSession()) { stop(); return; }
        if (Date.now() - renderPollStartRef.current > MAX_POLL_MS) {
          stop();
          if (isStaleSession()) return;
          setBubbles((prev) =>
            prev.map((b) =>
              b.kind === "render-progress" && (b.jobId === targetBubbleId || b.id === progressBubbleId)
                ? { ...b, status: "error", message: "Render timed out — check status manually." }
                : b
            )
          );
          return;
        }
        try {
          let latest = projectRef.current;
          let activeRender: EditorJobSummary | null = null;
          if (initialJob?.jobId) {
            const live = await videoEditorApi.getJob(initialJob.jobId);
            activeRender = live.job;
          } else {
            const projectResp = await videoEditorApi.getProject(pid);
            latest = projectResp.project;
            activeRender = latest.renders[0] ?? null;
          }
          // Network came back — but the user may have switched projects
          // between the request firing and the response arriving. Drop the
          // update if so.
          if (isStaleSession()) { stop(); return; }
          renderPollErrorsRef.current = 0;
          if (!activeRender) return;
          upsertActiveVideoStudioRender({
            projectId: pid,
            jobId: activeRender.jobId,
            title: projectRef.current?.title || activityTitle,
            kind: activeRender.kind,
            startedAt: activeRender.createdAt || Date.now(),
            progress: activeRender.progress ?? 0,
            status: activeRender.status,
            message: activeRender.message || "Rendering...",
          });
          // Update progress bubble (match either by initial bubble id or jobId).
          setBubbles((prev) =>
            prev.map((b) =>
              b.kind === "render-progress" &&
              (b.id === progressBubbleId || b.jobId === activeRender.jobId)
                ? { kind: "render-progress" as const, id: b.id, jobId: activeRender.jobId, progress: activeRender.progress ?? 0, message: activeRender.message || "Rendering...", status: activeRender.status }
                : b
            )
          );
          if (activeRender.status === "done") {
            stop();
            removeActiveVideoStudioRender(activeRender.jobId);
            const { project: refreshed } = await videoEditorApi.getProject(pid);
            if (isStaleSession()) return;
            setProject(refreshed);
            const completedRender = refreshed.renders.find((r) => r.jobId === activeRender.jobId) ?? activeRender;
            saveVideoStudioRenderHistory({
              projectId: pid,
              jobId: activeRender.jobId,
              title: refreshed.title || activityTitle,
              kind: activeRender.kind,
              createdAt: Date.now(),
              outputPath: completedRender.outputPath || activeRender.outputPath || null,
            });
            // Remove progress bubble and add artifact (dedupe by jobId).
            setBubbles((prev) => {
              const without = prev.filter((b) => !(b.kind === "render-progress" && (b.id === progressBubbleId || b.jobId === activeRender.jobId)));
              const exists = without.some((b) => b.kind === "artifact" && (b as any).jobId === activeRender.jobId);
              if (exists) return without;
              return [
                ...without,
                {
                  kind: "artifact" as const,
                  id: safeUuid(),
                  title: refreshed.title || "Rendered Video",
                  jobId: activeRender.jobId,
                  outputPath: completedRender.outputPath || "",
                  projectId: pid,
                },
              ];
            });
          } else if (activeRender.status === "error" || activeRender.status === "cancelled") {
            stop();
            removeActiveVideoStudioRender(activeRender.jobId);
            // Update progress to show terminal failure/cancel state
            setBubbles((prev) =>
              prev.map((b) =>
                b.kind === "render-progress" && (b.id === progressBubbleId || b.jobId === activeRender.jobId)
                  ? { kind: "render-progress" as const, id: b.id, jobId: b.jobId, progress: 0, message: activeRender.message || (activeRender.status === "cancelled" ? "Render cancelled" : "Render failed"), status: activeRender.status }
                  : b
              )
            );
          }
        } catch {
          if (isStaleSession()) { stop(); return; }
          try {
            const projectResp = await videoEditorApi.getProject(pid);
            if (isStaleSession()) { stop(); return; }
            const staleRender = projectResp.project.renders.find((r) => initialJob?.jobId && r.jobId === initialJob.jobId);
            if (
              staleRender &&
              (staleRender.status === "pending" || staleRender.status === "running") &&
              Date.now() - staleRender.createdAt >= STALE_RENDER_MS
            ) {
              stop();
              setProject(projectResp.project);
              setBubbles((prev) =>
                prev.map((b) =>
                  b.kind === "render-progress" && (b.id === progressBubbleId || b.jobId === staleRender.jobId)
                    ? { ...b, status: "error", progress: 0, message: "Render worker stopped before reporting progress. Start render again." }
                    : b
                )
              );
              return;
            }
          } catch {
            // Keep the normal retry path for transient project/job lookup failures.
          }
          // Tolerate transient network blips, but bail after enough successive
          // failures so we don't pin an infinite poll on a broken backend.
          renderPollErrorsRef.current += 1;
          if (renderPollErrorsRef.current >= 12) {
            stop();
            if (initialJob?.jobId) removeActiveVideoStudioRender(initialJob.jobId);
            setBubbles((prev) =>
              prev.map((b) =>
                b.kind === "render-progress" && (b.id === progressBubbleId)
                  ? { ...b, status: "error", message: "Lost connection to render service." }
                  : b
              )
            );
          }
        }
      }, 2500);
      renderPollRef.current = intervalId;
    },
    []
  );

  // Expose startRenderPolling to earlier callbacks via a stable ref so we
  // can resume polling on project load (declared above the callback).
  useEffect(() => {
    startRenderPollingRef.current = startRenderPolling;
  }, [startRenderPolling]);

  // Cleanup polling and any in-flight SSE stream on unmount.
  useEffect(() => {
    return () => {
      // Bump session before cleaning up so any in-flight async callback
      // detects the unmount and drops its update.
      renderPollSessionRef.current += 1;
      if (renderPollRef.current) {
        clearInterval(renderPollRef.current);
        renderPollRef.current = null;
      }
      streamRef.current?.cancel();
      streamRef.current = null;
    };
  }, []);

  // Fetch (and periodically re-fetch) the presigned URL for the artifact
  // preview. Workspace presigned URLs expire — usually within an hour — so
  // a user lingering on the artifact view eventually finds the player
  // broken. We schedule a refresh well before `expiresIn` elapses, and
  // also wire `<video>`'s `onError` below so we re-fetch on demand if the
  // URL ages out faster than expected.
  const artifactPreviewRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchArtifactUrlRef = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    setArtifactPreviewUrl(null);
    if (artifactPreviewRefreshRef.current) {
      clearTimeout(artifactPreviewRefreshRef.current);
      artifactPreviewRefreshRef.current = null;
    }
    if (!artifactView?.outputPath) return;

    const path = artifactView.outputPath;
    const fetchOnce = () => {
      void workspaceApi.getFile(path, { inline: true })
        .then(({ url, expiresIn }) => {
          if (cancelled) return;
          setArtifactPreviewUrl(url);
          // Re-fetch 60s before expiry, with a 30s floor so we don't
          // hammer the workspace when expiresIn is tiny or missing.
          const refreshIn = Math.max(30_000, ((expiresIn ?? 3600) - 60) * 1000);
          if (artifactPreviewRefreshRef.current) clearTimeout(artifactPreviewRefreshRef.current);
          artifactPreviewRefreshRef.current = setTimeout(fetchOnce, refreshIn);
        })
        .catch(() => {
          if (!cancelled) setArtifactPreviewUrl(null);
        });
    };
    refetchArtifactUrlRef.current = fetchOnce;
    fetchOnce();
    return () => {
      cancelled = true;
      if (artifactPreviewRefreshRef.current) {
        clearTimeout(artifactPreviewRefreshRef.current);
        artifactPreviewRefreshRef.current = null;
      }
    };
  }, [artifactView?.outputPath]);

  // ─── Quick Actions ─────────────────────────────────────────────────────────
  const handleQuickAction = useCallback(
    (text: string) => {
      if (!projectId || isStreaming) return;
      setIsStreaming(true);
      const bubble: ChatBubble = { kind: "user", id: safeUuid(), text, assets: [] };
      setBubbles((prev) => [...prev, bubble]);
      streamChat(projectId, text);
    },
    [projectId, isStreaming, streamChat]
  );

  // ─── Stream cancellation ───────────────────────────────────────────────────
  const cancelActiveStream = useCallback(() => {
    streamRef.current?.cancel();
    streamRef.current = null;
    // Drop any lingering thinking bubble — Esc/Stop should leave no spinners.
    setBubbles((prev) => prev.filter((b) => b.kind !== "thinking"));
    setIsStreaming(false);
  }, []);

  // ─── Retry a failed render ─────────────────────────────────────────────────
  // Triggered from the Retry button inside a render-progress bubble in
  // error state. We drop the failed bubble first so the new poll can spawn
  // a fresh one (otherwise we stack two progress cards).
  const handleRetryRender = useCallback(async (failedBubbleId: string) => {
    if (!projectId) return;
    setBubbles((prev) => prev.filter((b) => b.id !== failedBubbleId));
    try {
      const { project: renderingProject, job } = await videoEditorApi.startRender(projectId);
      setProject(renderingProject);
      startRenderPollingRef.current(projectId, job);
    } catch (err) {
      setBubbles((prev) => [
        ...prev,
        {
          kind: "assistant",
          id: safeUuid(),
          text: `Could not restart render: ${(err as Error).message}`,
        },
      ]);
    }
  }, [projectId]);

  // ─── Key Handling ──────────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape" && isStreaming) {
        e.preventDefault();
        cancelActiveStream();
      }
    },
    [handleSubmit, isStreaming, cancelActiveStream]
  );

  // ─── Feature Tile Click ────────────────────────────────────────────────────
  const handleTileClick = useCallback((tile: (typeof FEATURE_TILES)[number]) => {
    if (tile.title === "From YouTube") {
      // Show YouTube URL input inline
      setShowAttachPopover(false);
      setInputText("Paste YouTube URL: ");
      inputRef.current?.focus();
    } else {
      setInputText(tile.prefill);
      inputRef.current?.focus();
    }
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Shared History Panel ──────────────────────────────────────────────────
  // Extracted because it was duplicated verbatim in landing+chat views, with
  // subtly inconsistent accessibility/active-state behaviour.
  const renderHistoryPanel = () => (
    <AnimatePresence>
      {showHistory && (
        <>
          <motion.div
            className="ai-video-studio__history-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowHistory(false)}
            aria-hidden="true"
          />
          <motion.div
            className="ai-video-studio__history-panel"
            initial={{ x: -320 }}
            animate={{ x: 0 }}
            exit={{ x: -320 }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            role="dialog"
            aria-modal="true"
            aria-label="Recent Projects"
          >
            <div className="ai-video-studio__history-header">
              <span className="ai-video-studio__history-title">Recent Projects</span>
              <button
                type="button"
                className="ai-video-studio__history-close"
                aria-label="Close history"
                onClick={() => setShowHistory(false)}
              >×</button>
            </div>
            <div className="ai-video-studio__history-list">
              {historyLoading ? (
                <div className="ai-video-studio__history-empty">Loading...</div>
              ) : historyProjects.length === 0 ? (
                <div className="ai-video-studio__history-empty">No projects yet</div>
              ) : (
                historyProjects.map((p) => (
                  <div
                    key={p.projectId}
                    className={`ai-video-studio__history-item ${p.projectId === projectId ? "ai-video-studio__history-item--active" : ""}`}
                    onClick={() => loadProject(p.projectId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        loadProject(p.projectId);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="ai-video-studio__history-item-icon" aria-hidden="true">🎬</div>
                    <div className="ai-video-studio__history-item-info">
                      <div className="ai-video-studio__history-item-title">{p.title || "Untitled"}</div>
                      <div className="ai-video-studio__history-item-date">
                        {new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ai-video-studio__history-item-delete"
                      title="Delete project"
                      aria-label={`Delete project ${p.title || "Untitled"}`}
                      onClick={(e) => handleDeleteProject(p.projectId, e)}
                    >
                      🗑
                    </button>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  // ─── Artifact View ─────────────────────────────────────────────────────────
  if (view === "artifact" && artifactView) {
    return (
      <div className="ai-video-studio ai-video-studio--artifact">
        <div className="ai-video-studio__artifact-header">
          <button
            className="ai-video-studio__back-btn"
            onClick={() => {
              setView("chat");
              setArtifactView(null);
            }}
          >
            ← Back to chat
          </button>
        </div>
        <div className="ai-video-studio__artifact-content">
          <h2 className="ai-video-studio__artifact-title">{artifactView.title}</h2>
          <div className="ai-video-studio__artifact-actions">
            <a
              href={`/api/workspace/file?path=${encodeURIComponent(artifactView.outputPath)}&download=1`}
              target="_blank"
              rel="noreferrer"
              className="ai-video-studio__artifact-action-btn"
            >
              ↓ Download
            </a>
          </div>
          <div className="ai-video-studio__artifact-player">
            {artifactPreviewUrl ? (
              <video
                key={artifactPreviewUrl}
                controls
                // `autoPlay` requires `muted` (and `playsInline` on iOS) to
                // satisfy modern browser autoplay policies — without these
                // the video silently refuses to play and looks broken.
                autoPlay
                muted
                playsInline
                preload="metadata"
                src={artifactPreviewUrl}
                className="ai-video-studio__video-el"
                onError={() => {
                  // The presigned URL likely expired. Re-fetch and let the
                  // <video> remount via the `key` prop above on the new URL.
                  refetchArtifactUrlRef.current();
                }}
              />
            ) : (
              <div className="ai-video-studio__artifact-loading">Loading preview...</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Chat View ─────────────────────────────────────────────────────────────
  if (view === "chat") {
    return (
      <div
        className="ai-video-studio ai-video-studio--chat"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        <AnimatePresence>
          {isDragging && (
            <motion.div
              className="ai-video-studio__drag-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="ai-video-studio__drag-content">
                <span className="ai-video-studio__drag-icon">📁</span>
                <span>Drop files to add</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top bar */}
        <div className="ai-video-studio__topbar">
          <div className="ai-video-studio__topbar-left">
            <span className="ai-video-studio__agent-icon">🎬</span>
            <span className="ai-video-studio__project-title">
              {project?.title || "AI Video Agent"}
            </span>
          </div>
          <div className="ai-video-studio__topbar-right">
            <button
              type="button"
              className="ai-video-studio__topbar-btn"
              title="History"
              aria-label="Open project history"
              onClick={() => setShowHistory(true)}
            >
              📋
            </button>
            <button
              className="ai-video-studio__topbar-btn"
              title="New project"
              aria-label="New project"
              onClick={() => {
                cancelActiveStream();
                if (renderPollRef.current) {
                  clearInterval(renderPollRef.current);
                  renderPollRef.current = null;
                }
                // Drop any in-flight render polling callback so it doesn't
                // resurrect a progress bubble in the new (empty) chat.
                renderPollSessionRef.current += 1;
                setView("landing");
                setProjectId(null);
                setProject(null);
                setBubbles([]);
                setApplyingProposalId(null);
                setArtifactView(null);
                setArtifactPreviewUrl(null);
                try { window.localStorage.removeItem(LAST_VIDEO_STUDIO_PROJECT_KEY); } catch { /* ignore */ }
              }}
            >
              ＋
            </button>
          </div>
        </div>

        {/* History panel — shared with landing view */}
        {renderHistoryPanel()}

        {/* Messages */}
        <div
          className="ai-video-studio__messages"
          ref={messagesScrollRef}
          onScroll={handleMessagesScroll}
        >
          <AnimatePresence initial={false}>
            {bubbles.map((bubble) => (
              <motion.div
                key={bubble.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
                className={`ai-video-studio__bubble ai-video-studio__bubble--${bubble.kind}`}
              >
                {renderBubble(bubble)}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Streaming indicator */}
          {isStreaming && bubbles.every((b) => b.kind !== "thinking") && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="ai-video-studio__bubble ai-video-studio__bubble--thinking"
            >
              <div className="ai-video-studio__thinking">
                <span className="ai-video-studio__thinking-dots">
                  <span>●</span><span>●</span><span>●</span>
                </span>
              </div>
            </motion.div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Quick actions — hide while a render is in progress so users
            don't tap "Looks great!" while the previous one is still
            cooking, and hide while the agent is mid-stream. */}
        {!isStreaming
          && bubbles.length > 0
          && bubbles[bubbles.length - 1]?.kind !== "user"
          && !bubbles.some((b) => b.kind === "render-progress" && b.status !== "done" && b.status !== "error" && b.status !== "cancelled")
          && (
          <div className="ai-video-studio__quick-actions">
            {bubbles.some((b) => b.kind === "artifact") && (
              <>
                <button className="ai-video-studio__quick-btn" onClick={() => handleQuickAction("Looks great!")}>
                  👍 Looks great!
                </button>
                <button className="ai-video-studio__quick-btn" onClick={() => handleQuickAction("Can we change something?")}>
                  ✏️ Change something
                </button>
                <button className="ai-video-studio__quick-btn" onClick={() => handleQuickAction("Make another version")}>
                  🔄 Another version
                </button>
              </>
            )}
          </div>
        )}

        {/* Input bar */}
        <div className="ai-video-studio__input-bar">
          {/* Attached assets */}
          {attachedAssets.length > 0 && (
            <div className="ai-video-studio__input-assets">
              {attachedAssets.map((a) => (
                <div key={a.id} className="ai-video-studio__asset-chip">
                  <span className="ai-video-studio__asset-chip-icon">
                    {a.type === "video" ? "🎬" : a.type === "audio" ? "🎵" : "🖼"}
                  </span>
                  <span className="ai-video-studio__asset-chip-name">{a.name}</span>
                  <button className="ai-video-studio__asset-chip-remove" onClick={() => removeAsset(a.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ai-video-studio__input-row">
            <div className="ai-video-studio__attach-wrap">
              <button
                className="ai-video-studio__attach-btn"
                onClick={() => setShowAttachPopover(!showAttachPopover)}
              >
                ＋
              </button>
              <AnimatePresence>
                {showAttachPopover && (
                  <motion.div
                    className="ai-video-studio__attach-popover"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                  >
                    <button
                      onClick={() => {
                        fileInputRef.current?.click();
                        setShowAttachPopover(false);
                      }}
                    >
                      📁 Upload files
                    </button>
                    <button
                      onClick={() => {
                        setInputText("YouTube URL: ");
                        inputRef.current?.focus();
                        setShowAttachPopover(false);
                      }}
                    >
                      🔗 YouTube link
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <textarea
              ref={inputRef}
              className="ai-video-studio__input-textarea"
              placeholder={isStreaming ? "Type while the agent is working — pressing Enter will wait for it to finish…" : "Enter your next prompt..."}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            {isStreaming ? (
              <button
                type="button"
                className="ai-video-studio__send-btn ai-video-studio__send-btn--stop"
                onClick={cancelActiveStream}
                title="Stop generating"
                aria-label="Stop generating"
              >
                ■
              </button>
            ) : (
              <button
                type="button"
                className="ai-video-studio__send-btn"
                onClick={handleSubmit}
                disabled={!inputText.trim() && attachedAssets.length === 0}
                aria-label="Send message"
              >
                ↑
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,image/*,audio/*"
          className="ai-video-studio__file-input"
          onChange={(e) => e.target.files && handleFileAttach(e.target.files)}
        />
      </div>
    );
  }

  // ─── Landing View ──────────────────────────────────────────────────────────
  return (
    <div
      className="ai-video-studio ai-video-studio--landing"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            className="ai-video-studio__drag-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="ai-video-studio__drag-content">
              <span className="ai-video-studio__drag-icon">📁</span>
              <span>Drop files to add</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* History panel — shared with chat view */}
      {renderHistoryPanel()}

      <div className="ai-video-studio__landing-scroll">
        {/* Hero */}
        <motion.div
          className="ai-video-studio__hero"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1 className="ai-video-studio__hero-title">
            <span className="ai-video-studio__hero-sparkle">✨</span> Edit it with AI
          </h1>
          <p className="ai-video-studio__hero-subtitle">
            Your AI video editor. Upload clips, describe the edit, get the video.
          </p>
          <button
            className="ai-video-studio__history-toggle"
            onClick={() => setShowHistory(true)}
          >
            📋 Recent Projects
          </button>
        </motion.div>

        {/* Input Card */}
        <motion.div
          className="ai-video-studio__input-card"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          {/* Capability pills */}
          <div className="ai-video-studio__cap-pills">
            {CAPABILITY_PILLS.map((pill) => (
              <button
                key={pill.key}
                type="button"
                className={`ai-video-studio__cap-pill ${activeCapabilities.has(pill.key) ? "ai-video-studio__cap-pill--active" : ""}`}
                aria-pressed={activeCapabilities.has(pill.key)}
                onClick={() =>
                  setActiveCapabilities((prev) => {
                    const next = new Set(prev);
                    if (next.has(pill.key)) next.delete(pill.key); else next.add(pill.key);
                    return next;
                  })
                }
              >
                <span aria-hidden="true">{pill.icon}</span>
                <span>{pill.label}</span>
              </button>
            ))}
          </div>

          {/* Attached assets in card */}
          {attachedAssets.length > 0 && (
            <div className="ai-video-studio__card-assets">
              {attachedAssets.map((a) => (
                <div key={a.id} className="ai-video-studio__asset-chip">
                  <span className="ai-video-studio__asset-chip-icon">
                    {a.type === "video" ? "🎬" : a.type === "audio" ? "🎵" : "🖼"}
                  </span>
                  <span className="ai-video-studio__asset-chip-name">{a.name}</span>
                  <span className="ai-video-studio__asset-chip-type">{a.type}</span>
                  <button className="ai-video-studio__asset-chip-remove" onClick={() => removeAsset(a.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={inputRef}
            className="ai-video-studio__card-textarea"
            placeholder="Upload a video and tell me what to do — cut clips, add logo, join, transitions, anything you'd ask a real editor."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
          />

          {/* Bottom row */}
          <div className="ai-video-studio__card-bottom">
            <div className="ai-video-studio__card-actions-left">
              <div className="ai-video-studio__attach-wrap">
                <button
                  className="ai-video-studio__attach-btn"
                  onClick={() => setShowAttachPopover(!showAttachPopover)}
                >
                  ＋
                </button>
                <AnimatePresence>
                  {showAttachPopover && (
                    <motion.div
                      className="ai-video-studio__attach-popover"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                    >
                      <button
                        onClick={() => {
                          fileInputRef.current?.click();
                          setShowAttachPopover(false);
                        }}
                      >
                        📁 Upload files
                      </button>
                      <button
                        onClick={() => {
                          setInputText("YouTube URL: ");
                          inputRef.current?.focus();
                          setShowAttachPopover(false);
                        }}
                      >
                        🔗 YouTube link
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
            <button
              className="ai-video-studio__submit-btn"
              onClick={handleSubmit}
              disabled={isStreaming || (!inputText.trim() && attachedAssets.length === 0)}
            >
              Submit
            </button>
          </div>
        </motion.div>

        {/* Feature tiles */}
        <motion.div
          className="ai-video-studio__tiles"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          {FEATURE_TILES.map((tile) => (
            <button
              key={tile.title}
              type="button"
              className="ai-video-studio__tile"
              onClick={() => handleTileClick(tile)}
              aria-label={`${tile.title}: ${tile.desc}`}
            >
              <span className="ai-video-studio__tile-icon" aria-hidden="true">{tile.icon}</span>
              <span className="ai-video-studio__tile-title">{tile.title}</span>
              <span className="ai-video-studio__tile-desc">{tile.desc}</span>
              <span className="ai-video-studio__tile-arrow" aria-hidden="true">→</span>
            </button>
          ))}
        </motion.div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*"
        className="ai-video-studio__file-input"
        onChange={(e) => e.target.files && handleFileAttach(e.target.files)}
      />
    </div>
  );

  // ─── Bubble Renderers ──────────────────────────────────────────────────────
  function renderBubble(bubble: ChatBubble) {
    switch (bubble.kind) {
      case "user":
        return (
          <div className="ai-video-studio__user-msg">
            {bubble.assets.length > 0 && (
              <div className="ai-video-studio__msg-assets">
                {bubble.assets.map((a) => {
                  const inFlight = a.uploadProgress !== undefined && a.uploadProgress < 1;
                  const failed = Boolean(a.uploadError);
                  const pct = Math.round((a.uploadProgress ?? 0) * 100);
                  return (
                    <div
                      key={a.id}
                      className={
                        "ai-video-studio__msg-asset-chip" +
                        (inFlight ? " ai-video-studio__msg-asset-chip--uploading" : "") +
                        (failed ? " ai-video-studio__msg-asset-chip--error" : "")
                      }
                      title={failed ? a.uploadError : undefined}
                    >
                      <span className="ai-video-studio__asset-chip-icon">
                        {a.type === "video" ? "▶" : a.type === "audio" ? "♪" : "🖼"}
                      </span>
                      <div>
                        <div className="ai-video-studio__msg-asset-name">{a.name}</div>
                        <div className="ai-video-studio__msg-asset-type">
                          {failed
                            ? `Upload failed`
                            : inFlight
                              ? `Uploading… ${pct}%`
                              : a.type}
                        </div>
                        {inFlight && (
                          <div className="ai-video-studio__msg-asset-progress" aria-hidden="true">
                            <div
                              className="ai-video-studio__msg-asset-progress-bar"
                              style={{ width: `${Math.max(2, pct)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {bubble.text && <div className="ai-video-studio__msg-text">{bubble.text}</div>}
          </div>
        );

      case "assistant":
        return (
          <div className="ai-video-studio__agent-msg">
            <div className="ai-video-studio__msg-text">{renderAgentMarkdown(bubble.text)}</div>
          </div>
        );

      case "thinking":
        return (
          <div className="ai-video-studio__thinking">
            <div className="ai-video-studio__thinking-header">
              <span className="ai-video-studio__thinking-dots">
                <span>●</span><span>●</span><span>●</span>
              </span>
              <span>Working...</span>
            </div>
            <div className="ai-video-studio__thinking-steps">
              {bubble.steps.map((step, i) => (
                <div key={i} className={`ai-video-studio__thinking-step ${step.startsWith("✓") ? "ai-video-studio__thinking-step--done" : ""}`}>
                  {step}
                </div>
              ))}
            </div>
          </div>
        );

      case "proposal": {
        const isApproved = (bubble as any).status === "approved";
        const isRejected = (bubble as any).status === "rejected";
        const isDone = isApproved || isRejected;
        return (
          <div className={`ai-video-studio__proposal-card ${isApproved ? "ai-video-studio__proposal-card--approved" : ""} ${isRejected ? "ai-video-studio__proposal-card--rejected" : ""}`}>
            <div className="ai-video-studio__proposal-header">
              <span className="ai-video-studio__proposal-icon">{isApproved ? "✅" : isRejected ? "✏️" : "📋"}</span>
              <span className="ai-video-studio__proposal-title">{isApproved ? "Approved Plan" : isRejected ? "Revised Plan" : "Edit Plan"}</span>
            </div>
            <p className="ai-video-studio__proposal-summary">{bubble.proposal.summary}</p>

            {/* Timeline section */}
            {bubble.proposal.timeline.tracks.video.length > 0 && (
              <div className="ai-video-studio__proposal-section">
                <div className="ai-video-studio__proposal-section-title">Timeline</div>
                {bubble.proposal.timeline.tracks.video.map((clip, i) => (
                  <div key={clip.id} className="ai-video-studio__proposal-item">
                    <span>📹</span>
                    <span>
                      Clip {i + 1}: {formatDuration(clip.srcIn)}-{clip.srcOut > 0 ? formatDuration(clip.srcOut) : "end"}
                      {clip.speed !== 1 && ` (${clip.speed}x)`}
                    </span>
                    {clip.transitionOut && (
                      <div className="ai-video-studio__proposal-transition">
                        ↕ {clip.transitionOut.type} ({clip.transitionOut.duration}s)
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Overlays section */}
            {bubble.proposal.timeline.tracks.overlays.length > 0 && (
              <div className="ai-video-studio__proposal-section">
                <div className="ai-video-studio__proposal-section-title">Overlays</div>
                {bubble.proposal.timeline.tracks.overlays.map((ov) => (
                  <div key={ov.id} className="ai-video-studio__proposal-item">
                    <span>{ov.type === "logo" ? "🖼" : ov.type === "text" ? "📝" : "🎨"}</span>
                    <span>
                      {ov.type === "text" ? `"${ov.content}"` : ov.content.split("/").pop()} — {ov.position}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Format section */}
            <div className="ai-video-studio__proposal-section">
              <div className="ai-video-studio__proposal-section-title">Format</div>
              <div className="ai-video-studio__proposal-item">
                <span>📐</span>
                <span>
                  {bubble.proposal.timeline.export.aspectRatio} · {bubble.proposal.timeline.export.cropMode}
                  {bubble.proposal.timeline.export.colorPreset !== "none" && ` · ${bubble.proposal.timeline.export.colorPreset}`}
                </span>
              </div>
              {bubble.proposal.duration > 0 && (
                <div className="ai-video-studio__proposal-item">
                  <span>⏱</span>
                  <span>~{formatDuration(bubble.proposal.duration)}</span>
                </div>
              )}
            </div>

            {/* Diff items */}
            {bubble.proposal.diff.length > 0 && (
              <div className="ai-video-studio__proposal-diff">
                {bubble.proposal.diff.map((d, i) => (
                  <div key={i} className="ai-video-studio__proposal-diff-item">
                    <span className={`ai-video-studio__diff-badge ai-video-studio__diff-badge--${d.action}`}>
                      {d.action}
                    </span>
                    <span>{d.description}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons — only show if not already acted on */}
            {!isDone && (
              <div className="ai-video-studio__proposal-actions">
                <button
                  className="ai-video-studio__proposal-apply"
                  onClick={() => handleApplyProposal(bubble.proposal.proposalId)}
                  disabled={isStreaming || applyingProposalId === bubble.proposal.proposalId}
                >
                  ✓ Looks good, render it
                </button>
                <button
                  className="ai-video-studio__proposal-refine"
                  onClick={() => handleRefineProposal(bubble.proposal.proposalId)}
                  disabled={isStreaming}
                >
                  ✏ Change plan
                </button>
              </div>
            )}
          </div>
        );
      }
      case "system":
        return (
          <div className="ai-video-studio__system-msg">
            {bubble.text}
          </div>
        );

      case "render-progress":
        return (
          <div className={`ai-video-studio__render-progress ${bubble.status === "error" ? "ai-video-studio__render-progress--error" : ""}`}>
            <div className="ai-video-studio__render-progress-header">
              <span>{bubble.status === "error" ? "❌" : bubble.status === "done" ? "✅" : "⚙️"}</span>
              <span>{bubble.message}</span>
            </div>
            {bubble.status !== "error" && (
              <div className="ai-video-studio__render-progress-bar-wrap">
                <div
                  className="ai-video-studio__render-progress-bar"
                  style={{ width: `${Math.max(bubble.progress, 2)}%` }}
                />
                <span className="ai-video-studio__render-progress-pct">{bubble.progress}%</span>
              </div>
            )}
            {bubble.status === "error" && (
              <div className="ai-video-studio__render-progress-actions">
                <button
                  type="button"
                  className="ai-video-studio__render-progress-retry"
                  onClick={() => handleRetryRender(bubble.id)}
                  disabled={!projectId || isStreaming}
                  aria-label="Retry render"
                >
                  ↻ Retry render
                </button>
              </div>
            )}
          </div>
        );

      case "artifact":
        return (
          <div
            className="ai-video-studio__artifact-card"
            role="button"
            tabIndex={0}
            onClick={() => {
              setArtifactView({
                jobId: bubble.jobId,
                outputPath: bubble.outputPath,
                title: bubble.title,
                projectId: bubble.projectId,
              });
              setView("artifact");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setArtifactView({
                  jobId: bubble.jobId,
                  outputPath: bubble.outputPath,
                  title: bubble.title,
                  projectId: bubble.projectId,
                });
                setView("artifact");
              }
            }}
          >
            <div className="ai-video-studio__artifact-card-thumb">
              <img
                src={`/api/video-editor/projects/${encodeURIComponent(bubble.projectId)}/renders/${encodeURIComponent(bubble.jobId)}/thumb`}
                alt=""
                loading="lazy"
                onError={(e) => {
                  // Hide the broken <img> AND mark the wrapper as "no-thumb"
                  // so CSS can paint a placeholder gradient instead of an
                  // empty rectangle.
                  const img = e.target as HTMLImageElement;
                  img.style.display = "none";
                  img.parentElement?.classList.add("ai-video-studio__artifact-card-thumb--placeholder");
                }}
              />
              <div className="ai-video-studio__artifact-play" aria-hidden="true">▶</div>
            </div>
            <div className="ai-video-studio__artifact-card-info">
              <div className="ai-video-studio__artifact-card-title">{bubble.title}</div>
              <div className="ai-video-studio__artifact-card-label">Artifact</div>
            </div>
          </div>
        );

      case "tool":
        // Tool rows are surfaced inline inside the thinking bubble — there is
        // no separate top-level bubble for them. Keep the type for backward
        // compatibility with persisted chat history.
        return null;

      default:
        return null;
    }
  }
}

// ─── Simple markdown renderer for agent messages ────────────────────────────
function renderAgentMarkdown(text: string): React.ReactNode {
  // Split on fenced code blocks first so they can be rendered as <pre>; the
  // rest of the text still flows through the inline/heading/list pass.
  const segments: Array<{ kind: "code"; lang: string; body: string } | { kind: "text"; body: string }> = [];
  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > lastIndex) segments.push({ kind: "text", body: text.slice(lastIndex, m.index) });
    segments.push({ kind: "code", lang: m[1] || "", body: m[2] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) segments.push({ kind: "text", body: text.slice(lastIndex) });
  if (segments.length === 0) segments.push({ kind: "text", body: text });

  const inlineFormat = (str: string, key: string): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
    let last = 0; let mm; let k = 0;
    while ((mm = re.exec(str)) !== null) {
      if (mm.index > last) parts.push(<span key={`${key}-t${k++}`}>{str.slice(last, mm.index)}</span>);
      const tok = mm[0];
      if (tok.startsWith("**")) parts.push(<strong key={`${key}-b${k++}`}>{tok.slice(2, -2)}</strong>);
      else if (tok.startsWith("`")) parts.push(<code key={`${key}-c${k++}`} className="ai-video-studio__md-code">{tok.slice(1, -1)}</code>);
      else parts.push(<em key={`${key}-i${k++}`}>{tok.slice(1, -1)}</em>);
      last = mm.index + tok.length;
    }
    if (last < str.length) parts.push(<span key={`${key}-e`}>{str.slice(last)}</span>);
    return parts.length > 0 ? parts : str;
  };

  const result: React.ReactNode[] = [];
  segments.forEach((seg, segIdx) => {
    if (seg.kind === "code") {
      result.push(
        <pre key={`pre-${segIdx}`} className="ai-video-studio__md-pre" data-lang={seg.lang || undefined}>
          <code>{seg.body.replace(/\n$/, "")}</code>
        </pre>
      );
      return;
    }
    const lines = seg.body.split("\n");
    let li = 0;
    while (li < lines.length) {
      const line = lines[li];
      const headingMatch = /^(#{1,4})\s+(.*)/.exec(line);
      const ulMatch = /^[-*+]\s+(.*)/.exec(line);
      const olMatch = /^(\d+)\.\s+(.*)/.exec(line);
      const lineKey = `s${segIdx}-${li}`;
      if (headingMatch) {
        result.push(<div key={lineKey} className="ai-video-studio__md-heading">{inlineFormat(headingMatch[2], `h${lineKey}`)}</div>);
      } else if (ulMatch) {
        result.push(<div key={lineKey} className="ai-video-studio__md-li"><span className="ai-video-studio__md-bullet">•</span><span className="ai-video-studio__md-li-content">{inlineFormat(ulMatch[1], `ul${lineKey}`)}</span></div>);
      } else if (olMatch) {
        result.push(<div key={lineKey} className="ai-video-studio__md-li"><span className="ai-video-studio__md-bullet">{olMatch[1]}.</span><span className="ai-video-studio__md-li-content">{inlineFormat(olMatch[2], `ol${lineKey}`)}</span></div>);
      } else if (line.trim() === "") {
        if (li < lines.length - 1) result.push(<div key={lineKey} className="ai-video-studio__md-gap" />);
      } else {
        result.push(<div key={lineKey}>{inlineFormat(line, `ln${lineKey}`)}</div>);
      }
      li++;
    }
  });
  return <>{result}</>;
}

// ─── Tool label mapping ──────────────────────────────────────────────────────
function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    add_clip: "Adding clip",
    remove_clip: "Removing clip",
    trim_clip: "Trimming clip",
    set_clip_speed: "Setting speed",
    set_transition: "Setting transition",
    add_overlay: "Adding overlay",
    remove_overlay: "Removing overlay",
    add_audio: "Adding audio",
    set_export: "Setting format",
    propose: "Creating proposal",
    start_render: "Starting render",
    get_render_status: "Checking render",
    detect_logo_background: "Analyzing logo",
    read_project: "Reading project",
    read_timeline: "Reading timeline",
    read_assets: "Reading assets",
    clear_timeline: "Clearing timeline",
    fetch_video_info: "Fetching video info",
    download_youtube: "Downloading video",
    clip_cut_youtube: "Cutting clip",
    probe_video: "Probing video",
    split_clip: "Splitting clip",
    reorder_clips: "Reordering clips",
    cancel_render: "Cancelling render",
    generate_subtitles: "Generating subtitles",
    find_best_clips: "Finding best clips",
    generate_timestamps: "Generating timestamps",
  };
  return labels[name] || name;
}
