import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join, extname } from "path";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { statSync } from "fs";
import ffmpegStatic from "ffmpeg-static";
import { getWorkspace } from "../lib/workspace";
import { logger } from "../lib/logger";

type AspectRatio = "original" | "9:16" | "16:9" | "1:1";
type CropMode = "smart" | "fit-blur" | "contain";
type LogoPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";
type TextPosition = "bottom-center" | "bottom-right" | "top-left";
type RenderStatus = "pending" | "running" | "done" | "error" | "cancelled";

type EditorAssets = {
  logo?: string | null;
  intro?: string | null;
  outro?: string | null;
};

type EditRecipe = {
  aspectRatio: AspectRatio;
  cropMode: CropMode;
  trim: { start: number; end: number | null };
  overlays: Array<
    | { type: "logo"; asset: string; position: LogoPosition; widthPercent: number }
    | { type: "text"; text: string; position: TextPosition; style: "bold-clean" | "headline" }
  >;
  intro: { enabled: boolean; asset: string | null };
  outro: { enabled: boolean; asset: string | null };
  export: {
    format: "mp4";
    resolution: "1080p";
    videoCodec: "h264";
    audioCodec: "aac";
  };
};

type EditorProject = {
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sourceVideo: string | null;
  assets: EditorAssets;
  prompt: string;
  recipe: EditRecipe;
  renders: Array<{
    jobId: string;
    kind: "preview" | "final";
    status: RenderStatus;
    progress: number;
    message: string;
    outputPath: string | null;
    createdAt: number;
    completedAt: number | null;
  }>;
};

type EditorJob = {
  jobId: string;
  projectId: string;
  kind: "preview" | "final";
  status: RenderStatus;
  progress: number;
  message: string;
  outputPath: string | null;
  error?: string | null;
  createdAt: number;
  completedAt: number | null;
};

const router = Router();
const jobs = new Map<string, EditorJob>();
const FFMPEG_BIN = process.env.FFMPEG_BIN || ffmpegStatic || "ffmpeg";

function projectPath(projectId: string): string {
  if (!/^[a-f0-9-]{20,80}$/i.test(projectId)) throw new Error("invalid project id");
  return `editor/projects/${projectId}.json`;
}

