import { useState } from "react";
import {
  ArrowLeft, Loader2, AlertTriangle, Check, Pause, XCircle, Clock,
  RotateCcw, Trash2, Ban, Film, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  cancelProject,
  deleteProject,
  formatDuration,
  formatRelativeTime,
  formatTimecode,
  isProjectActive,
  retryClip,
  useProject,
  type ClipStatus,
  type ProjectClip,
  type ProjectStatus,
} from "@/lib/newtab-projects-api";

const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; className: string; Icon: typeof Film }> = {
  queued:      { label: "Queued",      className: "text-white/50 bg-white/[0.07]",      Icon: Clock },
  planning:    { label: "Planning",    className: "text-purple-300 bg-purple-500/15",   Icon: Loader2 },
  running:     { label: "Working",     className: "text-purple-300 bg-purple-500/15",   Icon: Loader2 },
  needs_input: { label: "Needs input", className: "text-amber-300 bg-amber-500/15",     Icon: Pause },
  ready:       { label: "Ready",       className: "text-emerald-300 bg-emerald-500/15", Icon: Check },
  failed:      { label: "Failed",      className: "text-rose-300 bg-rose-500/15",       Icon: AlertTriangle },
  cancelled:   { label: "Cancelled",   className: "text-white/40 bg-white/[0.06]",      Icon: XCircle },
};

const CLIP_STATUS_META: Record<ClipStatus, { label: string; dot: string; text: string }> = {
  queued:      { label: "Queued",      dot: "bg-white/25",       text: "text-white/45" },
  cutting:     { label: "Cutting",     dot: "bg-purple-400",     text: "text-purple-200/80" },
  captioning:  { label: "Captioning",  dot: "bg-purple-400",     text: "text-purple-200/80" },
  editing:     { label: "Editing",     dot: "bg-purple-400",     text: "text-purple-200/80" },
  packaging:   { label: "Packaging",   dot: "bg-purple-400",     text: "text-purple-200/80" },
  ready:       { label: "Ready",       dot: "bg-emerald-400",    text: "text-emerald-200/80" },
  failed:      { label: "Failed",      dot: "bg-rose-400",       text: "text-rose-200/80" },
  needs_input: { label: "Needs input", dot: "bg-amber-400",      text: "text-amber-200/80" },
  cancelled:   { label: "Cancelled",   dot: "bg-white/20",       text: "text-white/35" },
};

const ACTIVE_CLIP: ReadonlySet<ClipStatus> = new Set(["cutting", "captioning", "editing", "packaging"]);

