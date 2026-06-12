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
} from "@/lib/video-editor-api";

// ─── Types ────────────────────────────────────────────────────────────────────
type ViewState = "landing" | "chat" | "artifact";

type AttachedAsset = {
  id: string;
  name: string;
  type: "video" | "image" | "audio" | "youtube";
  path?: string;
  file?: File;
  url?: string;
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
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fileTypeFromExt(name: string): AttachedAsset["type"] {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mov", "avi", "mkv", "webm", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac"].includes(ext)) return "audio";
  return "image";
}

const FEATURE_TILES = [
  { icon: "✂️", title: "Cut & Join Clips", desc: "Trim, join, and rearrange video segments", prefill: "I'll help you cut and join video clips. Upload your videos to start." },
  { icon: "🎨", title: "Add Branding", desc: "Logo, date text, watermarks", prefill: "Upload your video and logo — I'll add branding and polish it." },
  { icon: "📱", title: "Make Reels", desc: "Vertical format for social media", prefill: "Upload your video — I'll make it vertical for Instagram Reels or YouTube Shorts." },
  { icon: "🔗", title: "From YouTube", desc: "Download and edit from a link", prefill: "" },
  { icon: "✨", title: "Clean & Polish", desc: "Trim, fix audio, color grade", prefill: "Upload a video and I'll clean it up — trim dead air, fix audio, color grade." },
];

