// Shared guide tab definitions used by both the Home auto-launch flow and
// the dedicated Help sidebar tab. Keeping a single source of truth so the
// "Help" tab and any inline guide use identical content.

export type GuideMode =
  | "download"
  | "clips"
  | "subtitles"
  | "clipcutter"
  | "bhagwat"
  | "scenefinder"
  | "timestamps"
  | "upload";

export interface GuideTab {
  mode: GuideMode;
  title: string;
  summary: string;
  steps: string[];
}

export const GUIDE_TABS: GuideTab[] = [
  {
    mode: "download",
    title: "Download Tab",
    summary: "Download complete videos or audio from a source URL.",
    steps: [
      "Paste the video URL and click Start.",
      "Pick quality/audio option from available formats.",
      "Track progress in Active Download and Activity panel.",
      "Use Save when the job is completed.",
    ],
  },
  {
    mode: "clips",
    title: "Best Clips Tab",
    summary: "Use AI to find high-value segments from a long video.",
    steps: [
      "Paste URL and choose duration mode (Auto / 1m / 3m / 8-10m).",
      "Add optional AI instructions for topic-specific clips.",
      "Click Find Best Clips and follow step progress.",
      "Download or retry each suggested clip card.",
    ],
  },
  {
    mode: "subtitles",
    title: "Subtitles Tab",
    summary: "Generate SRT subtitles from URL or uploaded media.",
    steps: [
      "Choose YouTube URL or Upload File mode.",
      "Select source language and optional translation language.",
      "Start generation and monitor the stage tracker.",
      "Download SRT or copy text when completed.",
    ],
  },
  {
    mode: "clipcutter",
    title: "Clip Cut Tab",
    summary: "Cut an exact time range and download only that segment.",
    steps: [
      "Paste URL and set Start / End timestamps.",
      "Choose output quality and click Cut & Download.",
      "Watch queue/progress status in job cards.",
      "Use Save when clip status becomes done.",
    ],
  },
  {
    mode: "bhagwat",
    title: "Bhagwat Studio Tab",
    summary: "Build devotional story videos with AI scene planning and rendering.",
    steps: [
      "Open Bhagwat Studio and unlock access with your password.",
      "Paste a URL or upload audio, then run Analyze to create timeline scenes.",
      "Review and improve AI prompt suggestions before render.",
      "Render final video and download from history when done.",
    ],
  },
  {
    mode: "scenefinder",
    title: "Find Sabha Tab",
    summary: "Identify a Katha sabha venue by matching photos against your saved reference library.",
    steps: [
      "Upload reference photos for every known sabha venue in the Library.",
      "Add place name, location/date, and visual notes for each batch.",
      "Upload a query photo in Identify.",
      "Review AI-ranked sabha matches with shared visual features.",
    ],
  },
  {
    mode: "timestamps",
    title: "Timestamps Tab",
    summary: "Generate YouTube chapter timestamps from any video using AI.",
    steps: [
      "Paste a YouTube URL and click Generate Timestamps.",
      "AI fetches the transcript automatically (or uses AssemblyAI if no subtitles).",
      "Gemini 2.5 Pro creates meaningful chapter markers.",
      "Copy the timestamps directly into your YouTube description.",
    ],
  },
  {
    mode: "upload",
    title: "Share Tab",
    summary: "Upload files and share them via public gallery.",
    steps: [
      "Navigate to the Share tab.",
      "Select a file to upload from your local device.",
      "Set its visibility to Public to show it in the gallery.",
      "Share the direct link or let others browse the public gallery.",
    ],
  },
];
