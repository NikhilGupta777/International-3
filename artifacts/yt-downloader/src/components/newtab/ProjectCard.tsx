import { Film, Loader2, AlertTriangle, Check, Pause, XCircle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatRelativeTime,
  isProjectActive,
  type NewTabProjectSummary,
  type ProjectStatus,
} from "@/lib/newtab-projects-api";

/**
 * One accent colour per state, no gradients, and every card carries real numbers
 * (clip counts, elapsed time) rather than decorative chrome.
 */
const STATUS_META: Record<ProjectStatus, { label: string; className: string; Icon: typeof Film }> = {
  queued:      { label: "Queued",      className: "text-white/50 bg-white/[0.07]",            Icon: Clock },
  planning:    { label: "Planning",    className: "text-purple-300 bg-purple-500/15",         Icon: Loader2 },
  running:     { label: "Working",     className: "text-purple-300 bg-purple-500/15",         Icon: Loader2 },
  needs_input: { label: "Needs input", className: "text-amber-300 bg-amber-500/15",           Icon: Pause },
  ready:       { label: "Ready",       className: "text-emerald-300 bg-emerald-500/15",       Icon: Check },
  failed:      { label: "Failed",      className: "text-rose-300 bg-rose-500/15",             Icon: AlertTriangle },
  cancelled:   { label: "Cancelled",   className: "text-white/40 bg-white/[0.06]",            Icon: XCircle },
};

function ClipPips({ total, ready, failed }: { total: number; ready: number; failed: number }) {
  if (total === 0) return null;
  // Above ~24 clips individual pips stop being readable; show a count instead.
  if (total > 24) {
    return (
      <span className="text-[10px] text-white/40 tabular-nums">
        {ready}/{total} done{failed > 0 ? ` · ${failed} failed` : ""}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-[3px]" title={`${ready} of ${total} clips ready`}>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            i < ready ? "bg-emerald-400/80" : i < ready + failed ? "bg-rose-400/70" : "bg-white/15",
          )}
        />
      ))}
    </div>
  );
}

export function ProjectCard({ project, onOpen }: {
  project: NewTabProjectSummary;
  onOpen: (projectId: string) => void;
}) {
  const meta = STATUS_META[project.status] ?? STATUS_META.queued;
  const active = isProjectActive(project.status);
  const StatusIcon = meta.Icon;

  return (
    <button
      type="button"
      onClick={() => onOpen(project.projectId)}
      className="group w-full text-left rounded-xl border border-white/10 bg-[#161619] hover:bg-[#1b1b20] hover:border-white/20 transition-colors p-3 flex gap-3"
    >
      {/* Thumbnail */}
      <div className="relative shrink-0 w-[92px] h-[52px] rounded-lg overflow-hidden bg-white/[0.04] border border-white/8">
        {project.thumbnailUrl ? (
          <img src={project.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Film className="w-4 h-4 text-white/20" />
          </div>
        )}
        {active && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/50">
            <div
              className="h-full bg-purple-400/80 transition-[width] duration-500"
              style={{ width: `${Math.max(2, project.progress)}%` }}
            />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <h3 className="flex-1 min-w-0 text-[13.5px] font-medium text-white/90 truncate leading-snug" dir="auto">
            {project.title}
          </h3>
          <span className={cn(
            "shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-semibold uppercase tracking-wider",
            meta.className,
          )}>
            <StatusIcon className={cn("w-2.5 h-2.5", active && "animate-spin")} />
            {meta.label}
          </span>
        </div>

        <p className={cn(
          "mt-1 text-[11.5px] truncate",
          project.status === "failed" ? "text-rose-200/70" : "text-white/45",
        )}>
          {project.message}
        </p>

        <div className="mt-2 flex items-center gap-3 flex-wrap">
          <ClipPips total={project.clipCount} ready={project.readyClipCount} failed={project.failedClipCount} />
          {project.clipCount > 0 && (
            <span className="text-[10px] text-white/35 tabular-nums">{project.clipCount} clips</span>
          )}
          {project.channelName && (
            <span className="text-[10px] text-white/35 truncate max-w-[140px]">{project.channelName}</span>
          )}
          <span className="text-[10px] text-white/25 ml-auto tabular-nums">{formatRelativeTime(project.updatedAt)}</span>
        </div>
      </div>
    </button>
  );
}
