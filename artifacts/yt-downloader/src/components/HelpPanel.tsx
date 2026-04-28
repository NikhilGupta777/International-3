import { useState } from "react";
import { CircleHelp, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { GUIDE_TABS, type GuideMode } from "@/lib/guide-tabs";

type AnyMode = GuideMode | "home" | "copilot" | "translator" | "help" | "activity";

export function HelpPanel({
  initialMode,
  onSwitchTab,
}: {
  initialMode?: AnyMode;
  onSwitchTab: (m: AnyMode) => void;
}) {
  const startIndex = Math.max(
    0,
    GUIDE_TABS.findIndex((x) => x.mode === initialMode),
  );
  const [activeIndex, setActiveIndex] = useState<number>(startIndex);
  const active = GUIDE_TABS[activeIndex];
  const isLast = activeIndex === GUIDE_TABS.length - 1;

  const handleNext = () => {
    if (isLast) {
      onSwitchTab("clips");
      return;
    }
    setActiveIndex(activeIndex + 1);
  };

  return (
    <div className="help-page">
      <div className="help-page-inner">
        <header className="help-page-header">
          <div className="help-page-icon">
            <CircleHelp className="w-5 h-5 text-teal-300" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-teal-300/80 font-semibold">
              Welcome Guide
            </p>
            <h2 className="text-xl sm:text-2xl font-display font-bold text-white mt-1">
              How VideoMaking Studio Works
            </h2>
            <p className="text-sm text-white/55 mt-1">
              Quick walkthrough of each tab so new users can start confidently.
            </p>
          </div>
        </header>

        <div className="help-page-grid">
          <aside className="help-page-list hidden md:flex">
            {GUIDE_TABS.map((tab, i) => (
              <button
                key={tab.mode}
                type="button"
                onClick={() => setActiveIndex(i)}
                className={cn(
                  "help-page-list-btn",
                  activeIndex === i && "help-page-list-btn-active",
                )}
              >
                <p className="font-semibold text-sm">{tab.title}</p>
                <p className="text-xs mt-1 opacity-80">{tab.summary}</p>
              </button>
            ))}
          </aside>

          <div className="help-page-mobile-tabs md:hidden">
            {GUIDE_TABS.map((tab, i) => (
              <button
                key={`m-${tab.mode}`}
                type="button"
                onClick={() => setActiveIndex(i)}
                className={cn(
                  "help-page-pill",
                  activeIndex === i && "help-page-pill-active",
                )}
              >
                {tab.title.replace(" Tab", "")}
              </button>
            ))}
          </div>

          <section className="help-page-detail">
            <h3 className="text-lg sm:text-xl font-display font-semibold text-white">
              {active.title}
            </h3>
            <p className="text-sm text-white/60 mt-1">{active.summary}</p>
            <ol className="help-page-steps">
              {active.steps.map((step, idx) => (
                <li key={idx} className="help-page-step">
                  <span className="help-page-step-num">{idx + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <div className="help-page-footer">
              <Button
                type="button"
                onClick={() => onSwitchTab(active.mode)}
                variant="ghost"
                className="text-white/70 hover:text-white hover:bg-white/10"
              >
                Open {active.title.replace(" Tab", "")}
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
              <Button
                type="button"
                onClick={handleNext}
                className="bg-primary hover:bg-primary/90 text-white"
              >
                {isLast ? "Start Making" : "Next"}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
