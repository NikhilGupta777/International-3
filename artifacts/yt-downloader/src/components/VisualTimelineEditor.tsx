import React, { useState, useEffect } from "react";
import { 
  Play, Pause, Trash2, ChevronLeft, ChevronRight, 
  Settings, Film, Music, Layers, Image, 
  RotateCcw, Sliders, RefreshCw, Scissors,
  Volume2, Lock, Eye, EyeOff, FileVideo, Plus
} from "lucide-react";
import { 
  videoEditorApi, 
  type EditorProject, 
  type Timeline, 
  type TimelineClip,
  type TimedOverlay,
  type AudioClip,
  type EditorAspectRatio,
  type EditorCropMode
} from "@/lib/video-editor-api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { workspaceApi } from "@/lib/workspace-api";

interface VisualTimelineEditorProps {
  project: EditorProject;
  onUpdateProject: (project: EditorProject) => void;
  onTriggerPreview: () => Promise<void>;
  onTriggerFinalRender: () => Promise<void>;
}

export function VisualTimelineEditor({
  project,
  onUpdateProject,
  onTriggerPreview,
  onTriggerFinalRender,
}: VisualTimelineEditorProps) {
  const { toast } = useToast();
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  
  // Drag & drop and upload progress states
  const [uploadingTrack, setUploadingTrack] = useState<"video" | "overlay" | "audio" | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isDragging, setIsDragging] = useState<"video" | "overlay" | "audio" | null>(null);

  // Local state for clip edit form
  const [trimIn, setTrimIn] = useState<number>(0);
  const [trimOut, setTrimOut] = useState<number>(0);
  const [clipSpeed, setClipSpeed] = useState<number>(1.0);
  const [transitionInType, setTransitionInType] = useState<string>("none");
  const [transitionInDuration, setTransitionInDuration] = useState<number>(0.5);
  const [transitionOutType, setTransitionOutType] = useState<string>("none");
  const [transitionOutDuration, setTransitionOutDuration] = useState<number>(0.5);

  // Parse or initialize the timeline
  const timeline: Timeline = project.timeline || {
    tracks: { video: [], overlays: [], audio: [] },
    export: { aspectRatio: "original", resolution: "1080p", cropMode: "smart", colorPreset: "none" }
  };

  const videoClips = timeline.tracks?.video || [];
  const audioClips = timeline.tracks?.audio || [];
  const overlays = timeline.tracks?.overlays || [];

  // Find currently selected clip
  const selectedClip = videoClips.find(c => c.id === selectedClipId);

  // Sync edit form states when selected clip changes
  useEffect(() => {
    if (selectedClip) {
      setTrimIn(selectedClip.srcIn);
      setTrimOut(selectedClip.srcOut);
      setClipSpeed(selectedClip.speed || 1.0);
      setTransitionInType(selectedClip.transitionIn?.type || "none");
      setTransitionInDuration(selectedClip.transitionIn?.duration || 0.5);
      setTransitionOutType(selectedClip.transitionOut?.type || "none");
      setTransitionOutDuration(selectedClip.transitionOut?.duration || 0.5);
    }
  }, [selectedClipId, selectedClip]);

  // Save timeline to S3 / Backend
  const saveTimeline = async (updatedTimeline: Timeline) => {
    setIsSaving(true);
    try {
      const response = await videoEditorApi.patchTimeline(project.projectId, updatedTimeline);
      onUpdateProject(response.project);
      toast({
        title: "Timeline synced",
        description: "Your timeline changes have been saved successfully.",
      });
    } catch (err: any) {
      toast({
        title: "Failed to sync timeline",
        description: err.message || "An error occurred while saving your changes.",
        variant: "destructive"
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Helper: Get basename of S3 file key
  const getBasename = (path?: string | null) => {
    if (!path) return "No source video";
    const parts = path.split("/");
    return parts[parts.length - 1];
  };

  // Calculate total visual duration of timeline
  const totalDuration = videoClips.reduce((acc, clip) => {
    const clipDur = (clip.srcOut - clip.srcIn) / (clip.speed || 1.0);
    return acc + clipDur;
  }, 0);

  // Update Aspect Ratio
  const handleUpdateAspectRatio = (ratio: EditorAspectRatio) => {
    const updated: Timeline = {
      ...timeline,
      export: {
        ...timeline.export,
        aspectRatio: ratio
      }
    };
    void saveTimeline(updated);
  };

  // Update Crop Mode
  const handleUpdateCropMode = (mode: EditorCropMode) => {
    const updated: Timeline = {
      ...timeline,
      export: {
        ...timeline.export,
        cropMode: mode
      }
    };
    void saveTimeline(updated);
  };

  // Reorder Clip: Move Left
  const handleMoveLeft = (index: number) => {
    if (index === 0) return;
    const newVideo = [...videoClips];
    const temp = newVideo[index];
    newVideo[index] = newVideo[index - 1];
    newVideo[index - 1] = temp;

    // Recalculate tlStart timestamps sequentially
    let startOffset = 0;
    const recalculated = newVideo.map(clip => {
      const duration = (clip.srcOut - clip.srcIn) / (clip.speed || 1.0);
      const updatedClip = { ...clip, tlStart: startOffset };
      startOffset += duration;
      return updatedClip;
    });

    const updated: Timeline = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        video: recalculated
      }
    };
    void saveTimeline(updated);
  };

  // Reorder Clip: Move Right
  const handleMoveRight = (index: number) => {
    if (index === videoClips.length - 1) return;
    const newVideo = [...videoClips];
    const temp = newVideo[index];
    newVideo[index] = newVideo[index + 1];
    newVideo[index + 1] = temp;

    // Recalculate tlStart timestamps sequentially
    let startOffset = 0;
    const recalculated = newVideo.map(clip => {
      const duration = (clip.srcOut - clip.srcIn) / (clip.speed || 1.0);
      const updatedClip = { ...clip, tlStart: startOffset };
      startOffset += duration;
      return updatedClip;
    });

    const updated: Timeline = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        video: recalculated
      }
    };
    void saveTimeline(updated);
  };

  // Delete Clip
  const handleDeleteClip = (clipId: string) => {
    const newVideo = videoClips.filter(c => c.id !== clipId);
    
    // Recalculate timestamps
    let startOffset = 0;
    const recalculated = newVideo.map(clip => {
      const duration = (clip.srcOut - clip.srcIn) / (clip.speed || 1.0);
      const updatedClip = { ...clip, tlStart: startOffset };
      startOffset += duration;
      return updatedClip;
    });

    const updated: Timeline = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        video: recalculated
      }
    };
    if (selectedClipId === clipId) setSelectedClipId(null);
    void saveTimeline(updated);
  };

  // Apply Trim & Details to selected clip
  const handleSaveClipDetails = () => {
    if (!selectedClipId) return;
    
    const newVideo = videoClips.map(clip => {
      if (clip.id === selectedClipId) {
        const updatedClip: TimelineClip = {
          ...clip,
          srcIn: trimIn,
          srcOut: trimOut,
          speed: clipSpeed,
          transitionIn: transitionInType !== "none" ? { type: transitionInType as any, duration: transitionInDuration } : undefined,
          transitionOut: transitionOutType !== "none" ? { type: transitionOutType as any, duration: transitionOutDuration } : undefined,
        };
        return updatedClip;
      }
      return clip;
    });

    // Recalculate start offsets sequentially
    let startOffset = 0;
    const recalculated = newVideo.map(clip => {
      const duration = (clip.srcOut - clip.srcIn) / (clip.speed || 1.0);
      const updatedClip = { ...clip, tlStart: startOffset };
      startOffset += duration;
      return updatedClip;
    });

    const updated: Timeline = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        video: recalculated
      }
    };
    void saveTimeline(updated);
  };

  // Watermark Logo Position updater
  const handleLogoPosition = (pos: "top-right" | "top-left" | "bottom-right" | "bottom-left") => {
    const logoOverlay = overlays.find(o => o.type === "logo");
    let updatedOverlays = [...overlays];
    if (logoOverlay) {
      updatedOverlays = overlays.map(o => o.type === "logo" ? { ...o, position: pos } : o);
    } else if (project.assets.logo) {
      updatedOverlays.push({
        id: `logo-${Date.now()}`,
        type: "logo",
        content: project.assets.logo,
        tlStart: 0,
        tlEnd: totalDuration || 10,
        position: pos,
        style: { widthPercent: 8 }
      });
    }

    const updated: Timeline = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        overlays: updatedOverlays
      }
    };
    void saveTimeline(updated);
  };

  // Watermark Logo Width slider
  const handleLogoWidth = (width: number) => {
    const updatedOverlays = overlays.map(o => {
      if (o.type === "logo") {
        return {
          ...o,
          style: { ...o.style, widthPercent: width }
        };
      }
      return o;
    });

    const updated: Timeline = {
      ...timeline,
      tracks: {
        ...timeline.tracks,
        overlays: updatedOverlays
      }
    };
    void saveTimeline(updated);
  };

  const [previewUrl, setPreviewUrl] = useState<string>("");

  // Determine current preview source path
  const lastRender = project.renders?.find(r => r.status === "done" && r.outputPath);
  const previewPath = lastRender?.outputPath || project.sourceVideo;

  useEffect(() => {
    if (!previewPath) {
      setPreviewUrl("");
      return;
    }
    let cancelled = false;
    workspaceApi.getFile(previewPath, { inline: true })
      .then(({ url }) => {
        if (!cancelled) {
          setPreviewUrl(url);
        }
      })
      .catch((err) => {
        console.error("Failed to get preview URL:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [previewPath]);

  const activeLogo = overlays.find(o => o.type === "logo");
  const logoWidth = activeLogo?.style?.widthPercent || 8;

  // Media duration helper using HTML5 audio/video loader
  const getMediaDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      const isAudio = file.type.startsWith("audio/");
      const element = document.createElement(isAudio ? "audio" : "video");
      element.src = URL.createObjectURL(file);
      element.onloadedmetadata = () => {
        URL.revokeObjectURL(element.src);
        resolve(element.duration || 10);
      };
      element.onerror = () => {
        resolve(10);
      };
    });
  };

  // Drag & drop handlers
  const handleDragOver = (e: React.DragEvent, track: "video" | "overlay" | "audio") => {
    e.preventDefault();
    setIsDragging(track);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(null);
  };

  const handleDrop = async (e: React.DragEvent, track: "video" | "overlay" | "audio") => {
    e.preventDefault();
    setIsDragging(null);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    const file = files[0];

    // Simple validation of file types
    if (track === "video" && !file.type.startsWith("video/")) {
      toast({ title: "Invalid file type", description: "Please drop a video file.", variant: "destructive" });
      return;
    }
    if (track === "overlay" && !file.type.startsWith("image/")) {
      toast({ title: "Invalid file type", description: "Please drop an image/logo file.", variant: "destructive" });
      return;
    }
    if (track === "audio" && !file.type.startsWith("audio/")) {
      toast({ title: "Invalid file type", description: "Please drop an audio file.", variant: "destructive" });
      return;
    }

    setUploadingTrack(track);
    setUploadProgress(0);

    try {
      const role = track === "video" ? "source" : track === "audio" ? "audio" : "logo";
      const result = await videoEditorApi.uploadAsset(
        project.projectId,
        role,
        file,
        (fraction) => {
          setUploadProgress(Math.round(fraction * 100));
        }
      );

      // Now add to timeline
      if (track === "video") {
        const duration = await getMediaDuration(file);
        const newClip: TimelineClip = {
          id: `clip-${Date.now()}`,
          asset: result.path,
          srcIn: 0,
          srcOut: duration,
          tlStart: totalDuration,
          speed: 1.0
        };
        const updatedVideo = [...videoClips, newClip];
        const updated: Timeline = {
          ...timeline,
          tracks: {
            ...timeline.tracks,
            video: updatedVideo
          }
        };
        await saveTimeline(updated);
      } else if (track === "overlay") {
        const newOverlay: TimedOverlay = {
          id: `overlay-${Date.now()}`,
          type: "logo",
          content: result.path,
          tlStart: 0,
          tlEnd: totalDuration || 10,
          position: "top-right",
          style: { widthPercent: 8 }
        };
        const updatedOverlays = [...overlays, newOverlay];
        const updated: Timeline = {
          ...timeline,
          tracks: {
            ...timeline.tracks,
            overlays: updatedOverlays
          }
        };
        await saveTimeline(updated);
      } else if (track === "audio") {
        const duration = await getMediaDuration(file);
        const newAudio: AudioClip = {
          id: `audio-${Date.now()}`,
          asset: result.path,
          tlStart: 0,
          tlEnd: duration,
          volumeDb: 0,
          fadeIn: 0.5,
          fadeOut: 0.5,
          duckSpeech: false
        };
        const updatedAudio = [...audioClips, newAudio];
        const updated: Timeline = {
          ...timeline,
          tracks: {
            ...timeline.tracks,
            audio: updatedAudio
          }
        };
        await saveTimeline(updated);
      }

      toast({
        title: "Asset uploaded & added",
        description: `Successfully uploaded ${file.name} to the ${track} track.`
      });
    } catch (err: any) {
      toast({
        title: "Upload failed",
        description: err.message || "An error occurred during file upload.",
        variant: "destructive"
      });
    } finally {
      setUploadingTrack(null);
      setUploadProgress(0);
    }
  };

  // Timeline Ruler Ticks Generator (scale: 1s = 15px)
  const PX_PER_SEC = 15;
  const maxSeconds = Math.max(60, totalDuration + 15);
  const timelineWidth = maxSeconds * PX_PER_SEC;

  const renderRulerTicks = () => {
    const ticks = [];
    for (let s = 0; s <= maxSeconds; s++) {
      const isMajor = s % 5 === 0;
      const x = s * PX_PER_SEC;
      ticks.push(
        <div 
          key={s} 
          className="absolute bottom-0 flex flex-col items-center select-none pointer-events-none" 
          style={{ left: `${x}px`, transform: 'translateX(-50%)' }}
        >
          {isMajor ? (
            <>
              <span className="text-[8px] text-zinc-500 font-mono mb-0.5">{s}s</span>
              <div className="w-[1px] h-2 bg-zinc-350 dark:bg-zinc-700" />
            </>
          ) : (
            <div className="w-[1px] h-1 bg-zinc-200 dark:bg-zinc-800" />
          )}
        </div>
      );
    }
    return ticks;
  };

  return (
    <div className="visual-timeline-editor flex flex-col h-full overflow-y-auto">
      
      {/* 1. Header Toolbar */}
      <div className="visual-timeline-editor__toolbar flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2">
          <Film className="w-5 h-5 text-sky-500" />
          <h2 className="text-sm font-semibold tracking-wide uppercase text-zinc-700 dark:text-zinc-300">Visual Studio Editor</h2>
          {isSaving && <span className="text-xs text-zinc-400 dark:text-zinc-500 animate-pulse">(saving...)</span>}
        </div>
        
        <div className="flex items-center gap-2">
          {/* Aspect Ratio selector */}
          <div className="flex items-center bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-0.5 rounded-xl gap-0.5">
            {(["original", "16:9", "9:16", "1:1"] as EditorAspectRatio[]).map(ratio => (
              <button
                key={ratio}
                onClick={() => handleUpdateAspectRatio(ratio)}
                className={`text-[10px] font-medium px-2.5 py-1.5 rounded-lg transition-all ${
                  (timeline.export?.aspectRatio || "original") === ratio
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm border border-zinc-200/50 dark:border-transparent"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {ratio === "original" ? "Original" : ratio}
              </button>
            ))}
          </div>

          {/* Crop Mode dropdown */}
          <select
            value={timeline.export?.cropMode || "smart"}
            onChange={(e) => handleUpdateCropMode(e.target.value as EditorCropMode)}
            className="bg-white dark:bg-zinc-900 text-xs text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 rounded-xl outline-none cursor-pointer"
            aria-label="Crop Mode"
          >
            <option value="smart">Smart Crop</option>
            <option value="fit-blur">Fit with Blur</option>
            <option value="contain">Contain</option>
          </select>
        </div>
      </div>

      {/* 2. Video Player Preview */}
      <div className="visual-timeline-editor__preview relative aspect-video w-full rounded-2xl border border-zinc-200/50 dark:border-white/10 bg-gradient-to-b from-zinc-100 to-zinc-50 dark:from-zinc-900 dark:to-black overflow-hidden group mb-6 flex items-center justify-center shadow-lg shadow-black/5 dark:shadow-black/40 backdrop-blur-xl">
        {previewUrl ? (
          <video
            src={previewUrl}
            className="w-full h-full object-contain"
            controls
            preload="metadata"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 text-xs font-medium gap-3">
            <div className="p-4 rounded-full bg-zinc-200/50 dark:bg-zinc-800/50 backdrop-blur-sm">
              <Film className="w-10 h-10 text-zinc-400 dark:text-zinc-600 stroke-[1.5]" />
            </div>
            <span>Upload a video or add clips to start editing</span>
          </div>
        )}

        {/* Floating render triggers */}
        {previewUrl && (
          <div className="absolute top-4 right-4 flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-all duration-300 transform translate-y-[-10px] group-hover:translate-y-0">
            <Button
              variant="outline"
              size="sm"
              onClick={onTriggerPreview}
              className="text-xs bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md border-zinc-200/50 dark:border-white/10 hover:bg-white dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300 shadow-xl transition-all"
            >
              <RefreshCw className="w-3 h-3 mr-1.5" />
              Preview (8s)
            </Button>
            <Button
              size="sm"
              onClick={onTriggerFinalRender}
              className="text-xs bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 border border-sky-400/20 text-white font-semibold shadow-xl transition-all"
            >
              Full Render
            </Button>
          </div>
        )}
      </div>

      {/* 3. Horizontal Multi-Track Timeline */}
      <div className="visual-timeline-editor__timeline flex flex-col bg-white/50 dark:bg-zinc-900/30 border border-zinc-200/50 dark:border-white/5 rounded-2xl overflow-hidden mb-5 shadow-sm backdrop-blur-md">
        <div className="flex select-none">
          
          {/* Left: Headers (Fixed 140px panel) */}
          <div className="w-[140px] flex-shrink-0 flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-zinc-100/40 dark:bg-zinc-900/40">
            {/* Header for Ruler */}
            <div className="h-8 flex items-center px-3 border-b border-zinc-200 dark:border-zinc-850 text-[9px] text-zinc-400 dark:text-zinc-500 font-bold uppercase tracking-wider">
              Tracks
            </div>
            {/* Header for V1 Video */}
            <div className="h-[76px] flex flex-col justify-between p-2.5 border-b border-zinc-200 dark:border-zinc-850 bg-zinc-50/20 dark:bg-zinc-950/20">
              <div className="flex items-center justify-between">
                <span className="font-bold text-zinc-700 dark:text-zinc-300 text-[11px]">V1 Video</span>
                <div className="flex items-center gap-1.5">
                  <button className="p-0.5 text-zinc-400 hover:text-sky-500 dark:text-zinc-500" title="Toggle visibility"><Eye className="w-3.5 h-3.5" /></button>
                  <button className="p-0.5 text-zinc-400 hover:text-amber-505 dark:text-zinc-500" title="Lock track"><Lock className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <span className="text-[9px] text-zinc-400 dark:text-zinc-500 font-medium">{videoClips.length} clips</span>
            </div>
            {/* Header for O1 Overlays */}
            <div className="h-[76px] flex flex-col justify-between p-2.5 border-b border-zinc-200 dark:border-zinc-850 bg-zinc-50/20 dark:bg-zinc-950/20">
              <div className="flex items-center justify-between">
                <span className="font-bold text-zinc-700 dark:text-zinc-300 text-[11px]">O1 Overlay</span>
                <div className="flex items-center gap-1.5">
                  <button className="p-0.5 text-zinc-400 hover:text-sky-500 dark:text-zinc-500" title="Toggle visibility"><Eye className="w-3.5 h-3.5" /></button>
                  <button className="p-0.5 text-zinc-400 hover:text-amber-505 dark:text-zinc-500" title="Lock track"><Lock className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <span className="text-[9px] text-zinc-400 dark:text-zinc-500 font-medium">{overlays.length} active</span>
            </div>
            {/* Header for A1 Audio */}
            <div className="h-[76px] flex flex-col justify-between p-2.5 bg-zinc-50/20 dark:bg-zinc-950/20">
              <div className="flex items-center justify-between">
                <span className="font-bold text-zinc-700 dark:text-zinc-300 text-[11px]">A1 Audio</span>
                <div className="flex items-center gap-1.5">
                  <button className="p-0.5 text-zinc-400 hover:text-emerald-500 dark:text-zinc-500" title="Mute track"><Volume2 className="w-3.5 h-3.5" /></button>
                  <button className="p-0.5 text-zinc-400 hover:text-amber-505 dark:text-zinc-500" title="Lock track"><Lock className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              <span className="text-[9px] text-zinc-400 dark:text-zinc-500 font-medium">{audioClips.length} clips</span>
            </div>
          </div>

          {/* Right: Scrollable lanes */}
          <div className="flex-1 overflow-x-auto flex flex-col min-w-0 scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-800 scrollbar-track-transparent">
            {/* Ruler Lane */}
            <div className="h-8 border-b border-zinc-200 dark:border-white/5 bg-zinc-50/50 dark:bg-zinc-900/30 relative backdrop-blur-sm" style={{ width: `${timelineWidth}px` }}>
              {renderRulerTicks()}
            </div>
            
            {/* V1 Video Lane */}
            <div 
              className={`h-[76px] border-b border-zinc-200 dark:border-white/5 relative flex items-center p-1.5 transition-colors ${
                isDragging === "video" ? "bg-sky-50 dark:bg-sky-500/10 border-sky-400/50" : "bg-white/40 dark:bg-black/20 hover:bg-white/60 dark:hover:bg-black/40"
              }`}
              style={{ width: `${timelineWidth}px` }}
              onDragOver={(e) => handleDragOver(e, "video")}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, "video")}
            >
              {videoClips.map((clip, index) => {
                const duration = (clip.srcOut - clip.srcIn) / (clip.speed || 1.0);
                const isSelected = clip.id === selectedClipId;
                const left = clip.tlStart * PX_PER_SEC;
                const width = duration * PX_PER_SEC;

                return (
                  <div
                    key={clip.id}
                    onClick={() => setSelectedClipId(clip.id)}
                    className={`absolute h-[60px] rounded-lg border flex flex-col justify-between p-2 select-none cursor-pointer group/clip transition-all overflow-hidden backdrop-blur-md ${
                      isSelected
                        ? "bg-sky-50/90 border-sky-400 dark:bg-sky-500/30 dark:border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.2)] z-10"
                        : "bg-white/80 border-zinc-200 hover:border-sky-300 hover:bg-sky-50 dark:bg-zinc-800/80 dark:border-zinc-700 dark:hover:border-zinc-500 dark:hover:bg-zinc-700/90 shadow-sm"
                    }`}
                    style={{
                      left: `${left}px`,
                      width: `${Math.max(120, width)}px`,
                    }}
                  >
                    {/* Top color strip */}
                    <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-sky-400 to-blue-500 opacity-80" />
                    <div className="flex items-start justify-between gap-1 min-w-0">
                      <div className="flex flex-col min-w-0">
                        <span className="text-[8px] font-bold text-sky-550 dark:text-sky-450 uppercase tracking-wider">V1-{index + 1}</span>
                        <span className="text-[10px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{getBasename(clip.asset)}</span>
                      </div>
                      <div className="flex items-center opacity-0 group-hover/clip:opacity-100 transition-opacity gap-0.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleMoveLeft(index); }}
                          disabled={index === 0}
                          className="p-0.5 rounded text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-30"
                          title="Move Left"
                        >
                          <ChevronLeft className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleMoveRight(index); }}
                          disabled={index === videoClips.length - 1}
                          className="p-0.5 rounded text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 disabled:opacity-30"
                          title="Move Right"
                        >
                          <ChevronRight className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteClip(clip.id); }}
                          className="p-0.5 rounded text-zinc-400 hover:text-red-500"
                          title="Delete Clip"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[9px] text-zinc-500 dark:text-zinc-400 font-mono">
                      <span>{duration.toFixed(1)}s</span>
                      <div className="flex items-center gap-1">
                        {clip.speed !== 1 && <span className="bg-zinc-100 dark:bg-zinc-800 px-1 py-0.2 rounded text-amber-600 dark:text-amber-400 font-bold">{clip.speed}x</span>}
                        {(clip.transitionIn || clip.transitionOut) && <span className="bg-sky-50 dark:bg-sky-950/40 text-sky-600 dark:text-sky-400 border border-sky-200 dark:border-sky-900/30 px-1 rounded font-bold text-[8px]">FX</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
              
              {uploadingTrack === "video" && (
                <div
                  className="absolute h-[60px] rounded-lg border border-dashed border-sky-400 bg-sky-50 dark:bg-sky-500/5 flex items-center justify-center p-2"
                  style={{
                    left: `${totalDuration * PX_PER_SEC}px`,
                    width: "120px"
                  }}
                >
                  <div className="flex flex-col items-center gap-1">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-500" />
                    <span className="text-[9px] text-sky-650 dark:text-zinc-400 font-mono">{uploadProgress}%</span>
                  </div>
                </div>
              )}

              {videoClips.length === 0 && uploadingTrack !== "video" && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400 dark:text-zinc-500 pointer-events-none">
                  Drag & Drop Video Clip Here
                </div>
              )}
            </div>

            {/* O1 Overlay Lane */}
            <div 
              className={`h-[76px] border-b border-zinc-200 dark:border-white/5 relative flex items-center p-1.5 transition-colors ${
                isDragging === "overlay" ? "bg-pink-50 dark:bg-pink-500/10 border-pink-400/50" : "bg-white/40 dark:bg-black/20 hover:bg-white/60 dark:hover:bg-black/40"
              }`}
              style={{ width: `${timelineWidth}px` }}
              onDragOver={(e) => handleDragOver(e, "overlay")}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, "overlay")}
            >
              {overlays.map((ov) => {
                const duration = ov.tlEnd - ov.tlStart;
                const left = ov.tlStart * PX_PER_SEC;
                const width = duration * PX_PER_SEC;

                return (
                  <div
                    key={ov.id}
                    className="absolute h-[60px] rounded-lg border flex flex-col justify-between p-2 select-none overflow-hidden backdrop-blur-md bg-pink-50/90 border-pink-200 shadow-sm dark:bg-pink-500/20 dark:border-pink-500/40 transition-colors hover:border-pink-300 dark:hover:border-pink-500/60"
                    style={{
                      left: `${left}px`,
                      width: `${Math.max(120, width)}px`,
                    }}
                  >
                    <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-pink-400 to-rose-500 opacity-80" />
                    <div className="flex items-start justify-between gap-1 min-w-0">
                      <div className="flex flex-col min-w-0">
                        <span className="text-[8px] font-bold text-pink-600 dark:text-pink-455 uppercase tracking-wider">O1-{ov.type}</span>
                        <span className="text-[10px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{getBasename(ov.content)}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const updatedOverlays = overlays.filter(o => o.id !== ov.id);
                          const updated = { ...timeline, tracks: { ...timeline.tracks, overlays: updatedOverlays } };
                          void saveTimeline(updated);
                        }}
                        className="p-0.5 rounded text-zinc-400 hover:text-red-500"
                        title="Delete Overlay"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[9px] text-zinc-500 dark:text-zinc-400">
                      <span>{duration.toFixed(1)}s</span>
                      <span className="text-[8px] bg-pink-100 text-pink-700 border border-pink-200 px-1 py-0.2 rounded uppercase dark:bg-pink-950/40 dark:text-pink-400 dark:border-pink-900/30">{ov.position}</span>
                    </div>
                  </div>
                );
              })}

              {uploadingTrack === "overlay" && (
                <div
                  className="absolute h-[60px] rounded-lg border border-dashed border-pink-400 bg-pink-50 dark:bg-pink-500/5 flex items-center justify-center p-2"
                  style={{
                    left: `0px`,
                    width: "120px"
                  }}
                >
                  <div className="flex flex-col items-center gap-1">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-pink-550" />
                    <span className="text-[9px] text-pink-650 dark:text-zinc-400 font-mono">{uploadProgress}%</span>
                  </div>
                </div>
              )}

              {overlays.length === 0 && uploadingTrack !== "overlay" && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400 dark:text-zinc-500 pointer-events-none">
                  Drag & Drop Watermark Logo Here
                </div>
              )}
            </div>

            {/* A1 Audio Lane */}
            <div 
              className={`h-[76px] relative flex items-center p-1.5 transition-colors ${
                isDragging === "audio" ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-400/50" : "bg-white/40 dark:bg-black/20 hover:bg-white/60 dark:hover:bg-black/40"
              }`}
              style={{ width: `${timelineWidth}px` }}
              onDragOver={(e) => handleDragOver(e, "audio")}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, "audio")}
            >
              {audioClips.map((audio) => {
                const duration = audio.tlEnd - audio.tlStart;
                const left = audio.tlStart * PX_PER_SEC;
                const width = duration * PX_PER_SEC;

                return (
                  <div
                    key={audio.id}
                    className="absolute h-[60px] rounded-lg border flex flex-col justify-between p-2 select-none overflow-hidden backdrop-blur-md bg-emerald-50/90 border-emerald-200 shadow-sm dark:bg-emerald-500/20 dark:border-emerald-500/40 transition-colors hover:border-emerald-300 dark:hover:border-emerald-500/60"
                    style={{
                      left: `${left}px`,
                      width: `${Math.max(120, width)}px`,
                    }}
                  >
                    <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-emerald-400 to-teal-500 opacity-80" />
                    <div className="flex items-start justify-between gap-1 min-w-0">
                      <div className="flex flex-col min-w-0">
                        <span className="text-[8px] font-bold text-emerald-600 dark:text-emerald-455 uppercase tracking-wider">A1-Audio</span>
                        <span className="text-[10px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{getBasename(audio.asset)}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const updatedAudio = audioClips.filter(a => a.id !== audio.id);
                          const updated = { ...timeline, tracks: { ...timeline.tracks, audio: updatedAudio } };
                          void saveTimeline(updated);
                        }}
                        className="p-0.5 rounded text-zinc-400 hover:text-red-500"
                        title="Delete Audio"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[9px] text-zinc-550 dark:text-zinc-400 font-mono">
                      <span>{duration.toFixed(1)}s</span>
                      <span>{audio.volumeDb} dB</span>
                    </div>
                  </div>
                );
              })}

              {uploadingTrack === "audio" && (
                <div
                  className="absolute h-[60px] rounded-lg border border-dashed border-emerald-400 bg-emerald-55/5 dark:bg-emerald-500/5 flex items-center justify-center p-2"
                  style={{
                    left: `0px`,
                    width: "120px"
                  }}
                >
                  <div className="flex flex-col items-center gap-1">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                    <span className="text-[9px] text-emerald-600 dark:text-zinc-400 font-mono">{uploadProgress}%</span>
                  </div>
                </div>
              )}

              {audioClips.length === 0 && uploadingTrack !== "audio" && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400 dark:text-zinc-500 pointer-events-none">
                  Drag & Drop Audio Track Here
                </div>
              )}
            </div>

          </div>
        </div>
      </div>

      {/* 4. Track Config / Watermark Settings (if logo exists) */}
      {project.assets.logo && (
        <div className="flex items-center justify-between bg-white/50 dark:bg-zinc-900/30 backdrop-blur-md border border-zinc-200/50 dark:border-white/5 p-3 rounded-xl gap-4 mb-5 shadow-sm text-xs">
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-pink-50 dark:bg-pink-500/10">
              <Image className="w-4 h-4 text-pink-500" />
            </div>
            <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">Watermark: <span className="font-normal text-zinc-500">{getBasename(project.assets.logo)}</span></span>
          </div>
          <div className="flex items-center gap-4">
            {/* Position selector */}
            <div className="flex items-center bg-zinc-100/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 p-0.5 rounded-lg gap-0.5">
              {(["top-left", "top-right", "bottom-left", "bottom-right"] as const).map(pos => (
                <button
                  key={pos}
                  onClick={() => handleLogoPosition(pos)}
                  className={`text-[9px] font-semibold tracking-wide px-2 py-1 rounded transition-colors ${
                    (activeLogo?.position || "top-right") === pos
                      ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm"
                      : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                  }`}
                >
                  {pos.replace("-", " ")}
                </button>
              ))}
            </div>

            {/* Size slider */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500">Width: {logoWidth}%</span>
              <input
                type="range"
                min={3}
                max={25}
                value={logoWidth}
                onChange={(e) => handleLogoWidth(parseInt(e.target.value))}
                className="w-20 accent-sky-550 h-1 bg-zinc-200 dark:bg-zinc-800 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>
        </div>
      )}

      {/* 5. Clip Inspector Panel */}
      {selectedClip ? (
        <div className="flex flex-col bg-white/50 dark:bg-zinc-900/30 backdrop-blur-md border border-zinc-200/50 dark:border-white/5 p-5 rounded-2xl gap-5 shadow-sm">
          <div className="flex items-center justify-between border-b border-zinc-200/50 dark:border-white/5 pb-3">
            <div className="flex items-center gap-3">
              <div className="p-1.5 rounded-lg bg-sky-50 dark:bg-sky-500/10">
                <Scissors className="w-4 h-4 text-sky-500" />
              </div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-800 dark:text-zinc-200">Clip Inspector: <span className="font-medium text-zinc-500 normal-case ml-1">{getBasename(selectedClip.asset)}</span></h3>
            </div>
            <button 
              onClick={() => setSelectedClipId(null)}
              className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 font-medium transition-colors"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
            {/* Trim controls */}
            <div className="flex flex-col gap-3">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">Trim Range (seconds)</span>
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1 flex-1">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">Start Offset (srcIn)</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={trimIn}
                    onChange={(e) => setTrimIn(parseFloat(e.target.value) || 0)}
                    className="bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 rounded-lg p-2 text-zinc-800 dark:text-zinc-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/50 transition-all"
                  />
                </div>
                <div className="flex flex-col gap-1.5 flex-1">
                  <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">End Offset (srcOut)</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={trimOut}
                    onChange={(e) => setTrimOut(parseFloat(e.target.value) || 0)}
                    className="bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 rounded-lg p-2 text-zinc-800 dark:text-zinc-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/50 transition-all"
                  />
                </div>
              </div>
            </div>

            {/* Playback speed */}
            <div className="flex flex-col gap-1.5">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300 mb-1">Play Speed</span>
              <select
                value={clipSpeed}
                onChange={(e) => setClipSpeed(parseFloat(e.target.value))}
                className="bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 rounded-lg p-2 text-zinc-800 dark:text-zinc-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/50 transition-all cursor-pointer"
              >
                <option value={0.25}>0.25x (Slow Motion)</option>
                <option value={0.5}>0.5x</option>
                <option value={1.0}>1.0x (Normal)</option>
                <option value={1.5}>1.5x</option>
                <option value={2.0}>2.0x (Double Speed)</option>
                <option value={4.0}>4.0x</option>
              </select>
            </div>

            {/* Transition IN */}
            <div className="flex flex-col gap-3">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">Transition IN</span>
              <div className="flex items-center gap-3">
                <select
                  value={transitionInType}
                  onChange={(e) => setTransitionInType(e.target.value)}
                  className="bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 rounded-lg p-2 text-zinc-800 dark:text-zinc-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/50 transition-all cursor-pointer flex-1"
                >
                  <option value="none">None</option>
                  <option value="fade">Fade</option>
                  <option value="crossfade">Crossfade</option>
                  <option value="blur">Blur</option>
                  <option value="dip-to-black">Dip to Black</option>
                  <option value="wipe">Wipe</option>
                </select>
                
                {transitionInType !== "none" && (
                  <div className="flex flex-col gap-0.5 flex-1">
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">Duration (s)</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={transitionInDuration}
                      onChange={(e) => setTransitionInDuration(parseFloat(e.target.value) || 0.5)}
                      className="bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 rounded-lg p-2 text-zinc-800 dark:text-zinc-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/50 transition-all"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Transition OUT */}
            <div className="flex flex-col gap-3">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">Transition OUT</span>
              <div className="flex items-center gap-3">
                <select
                  value={transitionOutType}
                  onChange={(e) => setTransitionOutType(e.target.value)}
                  className="bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 rounded-lg p-2 text-zinc-800 dark:text-zinc-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/50 transition-all cursor-pointer flex-1"
                >
                  <option value="none">None</option>
                  <option value="fade">Fade</option>
                  <option value="crossfade">Crossfade</option>
                  <option value="blur">Blur</option>
                  <option value="dip-to-black">Dip to Black</option>
                  <option value="wipe">Wipe</option>
                </select>
                
                {transitionOutType !== "none" && (
                  <div className="flex flex-col gap-0.5 flex-1">
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">Duration (s)</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0.1"
                      value={transitionOutDuration}
                      onChange={(e) => setTransitionOutDuration(parseFloat(e.target.value) || 0.5)}
                      className="bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 rounded-lg p-2 text-zinc-800 dark:text-zinc-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-400/50 transition-all"
                    />
                  </div>
                )}
              </div>
            </div>

          </div>

          <div className="flex items-center justify-end gap-3 border-t border-zinc-200/50 dark:border-white/5 pt-4 mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedClipId(null)}
              className="text-xs bg-white/50 dark:bg-black/20 border border-zinc-200/50 dark:border-white/5 hover:bg-zinc-100/50 dark:hover:bg-black/40 text-zinc-600 dark:text-zinc-300 shadow-sm backdrop-blur-md transition-all"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSaveClipDetails}
              className="text-xs bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 border border-sky-400/20 text-white font-semibold shadow-md shadow-sky-500/20 transition-all"
            >
              Apply Changes
            </Button>
          </div>
        </div>
      ) : null}

    </div>
  );
}
