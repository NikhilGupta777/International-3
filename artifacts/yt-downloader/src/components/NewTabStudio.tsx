import React, { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  ArrowUp, Scissors, Clock, Loader2, Sparkles, FolderOpen, 
  Plus, Globe, Wand2, Captions, Search, Film, ArrowRight,
  ChevronDown, ArrowLeft, SlidersHorizontal, Trash2, Layers, Folder,
  FolderPlus, Filter
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Project = {
  id: string;
  name: string;
  youtubeUrl: string;
  createdAt: number;
  updatedAt: number;
  edits: any[];
};

type Mode = "videostudio" | "copilot" | string;

// Top 17 Indian Languages + English translations for "you?"
const INDIAN_LANGUAGES = [
  { lang: "English", text: "you?" },
  { lang: "Hindi", text: "आप?" },
  { lang: "Bengali", text: "আপনি?" },
  { lang: "Telugu", text: "మీరు?" },
  { lang: "Marathi", text: "तुम्ही?" },
  { lang: "Tamil", text: "நீங்கள்?" },
  { lang: "Gujarati", text: "તમે?" },
  { lang: "Kannada", text: "ನೀవు?" },
  { lang: "Malayalam", text: "നിങ്ങൾ?" },
  { lang: "Odia", text: "ଆପଣ?" },
  { lang: "Punjabi", text: "ਤੁਸੀਂ?" },
  { lang: "Assamese", text: "আপੁনি?" },
  { lang: "Urdu", text: "آپ؟" },
  { lang: "Maithili", text: "अहाँ?" },
  { lang: "Sanskrit", text: "भवान्?" },
  { lang: "Manipuri", text: "নহাাক?" },
  { lang: "Kashmiri", text: "تہہ؟" },
];

// Normal Chips — Grey / Black / White Theme
const CHIPS = [
  { id: "edit", label: "Edit Videos", prompt: "Edit video with AI cuts, transitions, and audio sync.", icon: Film },
  { id: "clips", label: "Create Clips", prompt: "Extract top viral clips and short moments from this video.", icon: Scissors },
  { id: "subtitles", label: "Auto Subtitles", prompt: "Generate auto subtitles and multi-language captions for this video.", icon: Captions },
];

function getYouTubeThumbnail(url: string): string | null {
  if (!url) return null;
  const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg`;
  }
  return null;
}

function formatTimeAgo(timestamp: number): string {
  if (!timestamp) return "Recently";
  const diffMs = Date.now() - timestamp;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function NewTabStudio({
  onSwitchMode,
  onOpenVideoStudio,
  onLaunchAgent,
}: {
  onSwitchMode: (m: Mode) => void;
  onOpenVideoStudio: (projectId: string) => void;
  onLaunchAgent?: (prompt: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  
  // Dedicated "All Projects" View Toggle
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [showMoreFolders, setShowMoreFolders] = useState(false);

  // 17 Indian Languages Animation State
  const [langIndex, setLangIndex] = useState(0);

  // Customization States
  const [activeChip, setActiveChip] = useState<string | null>(null);

  const { toast } = useToast();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Cycle through 17 Indian languages every 2.5 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setLangIndex((prev) => (prev + 1) % INDIAN_LANGUAGES.length);
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    fetchProjects();
  }, []);

  const fetchProjects = async () => {
    try {
      setLoadingProjects(true);
      const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/video-editor/projects`);
      if (res.ok) {
        const data = await res.json();
        if (data.projects && Array.isArray(data.projects)) {
          setProjects(data.projects);
        }
      }
    } catch (e) {
      console.error("Failed to fetch projects", e);
    } finally {
      setLoadingProjects(false);
    }
  };

  const handleStartProject = async (text: string) => {
    if (!text.trim() || isSubmitting) return;

    setIsSubmitting(true);
    const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
    const youtubeUrl = urlMatch ? urlMatch[0] : "";

    try {
      const res = await fetch(`${BASE}/api/video-editor/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: text.slice(0, 40) || "New Edit Project",
          youtubeUrl: youtubeUrl
        })
      });

      if (!res.ok) throw new Error("Failed to create project");
      const data = await res.json();

      if (data.project?.id) {
        onOpenVideoStudio(data.project.id);
      }
    } catch (e: any) {
      toast({
        title: "Error starting project",
        description: e.message || "Failed to initialize project",
        variant: "destructive"
      });
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleStartProject(prompt);
    }
  };

  const handleChipClick = (chipPrompt: string, chipId: string) => {
    setActiveChip(chipId);
    setPrompt(chipPrompt);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  // Filtered & Sorted Projects for All Projects View
  const filteredProjects = projects
    .filter(p => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (p.name && p.name.toLowerCase().includes(q)) || (p.youtubeUrl && p.youtubeUrl.toLowerCase().includes(q));
    })
    .sort((a, b) => sortOrder === "newest" ? (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt) : (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt));

  // Extract unique folders/topics from project names
  const folders = Array.from(new Set(projects.map(p => p.name || "Default Folder"))).slice(0, showMoreFolders ? 20 : 6);

  // If "Show All Projects" view is open (Matching Screenshots 1 & 4)
  if (showAllProjects) {
    return (
      <div className="all-projects-page w-full min-h-full flex-1 flex flex-col pt-6 px-6 pb-20 select-none bg-transparent text-white max-w-[1100px] mx-auto overflow-y-auto">
        
        {/* Header Bar matching Screenshot 4 */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowAllProjects(false)}
              className="w-8 h-8 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center text-white/70 hover:text-white transition-colors"
              title="Back to Launchpad"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <h1 className="text-xl font-bold text-white tracking-tight">Projects</h1>
          </div>

          {/* Search & Actions Bar matching Screenshot 4 */}
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-[280px]">
              <Search className="w-4 h-4 text-white/40 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search videos and folders"
                className="w-full bg-[#18181c] border border-white/10 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-white/35 outline-none focus:border-white/30 transition-colors"
              />
            </div>

            {/* Sort Dropdown */}
            <button
              type="button"
              onClick={() => setSortOrder(prev => prev === "newest" ? "oldest" : "newest")}
              className="px-3 py-2 rounded-xl bg-[#18181c] border border-white/10 text-xs font-medium text-white/80 hover:text-white flex items-center gap-1.5 transition-colors"
            >
              <ChevronDown className="w-3.5 h-3.5 text-white/50" />
              <span>{sortOrder === "newest" ? "Newest" : "Oldest"}</span>
            </button>

            {/* Filter Icon Button */}
            <button
              type="button"
              className="w-8.5 h-8.5 rounded-xl bg-[#18181c] border border-white/10 flex items-center justify-center text-white/60 hover:text-white transition-colors"
              title="Filter"
            >
              <Filter className="w-3.5 h-3.5" />
            </button>

            {/* Delete Icon Button */}
            <button
              type="button"
              className="w-8.5 h-8.5 rounded-xl bg-[#18181c] border border-white/10 flex items-center justify-center text-white/60 hover:text-red-400 transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Section 1: Folders matching Screenshot 4 */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold text-white/80 tracking-wider uppercase flex items-center gap-2">
              <span>Folders</span>
              <FolderPlus className="w-3.5 h-3.5 text-white/40 hover:text-white cursor-pointer" />
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {folders.map((folderName, idx) => (
              <div
                key={idx}
                className="bg-[#18181c] hover:bg-[#222226] border border-white/10 hover:border-white/25 rounded-xl p-3.5 flex items-center gap-3 text-xs text-white/80 hover:text-white cursor-pointer transition-all truncate"
              >
                <span className="text-white/40 font-mono text-[11px]">あA</span>
                <span className="truncate font-medium">{folderName}</span>
              </div>
            ))}
          </div>

          {projects.length > 6 && (
            <button
              type="button"
              onClick={() => setShowMoreFolders(!showMoreFolders)}
              className="w-full sm:w-auto px-5 py-2 rounded-xl bg-[#1c2227] hover:bg-[#252c33] border border-cyan-500/20 text-cyan-300 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showMoreFolders && "rotate-180")} />
              <span>{showMoreFolders ? "See Less" : `See More (${projects.length})`}</span>
            </button>
          )}
        </div>

        {/* Section 2: Videos Grid matching Screenshots 1, 2, 3 & 4 */}
        <div>
          <h2 className="text-xs font-bold text-white/80 tracking-wider uppercase mb-4">Videos</h2>

          {filteredProjects.length === 0 ? (
            <div className="w-full py-12 flex flex-col items-center justify-center bg-[#18181c] border border-white/10 rounded-2xl text-white/40 text-xs gap-2">
              <Film className="w-8 h-8 text-white/20" />
              <span>No video projects match your search</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {filteredProjects.map((proj, idx) => {
                const thumb = getYouTubeThumbnail(proj.youtubeUrl);
                const editsCount = proj.edits?.length || 1;
                return (
                  <motion.div
                    key={proj.id || idx}
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    onClick={() => onOpenVideoStudio(proj.id)}
                    className="group relative flex flex-col cursor-pointer"
                  >
                    {/* Thumbnail Container matching Screenshots 1, 2, 3 & 4 */}
                    <div className="relative aspect-[16/10] rounded-2xl overflow-hidden bg-[#18181c] border border-white/10 group-hover:border-white/30 transition-all duration-300 shadow-xl flex items-center justify-center">
                      {thumb ? (
                        <img 
                          src={thumb} 
                          alt={proj.name} 
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1c1c22] to-[#121215]">
                          <div className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white/70">
                            <Folder className="w-5 h-5" />
                          </div>
                        </div>
                      )}

                      {/* Center Folder Overlay matching Screenshot 3 */}
                      <div className="absolute inset-0 bg-black/30 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                        <div className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white/80 group-hover:scale-110 transition-transform">
                          <Folder className="w-4.5 h-4.5" />
                        </div>
                      </div>

                      {/* Stack count badge at bottom right matching Screenshot 3 (e.g. 📚 10) */}
                      <div className="absolute bottom-2.5 right-2.5 bg-black/80 backdrop-blur-md border border-white/15 px-2 py-0.5 rounded-lg text-[10px] font-bold text-white flex items-center gap-1.5 shadow-md">
                        <Layers className="w-3 h-3 text-white/70" />
                        <span>{editsCount}</span>
                      </div>

                      {/* Bottom Tag overlay matching Screenshot 1 & 2 */}
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-2.5 pt-6 flex items-center justify-between text-white font-mono text-[10px]">
                        <span className="font-semibold truncate max-w-[130px]">{proj.name}</span>
                      </div>
                    </div>

                    {/* Meta info below thumbnail matching Screenshots 1, 2 & 4 */}
                    <div className="mt-2.5 px-0.5">
                      <h3 className="text-xs font-semibold text-white/90 truncate group-hover:text-white transition-colors">
                        {proj.name || proj.youtubeUrl || "Untitled Edit"}
                      </h3>
                      <p className="text-[11px] text-white/40 font-normal mt-0.5">
                        {formatTimeAgo(proj.updatedAt || proj.createdAt)} • {editsCount > 1 ? "AI Clipping" : "Video Edit"}
                      </p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Main Launchpad View
  return (
    <div className="newtab-studio-wrapper w-full min-h-full flex-1 flex flex-col items-center pt-[6vh] overflow-y-auto px-4 pb-20 select-none bg-transparent text-white">
      
      {/* Top Header - 2-Line Display Typography */}
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-[850px] flex flex-col items-center text-center mb-6"
      >
        <h1 className="text-3xl sm:text-5xl font-serif text-white tracking-tight leading-snug mb-1 font-normal">
          What can I edit for
        </h1>
        
        {/* Animated 17 Indian Languages Word "you?" */}
        <div className="h-16 py-1 my-1 flex items-center justify-center overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.span
              key={langIndex}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -14 }}
              transition={{ duration: 0.35, ease: "easeInOut" }}
              className="text-3xl sm:text-5xl font-serif text-white tracking-tight font-normal leading-normal py-0.5"
            >
              {INDIAN_LANGUAGES[langIndex].text}
            </motion.span>
          </AnimatePresence>
        </div>

        <p className="text-white/45 text-xs sm:text-sm max-w-[580px] font-normal tracking-wide mt-2">
          Interact with AI Studio and explore the boundless creative world
        </p>
      </motion.div>

      {/* Signature Animated RGB Gradient Glow Console Box */}
      <motion.div 
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="w-full max-w-[760px] relative mb-6 group"
      >
        <style>{`
          @keyframes studioConsoleGlow {
            0% { background-position: 0% 50%; }
            15% { background-position: 20% 50%; }
            35% { background-position: 80% 50%; }
            50% { background-position: 100% 50%; }
            65% { background-position: 80% 50%; }
            85% { background-position: 20% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>
        
        {/* Outer blurred animated glow shadow */}
        <div
          className="absolute -inset-[5.5px] rounded-[18px] opacity-25 blur-[14px] transition-all duration-500 group-hover:opacity-75 group-focus-within:opacity-100"
          style={{
            background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
            backgroundSize: '300% 300%',
            animation: 'studioConsoleGlow 10s ease-in-out infinite',
          }}
        />

        {/* Outer animated gradient border wrapper */}
        <div className="relative w-full rounded-[18px] p-[1.2px] overflow-hidden bg-zinc-800 shadow-2xl">
          <div
            className="absolute inset-0 opacity-60 group-hover:opacity-90 group-focus-within:opacity-100 transition-opacity duration-500"
            style={{
              background: 'linear-gradient(to right, #ffffff 0%, #ff3b30 14%, #ff9500 28%, #4cd964 42%, #007aff 56%, #af52de 70%, #ff2d55 84%, #ffffff 100%)',
              backgroundSize: '300% 300%',
              animation: 'studioConsoleGlow 10s ease-in-out infinite',
            }}
          />

          {/* Inner Console Box */}
          <div className="relative rounded-[17px] bg-[#161619] p-4 flex flex-col justify-between min-h-[140px]">
            {/* Textarea */}
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
              placeholder="How can I help you today?"
              className="w-full bg-transparent text-white placeholder-white/35 border-none outline-none resize-none py-1 min-h-[60px] max-h-[160px] text-[16px] leading-relaxed"
              rows={2}
            />

            {/* Controls Bar */}
            <div className="flex items-center justify-between pt-2 border-t border-white/5 mt-1">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/5 transition-colors"
                  title="Attach Video or Media"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleStartProject(prompt)}
                  disabled={!prompt.trim() || isSubmitting}
                  className={cn(
                    "w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-300",
                    prompt.trim() && !isSubmitting
                      ? "bg-white hover:bg-white/90 text-black shadow-lg scale-100"
                      : "bg-white/10 text-white/30 cursor-not-allowed scale-95"
                  )}
                >
                  {isSubmitting ? (
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                  ) : (
                    <ArrowUp className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Normal Chips — Grey / Black / White Theme */}
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15 }}
        className="w-full max-w-[760px] flex items-center justify-center gap-3 mb-8"
      >
        {CHIPS.map(chip => {
          const Icon = chip.icon;
          const isActive = activeChip === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => handleChipClick(chip.prompt, chip.id)}
              className={cn(
                "px-4 py-2 rounded-xl text-xs font-medium flex items-center gap-2 transition-all duration-200 border",
                isActive
                  ? "bg-white text-black border-white shadow-lg font-semibold"
                  : "bg-[#18181c] border-white/10 text-white/70 hover:text-white hover:bg-white/10 hover:border-white/25"
              )}
            >
              <Icon className={cn("w-3.5 h-3.5 transition-colors", isActive ? "text-black" : "text-white/50")} />
              <span>{chip.label}</span>
            </button>
          );
        })}
      </motion.div>

      {/* Recent Projects Section (Only shown when real user projects exist in database) */}
      {projects.length > 0 && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="w-full max-w-[760px]"
        >
          {/* Section Header with "See More" Button */}
          <div className="flex items-center justify-between mb-4 px-1">
            <h2 className="text-xs font-semibold text-white/70 flex items-center gap-2 tracking-wider uppercase">
              <FolderOpen className="w-3.5 h-3.5 text-white/50" />
              Recent Projects
            </h2>
            <button
              type="button"
              onClick={() => setShowAllProjects(true)}
              className="text-xs font-medium text-white/70 hover:text-white flex items-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1 rounded-lg transition-all"
            >
              <span>See More</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Strictly Recent 3 User Projects Grid matching Screenshots 1, 2, 3 & 4 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {projects.slice(0, 3).map((proj, idx) => {
              const thumb = getYouTubeThumbnail(proj.youtubeUrl);
              const editsCount = proj.edits?.length || 1;
              return (
                <motion.div
                  key={proj.id || idx}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.08 }}
                  onClick={() => onOpenVideoStudio(proj.id)}
                  className="group relative flex flex-col cursor-pointer"
                >
                  {/* Thumbnail Preview Container matching Screenshots 1, 2, 3 & 4 */}
                  <div className="relative aspect-[16/10] rounded-2xl overflow-hidden bg-[#18181c] border border-white/10 group-hover:border-white/30 transition-all duration-300 shadow-xl flex items-center justify-center">
                    {thumb ? (
                      <img 
                        src={thumb} 
                        alt={proj.name} 
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1c1c22] to-[#121215]">
                        <div className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white/70">
                          <Folder className="w-5 h-5" />
                        </div>
                      </div>
                    )}

                    {/* Center Folder Overlay matching Screenshot 3 */}
                    <div className="absolute inset-0 bg-black/30 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                      <div className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white/80 group-hover:scale-110 transition-transform">
                        <Folder className="w-4.5 h-4.5" />
                      </div>
                    </div>

                    {/* Stack count badge at bottom right matching Screenshot 3 (e.g. 📚 10) */}
                    <div className="absolute bottom-2.5 right-2.5 bg-black/80 backdrop-blur-md border border-white/15 px-2 py-0.5 rounded-lg text-[10px] font-bold text-white flex items-center gap-1.5 shadow-md">
                      <Layers className="w-3 h-3 text-white/70" />
                      <span>{editsCount}</span>
                    </div>

                    {/* Bottom Tag overlay matching Screenshot 1 & 2 */}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-2.5 pt-6 flex items-center justify-between text-white font-mono text-[10px]">
                      <span className="font-semibold truncate max-w-[130px]">{proj.name}</span>
                    </div>
                  </div>

                  {/* Meta info below thumbnail matching Screenshots 1, 2 & 4 */}
                  <div className="mt-2.5 px-0.5">
                    <h3 className="text-xs font-semibold text-white/90 truncate group-hover:text-white transition-colors">
                      {proj.name || proj.youtubeUrl || "Untitled Edit"}
                    </h3>
                    <p className="text-[11px] text-white/40 font-normal mt-0.5">
                      {formatTimeAgo(proj.updatedAt || proj.createdAt)} • {editsCount > 1 ? "AI Clipping" : "Video Edit"}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Bottom "See More" Button matching Screenshot 4 */}
          {projects.length > 3 && (
            <div className="flex justify-center mt-6">
              <button
                type="button"
                onClick={() => setShowAllProjects(true)}
                className="px-6 py-2.5 rounded-xl bg-[#18181c] hover:bg-[#222226] border border-white/10 hover:border-white/25 text-white/80 hover:text-white text-xs font-semibold flex items-center gap-2 transition-all shadow-lg"
              >
                <span>See More ({projects.length})</span>
                <ChevronDown className="w-4 h-4 text-white/50" />
              </button>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
