import { useMemo, useState } from "react";
import { Loader2, FolderOpen, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProjectCard } from "./ProjectCard";
import { isProjectActive, useProjects, type NewTabProjectSummary } from "@/lib/newtab-projects-api";

const COLLAPSED_RECENT_COUNT = 4;

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/45">{label}</h2>
      <span className="text-[10px] text-white/25 tabular-nums">{count}</span>
    </div>
  );
}

/**
 * Projects on the launchpad: what's running now, and what's been made.
 * Empty state gives working example prompts instead of a shrug.
 */
export function ProjectsSection({ onOpenProject, onUseExample }: {
  onOpenProject: (projectId: string) => void;
  onUseExample?: (prompt: string) => void;
}) {
  const { projects, loading, error } = useProjects();
  const [expanded, setExpanded] = useState(false);

  const { active, recent } = useMemo(() => {
    const activeList: NewTabProjectSummary[] = [];
    const recentList: NewTabProjectSummary[] = [];
    for (const project of projects) {
      (isProjectActive(project.status) ? activeList : recentList).push(project);
    }
    return { active: activeList, recent: recentList };
  }, [projects]);

  if (loading && projects.length === 0) {
    return (
      <div className="w-full max-w-[760px] flex items-center justify-center gap-2 py-8 text-white/35 text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading projects
      </div>
    );
  }

  if (!loading && projects.length === 0) {
    const examples = [
      "Give me all clips from https://youtu.be/… and cut each topic",
      "Cut 12:30 to 18:45 from this video for the shorts channel",
      "Take the last katha and make vertical clips with Hindi captions",
    ];
    return (
      <div className="w-full max-w-[760px]">
        <SectionHeading label="Projects" count={0} />
        <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5">
          <p className="text-[12.5px] text-white/50 mb-3">
            No projects yet. Ask for clips in the box above and one gets created for you.
          </p>
          <div className="flex flex-col gap-1.5">
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => onUseExample?.(example)}
                className="text-left text-[11.5px] text-white/40 hover:text-white/80 transition-colors truncate"
              >
                <span className="text-white/25 mr-1.5">›</span>{example}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const allRecent = [...active, ...recent];
  const visibleRecent = expanded ? allRecent : allRecent.slice(0, COLLAPSED_RECENT_COUNT);

  return (
    <div className="w-full max-w-[760px] flex flex-col gap-6">
      {error && (
        <p className="text-[11px] text-rose-300/70">Could not refresh projects: {error}</p>
      )}

      {allRecent.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-3.5 h-3.5 text-white/35" />
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-white/45">Recent projects</h2>
              <span className="text-[10px] text-white/25 tabular-nums">{allRecent.length}</span>
            </div>
            {allRecent.length > COLLAPSED_RECENT_COUNT && (
              <button
                type="button"
                onClick={() => setExpanded(v => !v)}
                className="flex items-center gap-1 text-[11px] text-white/40 hover:text-white/80 transition-colors"
              >
                {expanded ? "Show less" : `Show all ${allRecent.length}`}
                <ChevronDown className={cn("w-3 h-3 transition-transform", expanded && "rotate-180")} />
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {visibleRecent.map((project) => (
              <ProjectCard key={project.projectId} project={project} onOpen={onOpenProject} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