// ─── Component ────────────────────────────────────────────────────────────────
export function AiVideoStudio() {
  const [view, setView] = useState<ViewState>("landing");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<EditorProject | null>(null);
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [inputText, setInputText] = useState("");
  const [attachedAssets, setAttachedAssets] = useState<AttachedAsset[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [showAttachPopover, setShowAttachPopover] = useState(false);
  const [artifactView, setArtifactView] = useState<{
    jobId: string;
    outputPath: string;
    title: string;
    projectId: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [activeCapabilities, setActiveCapabilities] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const [historyProjects, setHistoryProjects] = useState<EditorProjectSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<{ cancel: () => void } | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles]);

  // Load history when panel opens
  useEffect(() => {
    if (!showHistory) return;
    setHistoryLoading(true);
    videoEditorApi.listProjects()
      .then(({ projects }) => {
        setHistoryProjects(projects.sort((a, b) => b.updatedAt - a.updatedAt));
      })
      .catch(() => setHistoryProjects([]))
      .finally(() => setHistoryLoading(false));
  }, [showHistory]);

  // Load a project from history
  const loadProject = useCallback(async (pid: string) => {
    try {
      const { project: loaded } = await videoEditorApi.getProject(pid);
      setProjectId(loaded.projectId);
      setProject(loaded);
      setBubbles([]);
      setShowHistory(false);
      setView("chat");
      // Load chat history
      try {
        const { messages } = await videoEditorApi.getChat(pid);
        const restored: ChatBubble[] = messages.map((m) => {
          if (m.role === "user") {
            return { kind: "user" as const, id: m.id, text: m.content, assets: [] as AttachedAsset[] };
          }
          return { kind: "assistant" as const, id: m.id, text: m.content };
        });
        setBubbles(restored);
      } catch { /* no chat history */ }
    } catch (err) {
      console.error("Failed to load project:", err);
    }
  }, []);

  // Auto-resize textarea
  const adjustTextarea = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, []);

  useEffect(() => {
    adjustTextarea();
  }, [inputText, adjustTextarea]);

  // ─── File Handling ──────────────────────────────────────────────────────────
  const handleFileAttach = useCallback((files: FileList | File[]) => {
    const newAssets: AttachedAsset[] = Array.from(files).map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      type: fileTypeFromExt(f.name),
      file: f,
    }));
    setAttachedAssets((prev) => [...prev, ...newAssets]);
    setShowAttachPopover(false);
  }, []);

  const removeAsset = useCallback((id: string) => {
    setAttachedAssets((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ─── Drag and Drop ─────────────────────────────────────────────────────────
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);
  const handleDragLeave = useCallback(() => setIsDragging(false), []);
  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
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

      // Upload attached files
      const uploaded = [...attachedAssets];
      for (const asset of uploaded) {
        if (asset.file) {
          const role = asset.type === "video" ? "source" : asset.type === "audio" ? "intro" : "logo";
          const result = await videoEditorApi.uploadAsset(pid, role as any, asset.file);
          asset.path = result.path;
        }
      }

      // Add user bubble
      const userBubble: ChatBubble = {
        kind: "user",
        id: crypto.randomUUID(),
        text,
        assets: uploaded,
      };
      setBubbles((prev) => [...prev, userBubble]);
      setAttachedAssets([]);

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
      setBubbles((prev) => [
        ...prev,
        { kind: "assistant", id: crypto.randomUUID(), text: `Error: ${(err as Error).message}` },
      ]);
      setIsStreaming(false);
    }
  }, [inputText, attachedAssets, projectId, isStreaming, activeCapabilities]);

  // ─── Stream Chat ────────────────────────────────────────────────────────────
  const streamChat = useCallback(
    (pid: string, message: string) => {
      let thinkingId: string | null = null;
      const thinkingSteps: string[] = [];
      let assistantId: string | null = null;
      let assistantText = "";

      const handle = videoEditorApi.streamChat(pid, message, {
        onEvent: (event: EditorChatEvent) => {
          switch (event.type) {
            case "thinking":
              if (!thinkingId) {
                thinkingId = crypto.randomUUID();
                setBubbles((prev) => [...prev, { kind: "thinking", id: thinkingId!, steps: ["Thinking..."] }]);
              }
              break;

            case "text":
              if (!assistantId) {
                assistantId = crypto.randomUUID();
                if (thinkingId) {
                  setBubbles((prev) => prev.filter((b) => b.id !== thinkingId));
                  thinkingId = null;
                }
                assistantText = event.content;
                setBubbles((prev) => [...prev, { kind: "assistant", id: assistantId!, text: assistantText }]);
              } else {
                assistantText += event.content;
                setBubbles((prev) =>
                  prev.map((b) => (b.id === assistantId ? { ...b, text: assistantText } : b))
                );
              }
              break;

            case "tool_start":
              thinkingSteps.push(`${getToolLabel(event.name)}...`);
              if (thinkingId) {
                setBubbles((prev) =>
                  prev.map((b) => (b.id === thinkingId ? { ...b, steps: [...thinkingSteps] } : b))
                );
              } else {
                thinkingId = crypto.randomUUID();
                setBubbles((prev) => [...prev, { kind: "thinking", id: thinkingId!, steps: [...thinkingSteps] }]);
              }
              break;

            case "tool_done":
              if (event.name) {
                const idx = thinkingSteps.findIndex((s) => s.startsWith(getToolLabel(event.name)));
                if (idx >= 0) {
                  thinkingSteps[idx] = `✓ ${getToolLabel(event.name)}`;
                  if (thinkingId) {
                    setBubbles((prev) =>
                      prev.map((b) => (b.id === thinkingId ? { ...b, steps: [...thinkingSteps] } : b))
                    );
                  }
                }
              }
              if (event.project) setProject(event.project);
              // Check for completed renders
              if (event.job && event.job.status === "done" && event.job.outputPath && pid) {
                setBubbles((prev) => [
                  ...prev,
                  {
                    kind: "artifact",
                    id: crypto.randomUUID(),
                    title: project?.title || "Rendered Video",
                    jobId: event.job!.jobId,
                    outputPath: event.job!.outputPath!,
                    projectId: pid,
                  },
                ]);
              }
              break;

            case "proposal":
              if (thinkingId) {
                setBubbles((prev) => prev.filter((b) => b.id !== thinkingId));
                thinkingId = null;
              }
              // Also clear any assistant text that was building
              assistantId = null;
              assistantText = "";
              setBubbles((prev) => [
                ...prev,
                {
                  kind: "proposal",
                  id: crypto.randomUUID(),
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
              if (thinkingId) {
                setBubbles((prev) => prev.filter((b) => b.id !== thinkingId));
                thinkingId = null;
              }
              setIsStreaming(false);
              // Check for newly completed renders
              if (project) {
                checkForCompletedRender(pid);
              }
              break;

            case "error":
              if (thinkingId) {
                setBubbles((prev) => prev.filter((b) => b.id !== thinkingId));
                thinkingId = null;
              }
              setIsStreaming(false);
              setBubbles((prev) => [
                ...prev,
                { kind: "assistant", id: crypto.randomUUID(), text: `⚠️ ${event.message}` },
              ]);
              break;
          }
        },
        onError: (err) => {
          setIsStreaming(false);
          setBubbles((prev) => [
            ...prev,
            { kind: "assistant", id: crypto.randomUUID(), text: `Connection error: ${err.message}` },
          ]);
        },
        onClose: () => {
          setIsStreaming(false);
        },
      });
      streamRef.current = handle;
    },
    [project]
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
                id: crypto.randomUUID(),
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
          { kind: "system" as const, id: crypto.randomUUID(), text: "✅ Plan approved! Starting render..." },
        ]);
        // Start render polling
        streamChat(projectId, "The user approved the proposal. Start the final render now.");
        // Poll for render progress after a delay
        setTimeout(() => startRenderPolling(projectId), 3000);
      } catch (err) {
        console.error("Apply error:", err);
      }
    },
    [projectId, streamChat]
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
  const renderPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRenderPolling = useCallback(
    (pid: string) => {
      if (renderPollRef.current) clearInterval(renderPollRef.current);
      const progressBubbleId = crypto.randomUUID();
      setBubbles((prev) => [
        ...prev,
        { kind: "render-progress" as const, id: progressBubbleId, jobId: "", progress: 0, message: "Starting render...", status: "pending" },
      ]);
      renderPollRef.current = setInterval(async () => {
        try {
          const { project: latest } = await videoEditorApi.getProject(pid);
          setProject(latest);
          const activeRender = latest.renders[0];
          if (!activeRender) return;
          // Update progress bubble
          setBubbles((prev) =>
            prev.map((b) =>
              b.id === progressBubbleId && b.kind === "render-progress"
                ? { kind: "render-progress" as const, id: b.id, jobId: activeRender.jobId, progress: activeRender.progress ?? 0, message: activeRender.message || "Rendering...", status: activeRender.status }
                : b
            )
          );
          if (activeRender.status === "done") {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            renderPollRef.current = null;
            // Remove progress bubble and add artifact
            setBubbles((prev) => {
              const without = prev.filter((b) => b.id !== progressBubbleId);
              const exists = without.some((b) => b.kind === "artifact" && (b as any).jobId === activeRender.jobId);
              if (exists) return without;
              return [
                ...without,
                {
                  kind: "artifact" as const,
                  id: crypto.randomUUID(),
                  title: latest.title || "Rendered Video",
                  jobId: activeRender.jobId,
                  outputPath: activeRender.outputPath || "",
                  projectId: pid,
                },
              ];
            });
          } else if (activeRender.status === "error") {
            if (renderPollRef.current) clearInterval(renderPollRef.current);
            renderPollRef.current = null;
            // Update progress to show error
            setBubbles((prev) =>
              prev.map((b) =>
                b.id === progressBubbleId && b.kind === "render-progress"
                  ? { kind: "render-progress" as const, id: b.id, jobId: b.jobId, progress: 0, message: activeRender.message || "Render failed", status: "error" }
                  : b
              )
            );
          }
        } catch { /* polling error, ignore */ }
      }, 2500);
    },
    []
  );

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (renderPollRef.current) clearInterval(renderPollRef.current);
    };
  }, []);

  // ─── Quick Actions ─────────────────────────────────────────────────────────
  const handleQuickAction = useCallback(
    (text: string) => {
      if (!projectId || isStreaming) return;
      setIsStreaming(true);
      const bubble: ChatBubble = { kind: "user", id: crypto.randomUUID(), text, assets: [] };
      setBubbles((prev) => [...prev, bubble]);
      streamChat(projectId, text);
    },
    [projectId, isStreaming, streamChat]
  );

  // ─── Key Handling ──────────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
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
              href={`/api/workspace/files/presign?path=${encodeURIComponent(artifactView.outputPath)}`}
              target="_blank"
              rel="noreferrer"
              className="ai-video-studio__artifact-action-btn"
            >
              ↓ Download
            </a>
          </div>
          <div className="ai-video-studio__artifact-player">
            <video
              controls
              autoPlay
              src={`/api/workspace/files/presign?path=${encodeURIComponent(artifactView.outputPath)}`}
              className="ai-video-studio__video-el"
            />
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
              className="ai-video-studio__topbar-btn"
              title="History"
              onClick={() => setShowHistory(true)}
            >
              📋
            </button>
            <button
              className="ai-video-studio__topbar-btn"
              title="New project"
              onClick={() => {
                setView("landing");
                setProjectId(null);
                setProject(null);
                setBubbles([]);
                streamRef.current?.cancel();
              }}
            >
              ＋
            </button>
          </div>
        </div>

        {/* History panel in chat view */}
        <AnimatePresence>
          {showHistory && (
            <>
              <motion.div
                className="ai-video-studio__history-backdrop"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowHistory(false)}
              />
              <motion.div
                className="ai-video-studio__history-panel"
                initial={{ x: -320 }}
                animate={{ x: 0 }}
                exit={{ x: -320 }}
                transition={{ type: "spring", damping: 28, stiffness: 300 }}
              >
                <div className="ai-video-studio__history-header">
                  <span className="ai-video-studio__history-title">Recent Projects</span>
                  <button className="ai-video-studio__history-close" onClick={() => setShowHistory(false)}>×</button>
                </div>
                <div className="ai-video-studio__history-list">
                  {historyLoading ? (
                    <div className="ai-video-studio__history-empty">Loading...</div>
                  ) : historyProjects.length === 0 ? (
                    <div className="ai-video-studio__history-empty">No projects yet</div>
                  ) : (
                    historyProjects.map((p) => (
                      <button
                        key={p.projectId}
                        className={`ai-video-studio__history-item ${p.projectId === projectId ? "ai-video-studio__history-item--active" : ""}`}
                        onClick={() => loadProject(p.projectId)}
                      >
                        <div className="ai-video-studio__history-item-icon">🎬</div>
                        <div className="ai-video-studio__history-item-info">
                          <div className="ai-video-studio__history-item-title">{p.title || "Untitled"}</div>
                          <div className="ai-video-studio__history-item-date">
                            {new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Messages */}
        <div className="ai-video-studio__messages">
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

        {/* Quick actions */}
        {!isStreaming && bubbles.length > 0 && bubbles[bubbles.length - 1]?.kind !== "user" && (
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
              placeholder="Enter your next prompt..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isStreaming}
            />
            <button
              className="ai-video-studio__send-btn"
              onClick={handleSubmit}
              disabled={isStreaming || (!inputText.trim() && attachedAssets.length === 0)}
            >
              {isStreaming ? "●" : "↑"}
            </button>
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

      {/* History slide-out panel */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div
              className="ai-video-studio__history-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
            />
            <motion.div
              className="ai-video-studio__history-panel"
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{ type: "spring", damping: 28, stiffness: 300 }}
            >
              <div className="ai-video-studio__history-header">
                <span className="ai-video-studio__history-title">Recent Projects</span>
                <button className="ai-video-studio__history-close" onClick={() => setShowHistory(false)}>×</button>
              </div>
              <div className="ai-video-studio__history-list">
                {historyLoading ? (
                  <div className="ai-video-studio__history-empty">Loading...</div>
                ) : historyProjects.length === 0 ? (
                  <div className="ai-video-studio__history-empty">No projects yet</div>
                ) : (
                  historyProjects.map((p) => (
                    <button
                      key={p.projectId}
                      className="ai-video-studio__history-item"
                      onClick={() => loadProject(p.projectId)}
                    >
                      <div className="ai-video-studio__history-item-icon">🎬</div>
                      <div className="ai-video-studio__history-item-info">
                        <div className="ai-video-studio__history-item-title">{p.title || "Untitled"}</div>
                        <div className="ai-video-studio__history-item-date">
                          {new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

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
            {[
              { key: "auto-edit", icon: "🎬", label: "Auto Edit" },
              { key: "auto-format", icon: "📐", label: "Auto Format" },
              { key: "auto-brand", icon: "🎨", label: "Auto Brand" },
            ].map((pill) => (
              <button
                key={pill.key}
                className={`ai-video-studio__cap-pill ${activeCapabilities.has(pill.key) ? "ai-video-studio__cap-pill--active" : ""}`}
                onClick={() =>
                  setActiveCapabilities((prev) => {
                    const next = new Set(prev);
                    next.has(pill.key) ? next.delete(pill.key) : next.add(pill.key);
                    return next;
                  })
                }
              >
                <span>{pill.icon}</span>
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
            <button key={tile.title} className="ai-video-studio__tile" onClick={() => handleTileClick(tile)}>
              <span className="ai-video-studio__tile-icon">{tile.icon}</span>
              <span className="ai-video-studio__tile-title">{tile.title}</span>
              <span className="ai-video-studio__tile-desc">{tile.desc}</span>
              <span className="ai-video-studio__tile-arrow">→</span>
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
                {bubble.assets.map((a) => (
                  <div key={a.id} className="ai-video-studio__msg-asset-chip">
                    <span className="ai-video-studio__asset-chip-icon">
                      {a.type === "video" ? "▶" : a.type === "audio" ? "♪" : "🖼"}
                    </span>
                    <div>
                      <div className="ai-video-studio__msg-asset-name">{a.name}</div>
                      <div className="ai-video-studio__msg-asset-type">{a.type}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {bubble.text && <div className="ai-video-studio__msg-text">{bubble.text}</div>}
          </div>
        );

      case "assistant":
        return (
          <div className="ai-video-studio__agent-msg">
            <div className="ai-video-studio__msg-text">{bubble.text}</div>
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
                  disabled={isStreaming}
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
          </div>
        );

      case "artifact":
        return (
          <div
            className="ai-video-studio__artifact-card"
            onClick={() => {
              setArtifactView({
                jobId: bubble.jobId,
                outputPath: bubble.outputPath,
                title: bubble.title,
                projectId: bubble.projectId,
              });
              setView("artifact");
            }}
          >
            <div className="ai-video-studio__artifact-card-thumb">
              <img
                src={`/api/video-editor/projects/${encodeURIComponent(bubble.projectId)}/renders/${encodeURIComponent(bubble.jobId)}/thumb`}
                alt="Video thumbnail"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
              <div className="ai-video-studio__artifact-play">▶</div>
            </div>
            <div className="ai-video-studio__artifact-card-info">
              <div className="ai-video-studio__artifact-card-title">{bubble.title}</div>
              <div className="ai-video-studio__artifact-card-label">Artifact</div>
            </div>
          </div>
        );

      case "tool":
        return null;

      default:
        return null;
    }
  }
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
  };
  return labels[name] || name;
}