function ClipRow({ clip, index, onRetry, busy }: {
  clip: ProjectClip;
  index: number;
  onRetry: (clipId: string) => void;
  busy: boolean;
}) {
  const meta = CLIP_STATUS_META[clip.status] ?? CLIP_STATUS_META.queued;
  const active = ACTIVE_CLIP.has(clip.status);
  const canRetry = clip.status === "failed" || clip.status === "cancelled";

  return (
    <div className="rounded-xl border border-white/10 bg-[#161619] p-3">
      <div className="flex items-start gap-3">
        <span className="shrink-0 w-6 h-6 rounded-lg bg-white/[0.05] border border-white/8 flex items-center justify-center text-[10px] font-semibold text-white/40 tabular-nums">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <h4 className="flex-1 min-w-0 text-[13px] font-medium text-white/85 leading-snug" dir="auto">
              {clip.label}
            </h4>
            <span className={cn("shrink-0 inline-flex items-center gap-1.5 text-[10px] font-medium", meta.text)}>
              <span className={cn("w-1.5 h-1.5 rounded-full", meta.dot, active && "animate-pulse")} />
              {meta.label}
            </span>
          </div>

          <div className="mt-1 flex items-center gap-2 text-[10.5px] text-white/35 tabular-nums">
            <span>{formatTimecode(clip.startSec)} – {formatTimecode(clip.endSec)}</span>
            <span className="text-white/15">·</span>
            <span>{formatDuration(clip.endSec - clip.startSec)}</span>
          </div>

          {clip.details.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {clip.details.slice(0, 4).map((detail, i) => (
                <li key={i} className="text-[11.5px] text-white/45 leading-relaxed pl-3 relative" dir="auto">
                  <span className="absolute left-0 top-[0.55em] w-1 h-1 rounded-full bg-white/20" />
                  {detail}
                </li>
              ))}
            </ul>
          )}

          {active && (
            <div className="mt-2.5 h-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full bg-purple-400/80 transition-[width] duration-500" style={{ width: `${Math.max(2, clip.progress)}%` }} />
            </div>
          )}
          {clip.message && !clip.error && (
            <p className="mt-1.5 text-[11px] text-white/35">{clip.message}</p>
          )}
          {clip.error && (
            <p className="mt-1.5 text-[11px] text-rose-200/70 break-words">{clip.error}</p>
          )}

          {(canRetry || clip.outputs?.videoKey) && (
            <div className="mt-2.5 flex items-center gap-2">
              {canRetry && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRetry(clip.clipId)}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 text-[11px] font-medium text-white/70 transition-colors"
                >
                  <RotateCcw className="w-3 h-3" /> Retry
                </button>
              )}
              {clip.outputs?.videoKey && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-white/40">
                  <Film className="w-3 h-3" /> Rendered
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProjectDetail({ projectId, onBack, onDeleted }: {
  projectId: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const { project, loading, error, refresh, setProject } = useProject(projectId);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const handleCancel = async () => {
    setBusy(true);
    try {
      const data = await cancelProject(projectId);
      setProject(data.project);
    } catch (err) {
      toast({ title: "Could not cancel", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleRetry = async (clipId: string) => {
    setBusy(true);
    try {
      const data = await retryClip(projectId, clipId);
      setProject(data.project);
    } catch (err) {
      toast({ title: "Could not retry", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await deleteProject(projectId);
      onDeleted();
    } catch (err) {
      toast({ title: "Could not delete", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      setBusy(false);
    }
  };

  if (loading && !project) {
    return (
      <div className="w-full h-full flex items-center justify-center gap-2 text-white/40 text-xs">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading project
      </div>
    );
  }

  if (!project) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-center px-6">
        <AlertTriangle className="w-6 h-6 text-rose-300/70" />
        <p className="text-[13px] text-white/60">{error ?? "Project not found."}</p>
        <button type="button" onClick={onBack} className="px-3 py-1.5 rounded-lg bg-white/8 hover:bg-white/15 text-[12px] text-white/80 transition-colors">
          Back
        </button>
      </div>
    );
  }

  const meta = PROJECT_STATUS_META[project.status] ?? PROJECT_STATUS_META.queued;
  const StatusIcon = meta.Icon;
  const active = isProjectActive(project.status);
  const source = project.sourceVideos[0] ?? null;

  return (
    <div className="w-full h-full flex-1 flex flex-col bg-transparent text-white overflow-y-auto">
      {/* Header */}
      <div className="shrink-0 border-b border-white/[0.06] px-4 sm:px-6 py-3">
        <div className="max-w-[1100px] mx-auto flex items-center gap-3">
          <button type="button" onClick={onBack} className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 border border-white/8 flex items-center justify-center text-white/60 hover:text-white transition-colors" title="Back">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-[15px] font-semibold text-white/90 truncate" dir="auto">{project.title}</h1>
              <span className={cn("shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-semibold uppercase tracking-wider", meta.className)}>
                <StatusIcon className={cn("w-2.5 h-2.5", active && "animate-spin")} />
                {meta.label}
              </span>
            </div>
            <p className="text-[11px] text-white/40 mt-0.5">
              {project.message}
              <span className="text-white/20 mx-1.5">·</span>
              updated {formatRelativeTime(project.updatedAt)}
            </p>
          </div>
          {active && (
            <button type="button" onClick={handleCancel} disabled={busy} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] disabled:opacity-40 text-[11px] font-medium text-white/70 transition-colors">
              <Ban className="w-3 h-3" /> Cancel
            </button>
          )}
          <button type="button" onClick={handleDelete} disabled={busy} className="w-8 h-8 rounded-lg border border-white/10 bg-white/[0.03] hover:bg-rose-500/15 hover:border-rose-400/25 disabled:opacity-40 flex items-center justify-center text-white/45 hover:text-rose-200 transition-colors" title="Delete project">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {active && (
          <div className="max-w-[1100px] mx-auto mt-2.5 h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <div className="h-full bg-purple-400/80 transition-[width] duration-500" style={{ width: `${Math.max(2, project.progress)}%` }} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 px-4 sm:px-6 py-5">
        <div className="max-w-[1100px] mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5">
          {/* Clips */}
          <section>
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/45">Clips</h2>
              <span className="text-[10px] text-white/25 tabular-nums">
                {project.clips.length > 0
                  ? `${project.clips.filter(c => c.status === "ready").length}/${project.clips.length}`
                  : "0"}
              </span>
            </div>
            {project.clips.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-center">
                <p className="text-[12.5px] text-white/45">
                  {project.status === "planning" ? "Working out the clip list…" : "No clips yet."}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {project.clips.map((clip, index) => (
                  <ClipRow key={clip.clipId} clip={clip} index={index} onRetry={handleRetry} busy={busy} />
                ))}
              </div>
            )}
          </section>

          {/* Rail */}
          <aside className="flex flex-col gap-5">
            {source && (
              <section>
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/45 mb-2.5">Source</h2>
                <div className="rounded-xl border border-white/10 bg-[#161619] p-3">
                  {source.thumbnailUrl && (
                    <img src={source.thumbnailUrl} alt="" className="w-full aspect-video object-cover rounded-lg mb-2 border border-white/8" loading="lazy" />
                  )}
                  <p className="text-[12px] text-white/80 leading-snug line-clamp-2" dir="auto">{source.title}</p>
                  <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-white/35 tabular-nums">
                    {source.durationSec > 0 && <span>{formatDuration(source.durationSec)}</span>}
                    {project.sourceVideos.length > 1 && (
                      <>
                        <span className="text-white/15">·</span>
                        <span>+{project.sourceVideos.length - 1} more</span>
                      </>
                    )}
                  </div>
                  {source.url && (
                    <a href={source.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-[11px] text-sky-400/80 hover:text-sky-300 transition-colors">
                      Open source <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </div>
              </section>
            )}

            <section>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/45 mb-2.5">Brief</h2>
              <div className="rounded-xl border border-white/10 bg-[#161619] p-3 space-y-2.5">
                {project.brief.goal && (
                  <p className="text-[12px] text-white/75 leading-relaxed" dir="auto">{project.brief.goal}</p>
                )}
                <dl className="space-y-1.5 text-[11px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/35">Strategy</dt>
                    <dd className="text-white/65">{project.brief.clipStrategy === "exhaustive" ? "All topics" : "Given ranges"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/35">Aspect</dt>
                    <dd className="text-white/65">{project.brief.outputSpec.aspectRatio}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-white/35">Captions</dt>
                    <dd className="text-white/65">{project.brief.outputSpec.burnCaptions ? "Burned in" : "Off"}</dd>
                  </div>
                  {project.brief.channelName && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-white/35">Channel</dt>
                      <dd className="text-white/65 truncate max-w-[150px]">{project.brief.channelName}</dd>
                    </div>
                  )}
                </dl>
                {project.brief.editStyle && (
                  <p className="text-[11px] text-white/45 leading-relaxed pt-1 border-t border-white/[0.06]" dir="auto">
                    {project.brief.editStyle}
                  </p>
                )}
                {project.brief.context && (
                  <details className="pt-1 border-t border-white/[0.06]">
                    <summary className="text-[11px] text-white/40 hover:text-white/70 cursor-pointer">Full context</summary>
                    <p className="mt-1.5 text-[11px] text-white/45 leading-relaxed whitespace-pre-wrap" dir="auto">
                      {project.brief.context}
                    </p>
                  </details>
                )}
              </div>
            </section>

            <section>
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/45">Activity</h2>
                <button type="button" onClick={() => void refresh()} className="text-[10px] text-white/30 hover:text-white/70 transition-colors">
                  Refresh
                </button>
              </div>
              <div className="rounded-xl border border-white/10 bg-[#161619] p-3 max-h-[320px] overflow-y-auto">
                {project.activity.length === 0 ? (
                  <p className="text-[11px] text-white/30">Nothing logged yet.</p>
                ) : (
                  <ol className="space-y-2">
                    {[...project.activity].reverse().map((entry, i) => (
                      <li key={i} className="flex gap-2 text-[11px] leading-relaxed">
                        <span className={cn(
                          "shrink-0 mt-[0.45em] w-1 h-1 rounded-full",
                          entry.level === "error" ? "bg-rose-400" : entry.level === "warn" ? "bg-amber-400" : "bg-white/25",
                        )} />
                        <span className="flex-1 min-w-0">
                          <span className={cn(entry.level === "error" ? "text-rose-200/75" : "text-white/55")}>{entry.message}</span>
                          <span className="block text-[10px] text-white/20 tabular-nums">{formatRelativeTime(entry.at)}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