function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} required`);
  return value;
}

function bad(res: Response, status: number, error: string) {
  return res.status(status).json({ error });
}

function fail(res: Response, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid|required|not found|missing/i.test(msg)) return res.status(400).json({ error: msg });
  logger.error({ err }, "[video-editor] unexpected failure");
  return res.status(500).json({ error: "video editor operation failed" });
}

function cleanWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\/+/, "");
  return trimmed ? trimmed : null;
}

function extractDateText(prompt: string): string | null {
  const quoted = prompt.match(/["'“”]([^"'“”]{3,80})["'“”]/);
  if (quoted?.[1]) return quoted[1].trim();
  const date = prompt.match(/\b\d{1,2}\s+[A-Z]{3,9},?\s+\d{4}\b/i);
  return date ? date[0].replace(",", "").toUpperCase() : null;
}

function generateRecipe(prompt: string, sourceVideo: string | null, assets: EditorAssets): EditRecipe {
  const p = prompt.toLowerCase();
  const aspectRatio: AspectRatio =
    /\b(shorts?|reels?|tiktok|vertical|9[:x]16|portrait)\b/.test(p)
      ? "9:16"
      : /\b(square|1[:x]1)\b/.test(p)
        ? "1:1"
        : /\b(landscape|youtube|16[:x]9)\b/.test(p)
          ? "16:9"
          : "original";
  const cropMode: CropMode =
    /\bblur|background blur|fit\b/.test(p)
      ? "fit-blur"
      : /\bcontain|bars|no crop\b/.test(p)
        ? "contain"
        : "smart";

  const overlays: EditRecipe["overlays"] = [];
  if (assets.logo) {
    const position: LogoPosition =
      /\btop left|upper left\b/.test(p)
        ? "top-left"
        : /\bbottom right|lower right\b/.test(p)
          ? "bottom-right"
          : /\bbottom left|lower left\b/.test(p)
            ? "bottom-left"
            : "top-right";
    overlays.push({ type: "logo", asset: assets.logo, position, widthPercent: 8 });
  }

  const text = extractDateText(prompt);
  if (text) overlays.push({ type: "text", text, position: "bottom-center", style: "bold-clean" });

  const wantsIntro = Boolean(assets.intro) && /\bintro|opening|start\b/.test(p);
  const wantsOutro = Boolean(assets.outro) && /\boutro|ending|end card|end\b/.test(p);

  return {
    aspectRatio,
    cropMode,
    trim: { start: 0, end: null },
    overlays,
    intro: { enabled: wantsIntro, asset: wantsIntro ? assets.intro ?? null : null },
    outro: { enabled: wantsOutro, asset: wantsOutro ? assets.outro ?? null : null },
    export: { format: "mp4", resolution: "1080p", videoCodec: "h264", audioCodec: "aac" },
  };
}

async function readProject(req: Request, projectId: string): Promise<EditorProject> {
  const ws = getWorkspace(req);
  const data = await ws.s3.readText(projectPath(projectId));
  return JSON.parse(data.content) as EditorProject;
}

async function writeProject(req: Request, project: EditorProject): Promise<EditorProject> {
  const ws = getWorkspace(req);
  return writeProjectToWorkspace(ws, project);
}

async function writeProjectToWorkspace(ws: ReturnType<typeof getWorkspace>, project: EditorProject): Promise<EditorProject> {
  const next = { ...project, updatedAt: Date.now() };
  await ws.s3.writeText(projectPath(project.projectId), JSON.stringify(next, null, 2), {
    contentType: "application/json",
  });
  return next;
}

async function readProjectFromWorkspace(ws: ReturnType<typeof getWorkspace>, projectId: string): Promise<EditorProject> {
  const data = await ws.s3.readText(projectPath(projectId));
  return JSON.parse(data.content) as EditorProject;
}

function targetSize(aspectRatio: AspectRatio): { width: number; height: number } {
  switch (aspectRatio) {
    case "9:16": return { width: 1080, height: 1920 };
    case "1:1": return { width: 1080, height: 1080 };
    case "16:9": return { width: 1920, height: 1080 };
    case "original": return { width: 1920, height: 1080 };
  }
}

function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function baseVideoFilter(recipe: EditRecipe, width: number, height: number): string {
  if (recipe.cropMode === "contain") {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
  }
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
}

function overlayPosition(position: LogoPosition, margin: number): string {
  switch (position) {
    case "top-left": return `${margin}:${margin}`;
    case "bottom-right": return `W-w-${margin}:H-h-${margin}`;
    case "bottom-left": return `${margin}:H-h-${margin}`;
    case "top-right": return `W-w-${margin}:${margin}`;
  }
}

function buildFfmpegArgs(params: {
  sourcePath: string;
  logoPath?: string | null;
  outputPath: string;
  recipe: EditRecipe;
  preview: boolean;
}): string[] {
  const { width, height } = targetSize(params.recipe.aspectRatio);
  const args = ["-y"];
  const duration = params.preview ? 8 : null;
  if (params.recipe.trim.start > 0) args.push("-ss", String(params.recipe.trim.start));
  if (duration) args.push("-t", String(duration));
  else if (params.recipe.trim.end != null && params.recipe.trim.end > params.recipe.trim.start) {
    args.push("-t", String(params.recipe.trim.end - params.recipe.trim.start));
  }
  args.push("-i", params.sourcePath);

  const logoOverlay = params.recipe.overlays.find((item) => item.type === "logo" && params.logoPath) as
    | Extract<EditRecipe["overlays"][number], { type: "logo" }>
    | undefined;
  if (logoOverlay && params.logoPath) args.push("-i", params.logoPath);

  const filters: string[] = [];
  if (params.recipe.cropMode === "fit-blur") {
    filters.push(`[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2[bg]`);
    filters.push(`[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`);
    filters.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v0]`);
  } else {
    filters.push(`[0:v]${baseVideoFilter(params.recipe, width, height)}[v0]`);
  }
  let current = "v0";
  let step = 1;

  if (logoOverlay) {
    const logoWidth = Math.max(48, Math.round(width * (logoOverlay.widthPercent / 100)));
    const margin = Math.round(width * 0.045);
    filters.push(`[1:v]scale=${logoWidth}:-1[logo]`);
    filters.push(`[${current}][logo]overlay=${overlayPosition(logoOverlay.position, margin)}[v${step}]`);
    current = `v${step}`;
    step += 1;
  }

  for (const overlay of params.recipe.overlays) {
    if (overlay.type !== "text") continue;
    const fontSize = Math.max(34, Math.round(width * 0.055));
    const y = overlay.position === "top-left" ? Math.round(height * 0.08) : Math.round(height * 0.88);
    const x = overlay.position === "bottom-right" ? `w-text_w-${Math.round(width * 0.06)}` : "(w-text_w)/2";
    filters.push(
      `[${current}]drawtext=text='${escapeDrawText(overlay.text)}':fontcolor=white:fontsize=${fontSize}:borderw=3:bordercolor=black@0.65:x=${x}:y=${y}[v${step}]`,
    );
    current = `v${step}`;
    step += 1;
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${current}]`,
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", params.preview ? "28" : "22",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    "-shortest",
    params.outputPath,
  );
  return args;
}

async function downloadWorkspaceFile(ws: ReturnType<typeof getWorkspace>, path: string, dest: string): Promise<void> {
  const { url } = await ws.s3.presignGet(path, { disposition: "inline" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read ${path}: ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function uploadWorkspaceFile(ws: ReturnType<typeof getWorkspace>, source: string, destPath: string): Promise<void> {
  const bytes = await readFile(source);
  const presign = await ws.s3.presignPut(destPath, { size: bytes.length, contentType: "video/mp4" });
  const res = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Could not upload render: ${res.status}`);
}

