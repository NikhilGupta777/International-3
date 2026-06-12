import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, Download, FileVideo, ImagePlus, Loader2, Play, Plus, Send,
  Settings2, Sparkles, UploadCloud, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatBytes, workspaceApi } from "@/lib/workspace-api";
import {
  videoEditorApi,
  type EditRecipe,
  type EditorAssets,
  type EditorChatEvent,
  type EditorChatMessage,
  type EditorProject,
} from "@/lib/video-editor-api";
import { cn } from "@/lib/utils";

type AssetRole = "source" | "logo" | "intro" | "outro";

const STARTER_MESSAGE =
  'Make this a polished vertical short. Cut down, add the logo top right, remove logo white background, add "22 FEB, 2026" at the bottom, use intro/outro.';

function recipeSummary(recipe: EditRecipe): string {
  const ov = recipe.overlays
    .map((o) => o.type === "logo" ? `logo ${o.position}` : `“${o.text}”`)
    .join(" + ") || "no overlays";
  return `${recipe.aspectRatio} · ${recipe.cropMode} · ${ov}`;
}

export function AiVideoStudio() {
  const { toast } = useToast();
  const [project, setProject] = useState<EditorProject | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);

  const [messages, setMessages] = useState<EditorChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState<{ iteration: number; total: number } | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [logoMockUrl, setLogoMockUrl] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState<Record<string, { status: string; progress: number; message: string }>>({});
  const [newOverlayText, setNewOverlayText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [renderHistoryUrls, setRenderHistoryUrls] = useState<Record<string, string>>({});
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [renderThumbs, setRenderThumbs] = useState<Record<string, string>>({});
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const PROJECT_STORAGE_KEY = "vm-editor-active-project-v1";

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRoleRef = useRef<AssetRole>("source");
  const streamCancelRef = useRef<{ cancel: () => void } | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const recipe = project?.recipe;
  const assets = project?.assets ?? {};
  const hasSource = Boolean(project?.sourceVideo);

  const assetRows = useMemo(() => ([
    { role: "source" as const, label: "Source", value: project?.sourceVideo, icon: FileVideo },
    { role: "logo" as const, label: "Logo", value: assets.logo, icon: ImagePlus },
    { role: "intro" as const, label: "Intro", value: assets.intro, icon: Play },
    { role: "outro" as const, label: "Outro", value: assets.outro, icon: Download },
  ]), [assets.intro, assets.logo, assets.outro, project?.sourceVideo]);

  const ensureProject = useCallback(async (): Promise<EditorProject> => {
    if (project) return project;
    const res = await videoEditorApi.createProject({ prompt: STARTER_MESSAGE });
    setProject(res.project);
    try { localStorage.setItem(PROJECT_STORAGE_KEY, res.project.projectId); } catch { /* ignore */ }
    return res.project;
  }, [project]);

  // Restore last active project on mount.
  useEffect(() => {
    if (project) return;
    let cancelled = false;
    const stored = (() => { try { return localStorage.getItem(PROJECT_STORAGE_KEY); } catch { return null; } })();
    if (!stored) return;
    void videoEditorApi.getProject(stored).then(async (res) => {
      if (cancelled) return;
      setProject(res.project);
      if (res.project.sourceVideo) {
        try {
          const file = await workspaceApi.getFile(res.project.sourceVideo, { inline: true });
          if (!cancelled) setSourcePreviewUrl(file.url);
        } catch { /* ignore */ }
      }
    }).catch(() => {
      try { localStorage.removeItem(PROJECT_STORAGE_KEY); } catch { /* ignore */ }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [messages, thinking, activeTool]);

  useEffect(() => () => streamCancelRef.current?.cancel(), []);

  // Load chat history when project becomes available.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    videoEditorApi.getChat(project.projectId).then((res) => {
      if (!cancelled && res.messages.length) setMessages(res.messages);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [project?.projectId]);

  // Resolve logo asset to an inline preview URL.
  useEffect(() => {
    if (!assets.logo) { setLogoMockUrl(null); return; }
    let cancelled = false;
    workspaceApi.getFile(assets.logo, { inline: true })
      .then((file) => { if (!cancelled) setLogoMockUrl(file.url); })
      .catch(() => { if (!cancelled) setLogoMockUrl(null); });
    return () => { cancelled = true; };
  }, [assets.logo]);

  // Resolve completed renders to inline URLs (for the history list).
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    try { localStorage.setItem(PROJECT_STORAGE_KEY, project.projectId); } catch { /* ignore */ }
    const done = project.renders.filter((r) => r.status === "done" && r.outputPath);
    void Promise.all(done.map(async (r) => {
      if (renderHistoryUrls[r.jobId]) return;
      try {
        const f = await workspaceApi.getFile(r.outputPath!, { inline: true });
        if (!cancelled) setRenderHistoryUrls((prev) => ({ ...prev, [r.jobId]: f.url }));
      } catch { /* ignore */ }
    }));
    return () => { cancelled = true; };
  }, [project?.renders, project?.projectId]);

  // Server-side thumbnail (CORS-safe) with canvas fallback if the server
  // endpoint fails. Uses a deterministic /thumb URL — browser caches it.
  useEffect(() => {
    if (!project) return;
    project.renders.filter((r) => r.status === "done" && r.outputPath).forEach((r) => {
      if (renderThumbs[r.jobId]) return;
      const url = `/api/video-editor/projects/${encodeURIComponent(project.projectId)}/renders/${encodeURIComponent(r.jobId)}/thumb`;
      // Verify the endpoint actually returns an image, then set; otherwise fall back to canvas.
      void fetch(url, { credentials: "include" }).then(async (resp) => {
        if (!resp.ok) throw new Error("thumb endpoint failed");
        const ct = resp.headers.get("content-type") || "";
        if (!ct.startsWith("image/")) throw new Error("not image");
        setRenderThumbs((prev) => ({ ...prev, [r.jobId]: url }));
      }).catch(() => {
        const inline = renderHistoryUrls[r.jobId];
        if (!inline) return;
        const video = document.createElement("video");
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.preload = "metadata";
        video.src = inline;
        video.addEventListener("loadedmetadata", () => {
          try { video.currentTime = Math.min(0.5, Math.max(0, video.duration / 6)); } catch { /* ignore */ }
        });
        video.addEventListener("seeked", () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = 160;
            canvas.height = Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * 160);
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              setRenderThumbs((prev) => ({ ...prev, [r.jobId]: canvas.toDataURL("image/jpeg", 0.65) }));
            }
          } catch { /* ignore */ }
        });
      });
    });
  }, [project?.renders, project?.projectId, renderHistoryUrls, renderThumbs]);

  const chooseFile = (role: AssetRole) => {
    pendingRoleRef.current = role;
    setAttachOpen(false);
    fileInputRef.current?.click();
  };

  const uploadFile = async (file: File, role: AssetRole) => {
    try {
      const current = await ensureProject();
      toast({ title: `Uploading ${role}...`, description: file.name });
      const uploaded = await videoEditorApi.uploadAsset(current.projectId, role, file);
      const nextAssets: EditorAssets = {
        ...current.assets,
        ...(role === "logo" ? { logo: uploaded.path } : {}),
        ...(role === "intro" ? { intro: uploaded.path } : {}),
        ...(role === "outro" ? { outro: uploaded.path } : {}),
      };
      const nextSource = role === "source" ? uploaded.path : current.sourceVideo;
      const res = await videoEditorApi.generateRecipe(current.projectId, {
        prompt: current.prompt || STARTER_MESSAGE,
        sourceVideo: nextSource,
        assets: nextAssets,
      });
      setProject(res.project);
      if (role === "source") {
        const fileInfo = await workspaceApi.getFile(uploaded.path, { inline: true });
        setSourcePreviewUrl(fileInfo.url);
      }
      toast({ title: "Asset added", description: `${file.name} (${formatBytes(uploaded.size)}).` });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Could not upload asset.",
        variant: "destructive",
      });
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await uploadFile(file, pendingRoleRef.current);
  };

  const inferRoleFromFile = (file: File): AssetRole => {
    if (file.type.startsWith("image/")) return "logo";
    return project?.sourceVideo ? (assets.intro ? "outro" : "intro") : "source";
  };

  const handleStudioDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    for (const file of files) {
      await uploadFile(file, inferRoleFromFile(file));
    }
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const current = await ensureProject();
    setInput("");
    setStreaming(true);
    setThinking({ iteration: 0, total: 6 });
    const placeholderUser: EditorChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, placeholderUser]);
    setExpanded(true);
    streamCancelRef.current = videoEditorApi.streamChat(current.projectId, text, {
      onEvent: (event) => handleChatEvent(event, placeholderUser.id),
      onError: (err) => {
        setStreaming(false);
        setThinking(null);
        setActiveTool(null);
        toast({ title: "Chat failed", description: err.message, variant: "destructive" });
      },
      onClose: () => {
        setStreaming(false);
        setThinking(null);
        setActiveTool(null);
      },
    });
  }, [ensureProject, input, streaming, toast]);

  const handleChatEvent = (event: EditorChatEvent, userId: string) => {
    switch (event.type) {
      case "thinking":
        setThinking({ iteration: event.iteration, total: event.total });
        break;
      case "tool_start":
        setActiveTool(event.name);
        setMessages((prev) => [...prev, {
          id: event.toolCallId ? `t-${event.toolCallId}` : `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "tool",
          content: `${event.name}`,
          tool: { name: event.name, args: event.args },
          createdAt: Date.now(),
        }]);
        break;
      case "tool_done":
        setActiveTool(null);
        setMessages((prev) => {
          const matchId = event.toolCallId ? `t-${event.toolCallId}` : null;
          return prev.map((m) => {
            if (matchId ? m.id === matchId : (m.role === "tool" && m.tool?.name === event.name && !m.tool?.result)) {
              return { ...m, content: event.ok ? (event.message || event.name) : (event.error || "failed"), tool: { ...(m.tool || { name: event.name }), result: event } };
            }
            return m;
          });
        });
        if (event.project) setProject(event.project);
        if (event.job?.jobId) void pollJob(event.job.jobId);
        break;
      case "project":
        setProject(event.project);
        break;
      case "user_message":
        setMessages((prev) => prev.map((m) => m.id === userId ? event.message : m));
        break;
      case "assistant_message":
        setMessages((prev) => [...prev, event.message]);
        break;
      case "text":
        // Stream partial text into an in-progress assistant bubble.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && (last.id.startsWith("stream-"))) {
            return [...prev.slice(0, -1), { ...last, content: last.content + event.content }];
          }
          return [...prev, { id: `stream-${Date.now()}`, role: "assistant", content: event.content, createdAt: Date.now() }];
        });
        break;
      case "error":
        toast({ title: "Agent error", description: event.message, variant: "destructive" });
        break;
      case "done":
        setStreaming(false);
        setThinking(null);
        setActiveTool(null);
        break;
    }
  };

  const pollJob = async (jobId: string) => {
    let lastKey = "";
    for (let i = 0; i < 240; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const { job } = await videoEditorApi.getJob(jobId);
        setRenderProgress((prev) => ({ ...prev, [jobId]: { status: job.status, progress: job.progress, message: job.message } }));
        const key = `${job.status}:${Math.floor(job.progress / 20)}`;
        if (key !== lastKey) {
          lastKey = key;
          setMessages((prev) => [...prev, {
            id: `prog-${jobId}-${i}`,
            role: "tool",
            content: `${job.status} · ${job.progress}% — ${job.message}`,
            tool: { name: `${job.kind} render`, result: { jobId } },
            createdAt: Date.now(),
          }]);
        }
        if (job.status === "done" && job.outputPath) {
          const file = await workspaceApi.getFile(job.outputPath, { inline: true });
          setRenderUrl(file.url);
          if (project) {
            const latest = await videoEditorApi.getProject(project.projectId);
            setProject(latest.project);
          }
          toast({ title: "Render ready", description: job.outputPath });
          return;
        }
        if (job.status === "error" || job.status === "cancelled") return;
      } catch {
        return;
      }
    }
  };

  const patchRecipe = async (patch: Partial<EditRecipe>) => {
    if (!project) return;
    try {
      const res = await videoEditorApi.patchRecipe(project.projectId, patch);
      setProject(res.project);
    } catch (err) {
      toast({ title: "Update failed", description: err instanceof Error ? err.message : "Could not update.", variant: "destructive" });
    }
  };

  const QUICK_CHIPS = [
    { label: "Make 9:16", prompt: "Make this vertical 9:16 with smart crop." },
    { label: "Add date", prompt: 'Add "22 FEB, 2026" at the bottom in bold-clean style.' },
    { label: "Logo top right", prompt: "Place the logo top-right and remove its white background." },
    { label: "Use intro + outro", prompt: "Use the intro and outro with fade transitions." },
    { label: "Preview render", prompt: "Render a quick preview so I can check the placement." },
    { label: "Final render", prompt: "Render the final video at 1080p." },
  ];

  return (
    <div
      className={cn("ai-video-studio", dragging && "is-dragging")}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={handleStudioDrop}
    >
      {dragging ? (
        <div className="ai-video-studio__dropzone">
          <UploadCloud className="h-10 w-10" />
          <strong>Drop to add to project</strong>
          <span>Videos → source · Images → logo · Extra videos → intro/outro</span>
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="video/*,image/png,image/jpeg,image/webp"
        onChange={handleUpload}
      />

      <header className="ai-video-studio__header">
        <div>
          <div className="ai-video-studio__kicker">
            <Bot className="h-4 w-4" />
            AI Video Studio
          </div>
          <h1>Finish videos with a chat-driven AI agent</h1>
          <p>Drop assets, then tell the agent what to do. It edits the recipe and runs the render.</p>
        </div>
      </header>

      <div className="ai-video-studio__grid">
        <section className="ai-video-studio__panel ai-video-studio__assets">
          <div className="ai-video-studio__panel-title">
            <UploadCloud className="h-4 w-4" />
            Assets
          </div>
          <div className="ai-video-studio__asset-list">
            {assetRows.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.role} className="ai-video-studio__asset-row">
                  <Icon className="h-4 w-4 text-white/45" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-white/85">{item.label}</div>
                    <div className="truncate text-xs text-white/35">{item.value || "Not added"}</div>
                  </div>
                  <button type="button" onClick={() => chooseFile(item.role)}>
                    {item.value ? "Replace" : "Upload"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        <section className="ai-video-studio__preview">
          <div className={cn(
            "ai-video-studio__screen",
            recipe?.aspectRatio === "9:16" && "is-vertical",
            recipe?.aspectRatio === "1:1" && "is-square",
          )}>
            {renderUrl || sourcePreviewUrl ? (
              <video
                ref={sourceVideoRef}
                src={renderUrl || sourcePreviewUrl || undefined}
                controls
                className="h-full w-full object-contain"
                onLoadedMetadata={(e) => {
                  const d = (e.currentTarget as HTMLVideoElement).duration;
                  if (Number.isFinite(d) && d > 0) setSourceDuration(d);
                }}
              />
            ) : (
              <div className="ai-video-studio__empty-preview">
                <FileVideo className="h-10 w-10" />
                <strong>{hasSource ? "Source ready" : "Drop a video to start"}</strong>
                <span>{hasSource
                  ? "Pick a quick action below, or describe the final cut."
                  : "Drag a video anywhere, or click Upload in Assets."}</span>
              </div>
            )}
            {recipe?.overlays.map((item, index) => {
              if (item.type === "text") {
                const cls = `ai-video-studio__mock-text pos-${item.position}`;
                return <div key={`${item.type}-${index}`} className={cls}>{item.text}</div>;
              }
              return (
                <div
                  key={`${item.type}-${index}`}
                  className={`ai-video-studio__mock-logo pos-${item.position}`}
                  style={{ width: `${item.widthPercent}%` }}
                >
                  {logoMockUrl ? <img src={logoMockUrl} alt="logo" /> : <span>LOGO</span>}
                </div>
              );
            })}
          </div>
          <div className="ai-video-studio__render-actions">
            {renderUrl ? (
              <a className="ai-video-studio__download" href={renderUrl} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" />
                Open Output
              </a>
            ) : null}
            <Button variant="glass" disabled={!project || !hasSource || streaming} onClick={() => { setInput("render a quick preview"); void send(); }}>
              <Play className="h-4 w-4" />
              Preview Render
            </Button>
            <Button disabled={!project || !hasSource || streaming} onClick={() => { setInput("render the final video"); void send(); }}>
              <Sparkles className="h-4 w-4" />
              Final Render
            </Button>
          </div>
        </section>

        <section className="ai-video-studio__panel ai-video-studio__agent">
          <div className="ai-video-studio__panel-title">
            <Bot className="h-4 w-4" />
            Recipe
          </div>
          {recipe ? (
            <div className="ai-video-studio__recipe">
              <div><span>Aspect</span><strong>{recipe.aspectRatio}</strong></div>
              <div><span>Crop</span><strong>{recipe.cropMode}</strong></div>
              <div><span>Overlays</span><strong>{recipeSummary(recipe)}</strong></div>
              <div><span>Trim</span><strong>{recipe.trim.start}s → {recipe.trim.end ?? (sourceDuration ? `${Math.round(sourceDuration)}s` : "end")}</strong></div>
              {sourceDuration ? <div><span>Source</span><strong>{Math.round(sourceDuration)}s</strong></div> : null}
              <div><span>Intro</span><strong>{recipe.intro.enabled ? "Enabled" : "Off"}</strong></div>
              <div><span>Outro</span><strong>{recipe.outro.enabled ? "Enabled" : "Off"}</strong></div>
              <div><span>Transitions</span><strong>{recipe.transitions?.fade === false ? "Hard cut" : "Fade"}</strong></div>
            </div>
          ) : (
            <div className="ai-video-studio__empty-recipe">Upload a video, then ask the agent to plan.</div>
          )}
          {project?.renders?.[0] ? (() => {
            const r = project.renders[0];
            const live = renderProgress[r.jobId];
            return (
              <div className="ai-video-studio__job">
                <span>{r.kind} render</span>
                <strong>{live?.status ?? r.status} · {live?.progress ?? r.progress}%</strong>
                <p>{live?.message ?? r.message}</p>
              </div>
            );
          })() : null}

          {project?.renders && project.renders.length > 1 ? (
            <div className="ai-video-studio__history">
              <div className="ai-video-studio__history-title">History</div>
              {project.renders.slice(1, 7).map((r) => {
                const url = renderHistoryUrls[r.jobId];
                const thumb = renderThumbs[r.jobId];
                return (
                  <div key={r.jobId} className="ai-video-studio__history-row">
                    <div className="thumb">
                      {thumb ? <img src={thumb} alt="" /> : <div className="thumb-placeholder" />}
                    </div>
                    <div className="meta">
                      <span className="kind">{r.kind}</span>
                      <span className="status">{r.status}</span>
                    </div>
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer">Open</a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      </div>

      {/* Quick action chips above the dock */}
      {hasSource ? (
        <div className="ai-video-studio__quick">
          {QUICK_CHIPS.map((chip) => (
            <button
              key={chip.label}
              type="button"
              disabled={streaming}
              onClick={() => { setInput(chip.prompt); }}
              className="ai-video-studio__quick-chip"
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* Chat dock */}
      <div className={cn("ai-video-studio__dock", expanded && "is-expanded")}>
        {expanded ? (
          <div className="ai-video-studio__dock-transcript" ref={transcriptRef}>
            {messages.length === 0 ? (
              <div className="ai-video-studio__dock-empty">
                Tell the agent what to do. It can resize, trim, add a logo, add date/text, remove simple backgrounds, run preview, render final.
              </div>
            ) : null}
            {messages.map((m) => (
              <div key={m.id} className={`ai-video-studio__msg is-${m.role}`}>
                {m.role === "tool" ? (
                  <span className="ai-video-studio__tool-chip">{m.tool?.name || "tool"} — {m.content}</span>
                ) : (
                  <span>{m.content || (m.role === "assistant" ? "…" : "")}</span>
                )}
              </div>
            ))}
            {thinking && streaming ? (
              <div className="ai-video-studio__msg is-assistant">
                <span className="ai-video-studio__thinking">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {activeTool ? `Running ${activeTool}…` : `Thinking (${thinking.iteration}/${thinking.total})…`}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="ai-video-studio__dock-bar">
          <div className="ai-video-studio__dock-attach">
            <button type="button" onClick={() => setAttachOpen((v) => !v)} aria-label="Attach asset">
              <Plus className="h-4 w-4" />
            </button>
            {attachOpen ? (
              <div className="ai-video-studio__attach-pop">
                {(["source", "logo", "intro", "outro"] as AssetRole[]).map((role) => (
                  <button key={role} type="button" onClick={() => chooseFile(role)}>{role}</button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className="ai-video-studio__dock-pill">
            <Bot className="h-3.5 w-3.5" />
            Agent
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            placeholder={hasSource ? "Tell the editor what to do…" : "Upload a video, then describe the final cut…"}
            rows={1}
            className="ai-video-studio__dock-input"
          />
          <button type="button" className="ai-video-studio__dock-icon" onClick={() => setDrawerOpen(true)} aria-label="Manual controls">
            <Settings2 className="h-4 w-4" />
          </button>
          <button type="button" className="ai-video-studio__dock-icon" onClick={() => setExpanded((v) => !v)} aria-label="Toggle transcript">
            {expanded ? <X className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className="ai-video-studio__dock-send"
            disabled={streaming || !input.trim()}
            onClick={() => void send()}
            aria-label="Send"
          >
            {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {/* Manual override drawer */}
      {drawerOpen && recipe ? (
        <div className="ai-video-studio__drawer" role="dialog" aria-label="Manual controls">
          <div className="ai-video-studio__drawer-header">
            <span>Manual controls</span>
            <button type="button" onClick={() => setDrawerOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button>
          </div>
          <div className="ai-video-studio__drawer-row">
            <label>Aspect ratio</label>
            <select value={recipe.aspectRatio} onChange={(e) => patchRecipe({ aspectRatio: e.target.value as EditRecipe["aspectRatio"] })}>
              <option value="original">Original</option>
              <option value="9:16">9:16</option>
              <option value="16:9">16:9</option>
              <option value="1:1">1:1</option>
            </select>
          </div>
          <div className="ai-video-studio__drawer-row">
            <label>Crop mode</label>
            <select value={recipe.cropMode} onChange={(e) => patchRecipe({ cropMode: e.target.value as EditRecipe["cropMode"] })}>
              <option value="smart">Smart crop</option>
              <option value="fit-blur">Fit with blur</option>
              <option value="contain">Contain (bars)</option>
            </select>
          </div>
          <div className="ai-video-studio__drawer-row">
            <label>Trim start (s){sourceDuration ? ` / ${Math.round(sourceDuration)}` : ""}</label>
            <input
              type="number"
              min={0}
              max={sourceDuration ? Math.round(sourceDuration) : undefined}
              value={recipe.trim.start}
              onChange={(e) => patchRecipe({ trim: { start: Number(e.target.value) || 0, end: recipe.trim.end } })}
            />
          </div>
          <div className="ai-video-studio__drawer-row">
            <label>Trim end (blank = end)</label>
            <input
              type="number"
              min={0}
              max={sourceDuration ? Math.round(sourceDuration) : undefined}
              value={recipe.trim.end ?? ""}
              onChange={(e) => patchRecipe({ trim: { start: recipe.trim.start, end: e.target.value === "" ? null : Number(e.target.value) } })}
            />
          </div>
          <div className="ai-video-studio__drawer-row">
            <label>Intro</label>
            <input
              type="checkbox"
              checked={recipe.intro.enabled}
              disabled={!assets.intro}
              onChange={(e) => patchRecipe({ intro: { enabled: e.target.checked, asset: assets.intro ?? null } })}
            />
          </div>
          <div className="ai-video-studio__drawer-row">
            <label>Outro</label>
            <input
              type="checkbox"
              checked={recipe.outro.enabled}
              disabled={!assets.outro}
              onChange={(e) => patchRecipe({ outro: { enabled: e.target.checked, asset: assets.outro ?? null } })}
            />
          </div>
          <div className="ai-video-studio__drawer-row">
            <label>Fade transitions</label>
            <input
              type="checkbox"
              checked={recipe.transitions?.fade !== false}
              onChange={(e) => patchRecipe({ transitions: { fade: e.target.checked } })}
            />
          </div>

          {(() => {
            const logo = recipe.overlays.find((o) => o.type === "logo");
            if (!logo || logo.type !== "logo") {
              return assets.logo ? (
                <div className="ai-video-studio__drawer-row">
                  <label>Logo</label>
                  <button
                    type="button"
                    className="ai-video-studio__drawer-btn"
                    onClick={() => patchRecipe({ overlays: [...recipe.overlays, { type: "logo", asset: assets.logo!, position: "top-right", widthPercent: 8, key: "none" }] })}
                  >Add logo</button>
                </div>
              ) : (
                <div className="ai-video-studio__drawer-row"><label>Logo</label><span style={{ color: "rgba(255,255,255,0.4)", fontSize: 12 }}>Upload first</span></div>
              );
            }
            const updateLogo = (patch: Partial<typeof logo>) => {
              const overlays = recipe.overlays.map((o) => o.type === "logo" ? { ...o, ...patch } : o);
              patchRecipe({ overlays });
            };
            return (
              <>
                <div className="ai-video-studio__drawer-row">
                  <label>Logo position</label>
                  <select value={logo.position} onChange={(e) => updateLogo({ position: e.target.value as typeof logo.position })}>
                    <option value="top-right">Top right</option>
                    <option value="top-left">Top left</option>
                    <option value="bottom-right">Bottom right</option>
                    <option value="bottom-left">Bottom left</option>
                  </select>
                </div>
                <div className="ai-video-studio__drawer-row">
                  <label>Logo width %</label>
                  <input
                    type="number"
                    min={3} max={25}
                    value={logo.widthPercent}
                    onChange={(e) => updateLogo({ widthPercent: Number(e.target.value) || 8 })}
                  />
                </div>
                <div className="ai-video-studio__drawer-row">
                  <label>Background key</label>
                  <select value={logo.key ?? "none"} onChange={(e) => updateLogo({ key: e.target.value as "none" | "auto-white" | "auto-black" })}>
                    <option value="none">None</option>
                    <option value="auto-white">Remove white</option>
                    <option value="auto-black">Remove black</option>
                  </select>
                </div>
                <div className="ai-video-studio__drawer-row">
                  <label>Remove logo</label>
                  <button
                    type="button"
                    className="ai-video-studio__drawer-btn"
                    onClick={() => patchRecipe({ overlays: recipe.overlays.filter((o) => o.type !== "logo") })}
                  >Remove</button>
                </div>
              </>
            );
          })()}

          <div className="ai-video-studio__drawer-section">Text overlays</div>
          {recipe.overlays.filter((o) => o.type === "text").map((overlay, idx) => {
            const t = overlay as Extract<EditRecipe["overlays"][number], { type: "text" }>;
            return (
              <div key={`text-${idx}`} className="ai-video-studio__drawer-text-row">
                <input
                  value={t.text}
                  onChange={(e) => {
                    let seen = 0;
                    const overlays = recipe.overlays.map((o) => {
                      if (o.type !== "text") return o;
                      if (seen++ !== idx) return o;
                      return { ...o, text: e.target.value };
                    });
                    patchRecipe({ overlays });
                  }}
                />
                <select
                  value={t.position}
                  onChange={(e) => {
                    let seen = 0;
                    const overlays = recipe.overlays.map((o) => {
                      if (o.type !== "text") return o;
                      if (seen++ !== idx) return o;
                      return { ...o, position: e.target.value as typeof t.position };
                    });
                    patchRecipe({ overlays });
                  }}
                >
                  <option value="bottom-center">Bottom center</option>
                  <option value="bottom-right">Bottom right</option>
                  <option value="top-left">Top left</option>
                </select>
                <button
                  type="button"
                  onClick={() => {
                    let seen = 0;
                    const overlays = recipe.overlays.filter((o) => {
                      if (o.type !== "text") return true;
                      return seen++ !== idx;
                    });
                    patchRecipe({ overlays });
                  }}
                  aria-label="Remove text"
                ><X className="h-3 w-3" /></button>
              </div>
            );
          })}
          <div className="ai-video-studio__drawer-text-row">
            <input
              placeholder="Add new text (e.g. 22 FEB, 2026)"
              value={newOverlayText}
              onChange={(e) => setNewOverlayText(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                const text = newOverlayText.trim();
                if (!text) return;
                patchRecipe({ overlays: [...recipe.overlays, { type: "text", text, position: "bottom-center", style: "bold-clean" }] });
                setNewOverlayText("");
              }}
            ><Plus className="h-3 w-3" /></button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
