import { useMemo, useRef, useState } from "react";
import {
  Bot, Download, FileVideo, ImagePlus, Loader2, PanelRight, Play, RefreshCw,
  Sparkles, UploadCloud, Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatBytes } from "@/lib/workspace-api";
import {
  videoEditorApi,
  type EditRecipe,
  type EditorAssets,
  type EditorProject,
} from "@/lib/video-editor-api";
import { cn } from "@/lib/utils";

const STARTER_PROMPT =
  'Make this a polished vertical short. Cut it down the best way, add the logo top right, remove simple logo background if needed, add "22 FEB, 2026" at the bottom in a clean bold style, and use intro/outro if provided.';

type AssetRole = "source" | "logo" | "intro" | "outro";

function overlayLabel(recipe: EditRecipe): string {
  if (!recipe.overlays.length) return "No overlays yet";
  return recipe.overlays
    .map((item) => item.type === "logo" ? `Logo ${item.position}` : `Text "${item.text}"`)
    .join(" + ");
}

export function AiVideoStudio() {
  const { toast } = useToast();
  const [project, setProject] = useState<EditorProject | null>(null);
  const [prompt, setPrompt] = useState(STARTER_PROMPT);
  const [busy, setBusy] = useState<string | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingRoleRef = useRef<AssetRole>("source");

  const recipe = project?.recipe;
  const assets = project?.assets ?? {};
  const hasSource = Boolean(project?.sourceVideo);
  const assetRows = useMemo(() => ([
    { role: "source" as const, label: "Source video", value: project?.sourceVideo, icon: FileVideo },
    { role: "logo" as const, label: "Logo", value: assets.logo, icon: ImagePlus },
    { role: "intro" as const, label: "Intro", value: assets.intro, icon: Play },
    { role: "outro" as const, label: "Outro", value: assets.outro, icon: Download },
  ]), [assets.intro, assets.logo, assets.outro, project?.sourceVideo]);

  const ensureProject = async (): Promise<EditorProject> => {
    if (project) return project;
    const res = await videoEditorApi.createProject({ prompt });
    setProject(res.project);
    return res.project;
  };

  const chooseFile = (role: AssetRole) => {
    pendingRoleRef.current = role;
    fileInputRef.current?.click();
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const role = pendingRoleRef.current;
    try {
      setBusy(`Uploading ${role}...`);
      const current = await ensureProject();
      const uploaded = await videoEditorApi.uploadAsset(current.projectId, role, file);
      const nextAssets: EditorAssets = {
        ...current.assets,
        ...(role === "logo" ? { logo: uploaded.path } : {}),
        ...(role === "intro" ? { intro: uploaded.path } : {}),
        ...(role === "outro" ? { outro: uploaded.path } : {}),
      };
      const nextSource = role === "source" ? uploaded.path : current.sourceVideo;
      const res = await videoEditorApi.generateRecipe(current.projectId, {
        prompt,
        sourceVideo: nextSource,
        assets: nextAssets,
      });
      setProject(res.project);
      if (role === "source") {
        const fileInfo = await import("@/lib/workspace-api").then(({ workspaceApi }) => workspaceApi.getFile(uploaded.path, { inline: true }));
        setSourcePreviewUrl(fileInfo.url);
      }
      toast({ title: "Asset added", description: `${file.name} saved to ${uploaded.path} (${formatBytes(uploaded.size)}).` });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Could not upload asset.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const generateRecipe = async () => {
    try {
      setBusy("Planning edit...");
      const current = await ensureProject();
      const res = await videoEditorApi.generateRecipe(current.projectId, {
        prompt,
        sourceVideo: current.sourceVideo,
        assets: current.assets,
      });
      setProject(res.project);
      toast({ title: "Edit recipe ready", description: res.message });
    } catch (err) {
      toast({
        title: "Planning failed",
        description: err instanceof Error ? err.message : "Could not create edit recipe.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const startRender = async (kind: "preview" | "final") => {
    if (!project) return;
    try {
      setBusy(kind === "preview" ? "Starting preview..." : "Starting render...");
      const res = kind === "preview"
        ? await videoEditorApi.startPreview(project.projectId)
        : await videoEditorApi.startRender(project.projectId);
      setProject(res.project);
      await pollRender(res.job.jobId, res.project.projectId);
    } catch (err) {
      toast({
        title: kind === "preview" ? "Preview not started" : "Render not started",
        description: err instanceof Error ? err.message : "Render is not available yet.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const pollRender = async (jobId: string, projectId: string) => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const { job } = await videoEditorApi.getJob(jobId);
      setProject((prev) => prev ? {
        ...prev,
        renders: prev.renders.map((item) => item.jobId === jobId ? job : item),
      } : prev);
      if (job.status === "done" && job.outputPath) {
        const { workspaceApi } = await import("@/lib/workspace-api");
        const file = await workspaceApi.getFile(job.outputPath, { inline: true });
        setRenderUrl(file.url);
        const latest = await videoEditorApi.getProject(projectId);
        setProject(latest.project);
        toast({ title: "Render ready", description: job.outputPath });
        return;
      }
      if (job.status === "error" || job.status === "cancelled") {
        throw new Error(job.message || "Render failed");
      }
    }
    throw new Error("Render is still running. Check the project again in a moment.");
  };

  return (
    <div className="ai-video-studio">
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
          <h1>Finish videos with an AI render plan</h1>
          <p>Upload the source and brand assets, describe the final video, then review the recipe before rendering.</p>
        </div>
        <Button onClick={generateRecipe} disabled={Boolean(busy)} className="ai-video-studio__primary">
          {busy === "Planning edit..." ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          Plan Edit
        </Button>
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
          <div className={cn("ai-video-studio__screen", recipe?.aspectRatio === "9:16" && "is-vertical", recipe?.aspectRatio === "1:1" && "is-square")}>
            {renderUrl || sourcePreviewUrl ? (
              <video src={renderUrl || sourcePreviewUrl || undefined} controls className="h-full w-full object-contain" />
            ) : (
              <div className="ai-video-studio__empty-preview">
                <FileVideo className="h-10 w-10" />
                <span>{hasSource ? "Source saved. Open preview after refresh is coming next." : "Upload a source video to start."}</span>
              </div>
            )}
            {recipe?.overlays.map((item, index) => item.type === "text" ? (
              <div key={`${item.type}-${index}`} className="ai-video-studio__mock-text">{item.text}</div>
            ) : (
              <div key={`${item.type}-${index}`} className={`ai-video-studio__mock-logo ${item.position}`}>LOGO</div>
            ))}
          </div>
          <div className="ai-video-studio__render-actions">
            {renderUrl ? (
              <a className="ai-video-studio__download" href={renderUrl} target="_blank" rel="noreferrer">
                <Download className="h-4 w-4" />
                Open Output
              </a>
            ) : null}
            <Button variant="glass" disabled={!project || !hasSource || Boolean(busy)} onClick={() => startRender("preview")}>
              <Play className="h-4 w-4" />
              Preview Render
            </Button>
            <Button disabled={!project || !hasSource || Boolean(busy)} onClick={() => startRender("final")}>
              <Sparkles className="h-4 w-4" />
              Final Render
            </Button>
          </div>
        </section>

        <section className="ai-video-studio__panel ai-video-studio__agent">
          <div className="ai-video-studio__panel-title">
            <PanelRight className="h-4 w-4" />
            Instructions
          </div>
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className="ai-video-studio__prompt"
            rows={8}
          />
          <button className="ai-video-studio__secondary-action" type="button" disabled={Boolean(busy)} onClick={generateRecipe}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Update recipe
          </button>

          {recipe ? (
            <div className="ai-video-studio__recipe">
              <div><span>Aspect</span><strong>{recipe.aspectRatio}</strong></div>
              <div><span>Crop</span><strong>{recipe.cropMode}</strong></div>
              <div><span>Overlays</span><strong>{overlayLabel(recipe)}</strong></div>
              <div><span>Intro</span><strong>{recipe.intro.enabled ? "Enabled" : "Off"}</strong></div>
              <div><span>Outro</span><strong>{recipe.outro.enabled ? "Enabled" : "Off"}</strong></div>
            </div>
          ) : (
            <div className="ai-video-studio__empty-recipe">No recipe yet. Upload a video or click Plan Edit.</div>
          )}

          {project?.renders?.[0] ? (
            <div className="ai-video-studio__job">
              <span>{project.renders[0].kind} render</span>
              <strong>{project.renders[0].status} · {project.renders[0].progress}%</strong>
              <p>{project.renders[0].message}</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