function runFfmpeg(args: string[], job: EditorJob): Promise<void> {
  return new Promise((resolve, reject) => {
    job.status = "running";
    job.progress = Math.max(job.progress, 25);
    job.message = "Rendering video...";
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
      if (job.status === "running") job.progress = Math.min(88, job.progress + 2);
    });
    proc.on("error", (err) => reject(new Error(`Failed to start FFmpeg: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-1200) || `FFmpeg exited with code ${code}`));
    });
  });
}

async function persistJobToProject(ws: ReturnType<typeof getWorkspace>, projectId: string, job: EditorJob): Promise<void> {
  const latest = await readProjectFromWorkspace(ws, projectId);
  await writeProjectToWorkspace(ws, {
    ...latest,
    renders: latest.renders.map((entry) => entry.jobId === job.jobId ? {
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      message: job.message,
      outputPath: job.outputPath,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    } : entry),
  });
}

async function processRenderJob(ws: ReturnType<typeof getWorkspace>, projectId: string, job: EditorJob): Promise<void> {
  const dir = join(tmpdir(), `video-editor-${job.jobId}`);
  await mkdir(dir, { recursive: true });
  try {
    const project = await readProjectFromWorkspace(ws, projectId);
    if (!project.sourceVideo) throw new Error("source video required");
    const sourcePath = join(dir, `source${extname(project.sourceVideo) || ".mp4"}`);
    const logoOverlay = project.recipe.overlays.find((item) => item.type === "logo") as
      | Extract<EditRecipe["overlays"][number], { type: "logo" }>
      | undefined;
    const logoPath = logoOverlay?.asset ? join(dir, `logo${extname(logoOverlay.asset) || ".png"}`) : null;
    const outputPath = join(dir, `${job.kind}.mp4`);
    const workspaceOutput = `editor/renders/${projectId}/${job.kind}-${job.jobId}.mp4`;

    job.message = "Downloading source assets...";
    job.progress = 10;
    await downloadWorkspaceFile(ws, project.sourceVideo, sourcePath);
    if (logoOverlay?.asset && logoPath) await downloadWorkspaceFile(ws, logoOverlay.asset, logoPath);

    await runFfmpeg(buildFfmpegArgs({
      sourcePath,
      logoPath,
      outputPath,
      recipe: project.recipe,
      preview: job.kind === "preview",
    }), job);

    if (!statSync(outputPath).size) throw new Error("Render produced an empty file");
    job.message = "Saving render to workspace...";
    job.progress = 92;
    await uploadWorkspaceFile(ws, outputPath, workspaceOutput);
    job.status = "done";
    job.progress = 100;
    job.message = "Render saved to workspace.";
    job.outputPath = workspaceOutput;
    job.completedAt = Date.now();
    await persistJobToProject(ws, projectId, job);
  } catch (err) {
    job.status = "error";
    job.progress = 0;
    job.message = err instanceof Error ? err.message : "Render failed";
    job.error = job.message;
    job.completedAt = Date.now();
    await persistJobToProject(ws, projectId, job).catch((writeErr) => {
      logger.warn({ err: writeErr, jobId: job.jobId }, "[video-editor] failed to persist render error");
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

router.post("/projects", async (req: Request, res: Response) => {
  try {
    const sourceVideo = cleanWorkspacePath(req.body?.sourceVideo);
    const assets: EditorAssets = {
      logo: cleanWorkspacePath(req.body?.assets?.logo),
      intro: cleanWorkspacePath(req.body?.assets?.intro),
      outro: cleanWorkspacePath(req.body?.assets?.outro),
    };
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const title = typeof req.body?.title === "string" && req.body.title.trim()
      ? req.body.title.trim().slice(0, 80)
      : "AI Video Studio Project";
    const now = Date.now();
    const project: EditorProject = {
      projectId: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      sourceVideo,
      assets,
      prompt,
      recipe: generateRecipe(prompt, sourceVideo, assets),
      renders: [],
    };
    await writeProject(req, project);
    return res.json({ project });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/projects/:projectId", async (req: Request, res: Response) => {
  try {
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    return res.json({ project });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/notfound|not found|nosuchkey/i.test(msg)) return bad(res, 404, "project not found");
    return fail(res, err);
  }
});

router.post("/projects/:projectId/agent", async (req: Request, res: Response) => {
  try {
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : project.prompt;
    const sourceVideo = cleanWorkspacePath(req.body?.sourceVideo) ?? project.sourceVideo;
    const assets: EditorAssets = {
      logo: cleanWorkspacePath(req.body?.assets?.logo) ?? project.assets.logo ?? null,
      intro: cleanWorkspacePath(req.body?.assets?.intro) ?? project.assets.intro ?? null,
      outro: cleanWorkspacePath(req.body?.assets?.outro) ?? project.assets.outro ?? null,
    };
    const next = await writeProject(req, {
      ...project,
      prompt,
      sourceVideo,
      assets,
      recipe: generateRecipe(prompt, sourceVideo, assets),
    });
    return res.json({
      project: next,
      message: "Created a renderable edit recipe for the current v1 finishing tools.",
    });
  } catch (err) {
    return fail(res, err);
  }
});

router.post("/projects/:projectId/preview", async (req: Request, res: Response) => {
  return startRender(req, res, "preview");
});

router.post("/projects/:projectId/render", async (req: Request, res: Response) => {
  return startRender(req, res, "final");
});

async function startRender(req: Request, res: Response, kind: "preview" | "final") {
  try {
    const ws = getWorkspace(req);
    const project = await readProject(req, routeParam(req.params.projectId, "projectId"));
    if (!project.sourceVideo) return bad(res, 400, "source video required");
    const job: EditorJob = {
      jobId: randomUUID(),
      projectId: project.projectId,
      kind,
      status: "pending",
      progress: 1,
      message: "Queued render...",
      outputPath: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    };
    jobs.set(job.jobId, job);
    const next = await writeProject(req, {
      ...project,
      renders: [
        {
          jobId: job.jobId,
          kind,
          status: job.status,
          progress: job.progress,
          message: job.message,
          outputPath: job.outputPath,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        },
        ...project.renders,
      ].slice(0, 20),
    });
    void processRenderJob(ws, project.projectId, job);
    return res.json({ job, project: next });
  } catch (err) {
    return fail(res, err);
  }
}

router.get("/jobs/:jobId", (req: Request, res: Response) => {
  const job = jobs.get(routeParam(req.params.jobId, "jobId"));
  if (!job) return bad(res, 404, "job not found");
  return res.json({ job });
});

router.post("/jobs/:jobId/cancel", (req: Request, res: Response) => {
  const job = jobs.get(routeParam(req.params.jobId, "jobId"));
  if (!job) return bad(res, 404, "job not found");
  if (job.status === "pending" || job.status === "running") {
    job.status = "cancelled";
    job.message = "Cancelled";
    job.completedAt = Date.now();
  }
  return res.json({ job });
});

export default router;
