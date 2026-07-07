import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Captions,
  Check,
  ChevronRight,
  Copy,
  Globe,
  History,
  Info,
  Loader2,
  Plus,
  Sparkles,
  Square,
  Trash2,
  X,
  Youtube,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

type ProfileSummary = {
  id: string;
  name: string;
  channelInput: string;
  channelUrl?: string;
  videoCount: number;
  scrapedAt: number;
  updatedAt: number;
};

type ContentPack = {
  titles: Array<{ title: string; rationale: string }>;
  description: string;
  tagsCsv: string;
  bestUploadTime: { day: string; time: string; timezone: string; rationale: string };
  mustDo: string[];
  channelSignals: string[];
  sources?: Array<{ title: string; url: string }>;
};

type VideoToolStatus = {
  name: "get_video_info" | "get_youtube_captions" | string;
  label: string;
  status: "running" | "done" | "error";
  error?: string;
};

type ContentTurn = {
  id: string;
  topic: string;
  profileId: string;
  profileName: string;
  thoughts: string;
  searches: Array<{ query: string; count: number | null }>;
  videoTools?: VideoToolStatus[];
  summary: string;
  pack: ContentPack | null;
  createdAt: string;
};

type ContentSession = {
  id: string;
  title: string;
  turns: ContentTurn[];
  updatedAt: string;
};

type SseHandlers = {
  onEvent: (event: any) => void;
};

const CONTENT_HISTORY_KEY = "youtube-content-manager-history-v1";

async function streamPost(path: string, body: unknown, handlers: SseHandlers, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  if (!res.body) throw new Error("Streaming response was not available.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const findBoundary = (value: string): { idx: number; sep: number } | null => {
    const lf = value.indexOf("\n\n");
    const crlf = value.indexOf("\r\n\r\n");
    if (lf < 0 && crlf < 0) return null;
    if (crlf < 0) return { idx: lf, sep: 2 };
    if (lf < 0 || crlf < lf) return { idx: crlf, sep: 4 };
    return { idx: lf, sep: 2 };
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = findBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.idx);
      buffer = buffer.slice(boundary.idx + boundary.sep);
      const line = frame.split(/\r?\n/).find((item) => item.startsWith("data:"));
      if (line) {
        try {
          handlers.onEvent(JSON.parse(line.slice(5).replace(/^ /, "")));
        } catch (err) {
          // Only ignore JSON parse errors from malformed keepalive frames.
          // Re-throw anything the onEvent handler intentionally throws (e.g. server error events).
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      boundary = findBoundary(buffer);
    }
  }
}

// The model can leak hidden HTML, comments, or code fences into its prose while
// streaming. Strip them so the summary always reads as clean sentences.
function cleanText(text: string): string {
  return String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function YouTubeContentManager() {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [channelInput, setChannelInput] = useState("");
  const [pendingScrapeId, setPendingScrapeId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [scrapeLog, setScrapeLog] = useState<string[]>([]);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateLog, setGenerateLog] = useState<string[]>([]);
  const [generateThoughts, setGenerateThoughts] = useState("");
  const [searches, setSearches] = useState<Array<{ query: string; count: number | null }>>([]);
  const [videoTools, setVideoTools] = useState<VideoToolStatus[]>([]);
  const [activeTopic, setActiveTopic] = useState("");
  const [summary, setSummary] = useState("");
  const [pack, setPack] = useState<ContentPack | null>(null);
  const [packGenerating, setPackGenerating] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [copied, setCopied] = useState("");
  const [turns, setTurns] = useState<ContentTurn[]>([]);
  const [sessions, setSessions] = useState<ContentSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false);
  const [showChannelsDropdown, setShowChannelsDropdown] = useState(false);
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [packProfileName, setPackProfileName] = useState("");
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyDropdownRef = useRef<HTMLDivElement | null>(null);
  const channelsButtonRef = useRef<HTMLButtonElement | null>(null);
  const channelsDropdownRef = useRef<HTMLDivElement | null>(null);
  const mentionMenuRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const liveThoughtsRef = useRef("");
  const liveSummaryRef = useRef("");
  const liveSearchesRef = useRef<Array<{ query: string; count: number | null }>>([]);
  const liveVideoToolsRef = useRef<VideoToolStatus[]>([]);

  const selected = useMemo(
    () => profiles.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  const refreshProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      const res = await fetch(`${BASE}/api/content-manager/profiles`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Could not load channels");
      const rows: ProfileSummary[] = Array.isArray(data?.profiles) ? data.profiles : [];
      setProfiles(rows);
      setSelectedId((current) => current || "");
    } catch (err: any) {
      toast({ title: "Could not load channels", description: err?.message, variant: "destructive" });
    } finally {
      setProfilesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refreshProfiles();
  }, [refreshProfiles]);

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONTENT_HISTORY_KEY) || "[]");
      if (Array.isArray(parsed)) setSessions(parsed);
    } catch {
      // Ignore malformed local history.
    }
  }, []);

  const saveSessions = useCallback((next: ContentSession[]) => {
    setSessions(next);
    try {
      localStorage.setItem(CONTENT_HISTORY_KEY, JSON.stringify(next));
    } catch {
      // Local history is optional.
    }
  }, []);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (
        showHistoryDropdown &&
        historyDropdownRef.current &&
        !historyDropdownRef.current.contains(event.target as Node) &&
        historyButtonRef.current &&
        !historyButtonRef.current.contains(event.target as Node)
      ) {
        setShowHistoryDropdown(false);
      }
      if (
        showChannelsDropdown &&
        channelsDropdownRef.current &&
        !channelsDropdownRef.current.contains(event.target as Node) &&
        channelsButtonRef.current &&
        !channelsButtonRef.current.contains(event.target as Node)
      ) {
        setShowChannelsDropdown(false);
      }
      if (
        showMentionMenu &&
        mentionMenuRef.current &&
        !mentionMenuRef.current.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setShowMentionMenu(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showHistoryDropdown, showChannelsDropdown, showMentionMenu]);

  const startScrape = async () => {
    const cleanInput = channelInput.trim() || selected?.channelInput || "";
    if (!cleanInput) {
      toast({ title: "Add a channel URL or handle first", variant: "destructive" });
      return;
    }
    setConfirmOpen(false);
    setScraping(true);
    setPack(null);
    setScrapeLog(["Starting channel scan..."]);
    try {
      await streamPost("/api/content-manager/channels/scrape", {
        channelInput: cleanInput,
        profileId: pendingScrapeId || selectedId || undefined,
      }, {
        onEvent: (event) => {
          if (event.type === "status" && event.message) {
            setScrapeLog((items) => [...items.slice(-10), String(event.message)]);
          }
          if (event.type === "profile") {
            setSelectedId(String(event.profileId));
          }
          if (event.type === "error") throw new Error(event.message || "Channel scan failed");
        },
      });
      await refreshProfiles();
      setChannelInput("");
      setScrapeLog([]);
      toast({ title: "Channel data saved", description: "Recent public videos are ready for planning." });
    } catch (err: any) {
      toast({ title: "Channel scan failed", description: err?.message, variant: "destructive" });
      setScrapeLog((items) => [...items, err?.message || "Channel scan failed"]);
    } finally {
      setScraping(false);
      setPendingScrapeId(null);
    }
  };

  const abortControllerRef = useRef<AbortController | null>(null);

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setGenerating(false);
      setPackGenerating(false);
      if (!summary.trim() && !generateThoughts.trim() && !pack) {
        setActiveTopic("");
      }
    }
  };

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const makeTurn = useCallback((overridePack?: ContentPack | null): ContentTurn | null => {
    if (!activeTopic.trim()) return null;
    return {
      id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      topic: activeTopic,
      profileId: selectedId,
      profileName: selected?.name ?? "Selected channel",
      thoughts: generateThoughts,
      searches,
      videoTools,
      summary,
      pack: overridePack === undefined ? pack : overridePack,
      createdAt: new Date().toISOString(),
    };
  }, [activeTopic, generateThoughts, pack, searches, selected?.name, selectedId, summary, videoTools]);

  const persistSession = useCallback((nextTurns: ContentTurn[]) => {
    if (nextTurns.length === 0) return;
    const now = new Date().toISOString();
    const title = nextTurns[0].topic.slice(0, 58) || "Content Manager chat";
    if (currentSessionId) {
      const updated = sessions.map((session) => session.id === currentSessionId
        ? { ...session, title, turns: nextTurns, updatedAt: now }
        : session);
      saveSessions(updated.some((session) => session.id === currentSessionId)
        ? updated
        : [{ id: currentSessionId, title, turns: nextTurns, updatedAt: now }, ...sessions]);
      return;
    }
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setCurrentSessionId(id);
    saveSessions([{ id, title, turns: nextTurns, updatedAt: now }, ...sessions]);
  }, [currentSessionId, saveSessions, sessions]);

  const startNewChat = () => {
    setTurns([]);
    setCurrentSessionId(null);
    setActiveTopic("");
    setSummary("");
    setPack(null);
    setPackGenerating(false);
    setPackOpen(false);
    setGenerateThoughts("");
    setGenerateLog([]);
    setSearches([]);
    setVideoTools([]);
    setScrapeLog([]);
    setTopic("");
    setPackProfileName("");
    setShowChannelsDropdown(false);
    setShowHistoryDropdown(false);
  };

  const selectSession = (session: ContentSession) => {
    stopGeneration();
    setTurns(session.turns);
    setCurrentSessionId(session.id);
    setShowHistoryDropdown(false);
    setActiveTopic("");
    setSummary("");
    setPack(null);
    setPackGenerating(false);
    setPackOpen(false);
    setGenerateThoughts("");
    setGenerateLog([]);
    setSearches([]);
    setVideoTools([]);
    const last = session.turns[session.turns.length - 1];
    if (last?.profileId) setSelectedId(last.profileId);
  };

  const deleteSession = (sessionId: string, event: any) => {
    event.stopPropagation();
    const next = sessions.filter((session) => session.id !== sessionId);
    saveSessions(next);
    if (currentSessionId === sessionId) startNewChat();
  };

  const generate = async () => {
    if (generating) return;
    if (!selectedId) {
      toast({
        title: "No channel selected",
        description: "Select a channel by typing @ in the chatbox (e.g., @test_channel followed by your query).",
        variant: "destructive",
      });
      return;
    }
    if (!topic.trim()) {
      toast({
        title: "Write the video topic first",
        description: "Type @ followed by your channel name, then write your topic request (e.g., @test_channel suggest 5 video titles for today).",
        variant: "destructive",
      });
      return;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;

    const cleanTopic = topic.trim();
    const previousTurn = makeTurn();
    const baseTurns = previousTurn ? [...turns, previousTurn] : turns;
    setTurns(baseTurns);
    setGenerating(true);
    setPack(null);
    setPackGenerating(false);
    setPackOpen(false);
    setActiveTopic(cleanTopic);
    setTopic("");
    setGenerateThoughts("");
    liveThoughtsRef.current = "";
    liveSummaryRef.current = "";
    liveSearchesRef.current = [];
    liveVideoToolsRef.current = [];
    setSummary("");
    setSearches([]);
    setVideoTools([]);
    setGenerateLog([]);
    try {
      await streamPost("/api/content-manager/generate", {
        profileId: selectedId,
        topic: cleanTopic,
      }, {
        onEvent: (event) => {
          if (event.type === "status" && event.message) {
            setGenerateLog((items) => [...items.slice(-8), String(event.message)]);
          }
          if (event.type === "thought_delta" && event.content) {
            const next = liveThoughtsRef.current + String(event.content);
            liveThoughtsRef.current = next;
            setGenerateThoughts(next);
          }
          if (event.type === "summary_delta" && event.content) {
            const next = liveSummaryRef.current + String(event.content);
            liveSummaryRef.current = next;
            setSummary(next);
          }
          if (event.type === "pack_start") {
            setPackGenerating(true);
          }
          if (event.type === "search_start" && event.query) {
            const next = [...liveSearchesRef.current, { query: String(event.query), count: null }];
            liveSearchesRef.current = next;
            setSearches(next);
          }
          if (event.type === "search_done" && event.query) {
            const next = liveSearchesRef.current.map((item) =>
              item.query === String(event.query) && item.count === null
                ? { ...item, count: Number(event.count ?? 0) }
                : item,
            );
            liveSearchesRef.current = next;
            setSearches(next);
          }
          if (event.type === "video_tool_start" && event.name) {
            const nextTool: VideoToolStatus = {
              name: String(event.name),
              label: String(event.label || event.name),
              status: "running",
            };
            const others = liveVideoToolsRef.current.filter((item) => item.name !== nextTool.name);
            const next = [...others, nextTool];
            liveVideoToolsRef.current = next;
            setVideoTools(next);
          }
          if (event.type === "video_tool_done" && event.name) {
            const name = String(event.name);
            const next = liveVideoToolsRef.current.map((item) =>
              item.name === name
                ? {
                    ...item,
                    label: String(event.label || item.label),
                    status: event.error ? "error" as const : "done" as const,
                    error: event.error ? String(event.error) : undefined,
                  }
                : item,
            );
            liveVideoToolsRef.current = next;
            setVideoTools(next);
          }
          if (event.type === "result") {
            setPackGenerating(false);
            const nextPack = event.pack || null;
            if (nextPack) {
              setPack(nextPack);
              setPackProfileName(selected?.name ?? "");
            }
            if (typeof event.summary === "string" && event.summary.trim()) setSummary(event.summary.trim());
            const completed: ContentTurn = {
              id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
              topic: cleanTopic,
              profileId: selectedId,
              profileName: selected?.name ?? "Selected channel",
              thoughts: liveThoughtsRef.current,
              searches: liveSearchesRef.current,
              videoTools: liveVideoToolsRef.current,
              summary: typeof event.summary === "string" && event.summary.trim() ? event.summary.trim() : liveSummaryRef.current,
              pack: nextPack,
              createdAt: new Date().toISOString(),
            };
            persistSession([...baseTurns, completed]);
          }
          if (event.type === "error") throw new Error(event.message || "Generation failed");
        },
      }, ctrl.signal);
    } catch (err: any) {
      if (err?.name === "AbortError" || err?.message?.includes("aborted")) {
        // Ignored
        return;
      }
      toast({ title: "Generation failed", description: err?.message, variant: "destructive" });
      setGenerateLog((items) => [...items, err?.message || "Generation failed"]);
    } finally {
      if (abortControllerRef.current === ctrl) {
        abortControllerRef.current = null;
        setGenerating(false);
        setPackGenerating(false);
      }
    }
  };

  const removeProfile = async (id: string) => {
    try {
      const res = await fetch(`${BASE}/api/content-manager/profiles/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Delete failed");
      setProfiles((prev) => {
        const next = prev.filter((p) => p.id !== id);
        if (selectedId === id) {
          setSelectedId("");
        }
        return next;
      });
      toast({ title: "Channel deleted" });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err?.message, variant: "destructive" });
    }
  };

  const copyTimerRef = useRef<NodeJS.Timeout | null>(null);
  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(""), 1400);
    } catch {
      toast({ title: "Could not copy to clipboard", variant: "destructive" });
    }
  };

  const fullPackText = pack ? [
    "Titles:",
    ...pack.titles.map((item, index) => `${index + 1}. ${item.title}`),
    "",
    "Description:",
    pack.description,
    "",
    "Tags:",
    pack.tagsCsv,
    "",
    "Best upload time:",
    `${pack.bestUploadTime.day} ${pack.bestUploadTime.time} ${pack.bestUploadTime.timezone} - ${pack.bestUploadTime.rationale}`,
    "",
    "Must do:",
    ...pack.mustDo.map((item) => `- ${item}`),
    ...(pack.sources && pack.sources.length > 0
      ? ["", "Sources:", ...pack.sources.map((s) => `- ${s.title}: ${s.url}`)]
      : []),
  ].join("\n") : "";

  const handleTopicChange = (val: string) => {
    setTopic(val);
    const lastWord = val.split(/\s+/).pop() || "";
    if (lastWord.startsWith("@")) {
      setShowMentionMenu(true);
    } else {
      setShowMentionMenu(false);
    }
  };

  const selectMentionChannel = (profile: ProfileSummary) => {
    setSelectedId(profile.id);
    const handle = profile.channelInput || profile.name;
    setTopic((prev) => {
      const words = prev.split(/\s+/);
      if (words.length > 0 && words[words.length - 1].startsWith("@")) {
        words.pop();
      }
      return [...words, handle].join(" ").trim() + " ";
    });
    setShowMentionMenu(false);
  };

  return (
    <div className="ytcm-page ytcm-chat-shell">
      <header className="ytcm-chat-topbar">
        <div className="ytcm-chat-actions">
          <div className="ytcm-history-wrap" style={{ position: "relative" }}>
            <button
              type="button"
              className="ytcm-top-icon-btn"
              onClick={startNewChat}
              title="New chat"
              aria-label="New chat"
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>
          <div className="ytcm-history-wrap">
            <button
              ref={historyButtonRef}
              type="button"
              className={cn("ytcm-top-icon-btn", showHistoryDropdown && "is-active")}
              onClick={() => setShowHistoryDropdown((v) => !v)}
              title="Chat history"
              aria-label="Chat history"
            >
              <History className="w-5 h-5" />
            </button>
            {showHistoryDropdown ? (
              <div ref={historyDropdownRef} className="ytcm-history-menu">
                <div className="ytcm-history-head">
                  <span>History</span>
                  {sessions.length > 0 ? (
                    <button type="button" onClick={() => { saveSessions([]); startNewChat(); }}>
                      <Trash2 className="w-3 h-3" />
                      Clear All
                    </button>
                  ) : null}
                </div>
                <div className="ytcm-history-list">
                  {sessions.length === 0 ? (
                    <p className="ytcm-history-empty">
                      <History className="w-5 h-5" />
                      <span>No sessions yet</span>
                    </p>
                  ) : null}
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={cn("ytcm-history-item", currentSessionId === session.id && "is-active")}
                      onClick={() => selectSession(session)}
                    >
                      <span>{session.title}</span>
                      <i onClick={(e) => deleteSession(session.id, e)}><X className="w-3 h-3" /></i>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <div className="ytcm-channel-wrap">
            <button
              ref={channelsButtonRef}
              type="button"
              className={cn("ytcm-channel-pill", showChannelsDropdown && "is-active")}
              onClick={() => setShowChannelsDropdown((v) => !v)}
              title="Available channels"
            >
              <Youtube className="w-3.5 h-3.5" />
              <span>{profiles.length} channel{profiles.length !== 1 ? "s" : ""}</span>
            </button>
            {showChannelsDropdown ? (
              <div ref={channelsDropdownRef} className="ytcm-channel-menu">
                <div className="ytcm-mention-head">
                  {profilesLoading ? "Loading..." : "Available channels"}
                </div>
                {profiles.length === 0 ? (
                  <p className="ytcm-history-empty">
                    <Youtube className="w-5 h-5" />
                    <span>No channels yet</span>
                  </p>
                ) : profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className={cn("ytcm-mention-item", selectedId === profile.id && "is-active")}
                    onClick={() => { setSelectedId(profile.id); setShowChannelsDropdown(false); }}
                  >
                    <Youtube className="w-3.5 h-3.5" />
                    <span>{profile.name || profile.channelInput}</span>
                    <em>{profile.videoCount} videos</em>
                  </button>
                ))}
                <button
                  type="button"
                  className="ytcm-mention-item ytcm-add-channel-item"
                  onClick={() => {
                    setPendingScrapeId(null);
                    setChannelInput("");
                    setShowChannelsDropdown(false);
                    setConfirmOpen(true);
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add channel</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="ytcm-chat-main">
        {turns.map((turn) => (
          <CompletedTurn
            key={turn.id}
            turn={turn}
            onOpenPack={() => {
              if (turn.pack) {
                setPack(turn.pack);
                setPackProfileName(turn.profileName);
                setPackOpen(true);
              }
            }}
          />
        ))}

        {!pack && turns.length === 0 && !activeTopic && scrapeLog.length === 0 && generateLog.length === 0 ? (
          <section className="ytcm-chat-welcome">
            <h1>Content Manager</h1>
            <p>Ask for the next YouTube upload idea, title pack, SEO description, tags, upload time, and must-do steps.</p>
            <div className="ytcm-starters">
              {[
                "Give best title for Delhi clashes and border tension",
                "Make next upload SEO pack from my channel style",
                "Find a punchy news angle for today",
                "Suggest 5 titles like my best videos",
              ].map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => {
                    setTopic(starter);
                    if (!selectedId && profiles.length === 1) setSelectedId(profiles[0].id);
                    else if (!selectedId && profiles.length > 1) setShowChannelsDropdown(true);
                    else if (profiles.length === 0) setConfirmOpen(true);
                  }}
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{starter}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {(generating || generateThoughts.trim() || generateLog.length > 0 || pack || summary) && activeTopic ? (
          <section className="ytcm-user-message">
            <div className="ytcm-user-bubble">{activeTopic}</div>
          </section>
        ) : null}

        {(scraping || scrapeLog.length > 0) ? (
          <ToolStatusBlock
            title="Scanning channel"
            thoughtText={scrapeLog.join("\n")}
            busy={scraping}
          />
        ) : null}

        {(generating || generateThoughts.trim() || generateLog.length > 0) ? (
          <ThoughtStatusBlock
            title="Thinking"
            thoughtText={generateThoughts}
            busy={generating}
          >
            {(searches.length > 0 || videoTools.length > 0 || (!generateThoughts.trim() && generateLog.length > 0)) ? (
              <div>
                <VideoToolChips tools={videoTools} />
                {searches.length > 0 ? (
                  <div className="ytcm-search-chips">
                    {searches.map((item, index) => (
                      <span key={`${item.query}-${index}`} className="ytcm-search-chip">
                        {item.count === null ? <Loader2 className="w-3 h-3 animate-spin" /> : <Globe className="w-3 h-3" />}
                        <span>{item.query}</span>
                        {item.count !== null ? <em>{item.count} sources</em> : null}
                      </span>
                    ))}
                  </div>
                ) : null}
                {!generateThoughts.trim() && generateLog.length > 0 ? (
                  <div style={{ marginTop: searches.length > 0 || videoTools.length > 0 ? 6 : 0, fontSize: "0.78rem", opacity: 0.55, lineHeight: 1.6 }}>
                    {generateLog.map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </ThoughtStatusBlock>
        ) : null}

        {(pack || packGenerating || summary) ? (
          <section className="ytcm-assistant-message">
            <div className="ytcm-assistant-avatar"><Sparkles className="w-4 h-4" /></div>
            <div className="ytcm-assistant-body">
              {cleanText(summary) ? <p className="ytcm-summary">{cleanText(summary)}</p> : null}

              {!pack && packGenerating ? (
                <div className="ytcm-pack-card is-generating">
                  <span className="ytcm-pack-title">
                    <span className="ytcm-pack-badge"><Youtube className="w-4 h-4" /></span>
                    <span className="ytcm-pack-title-text">
                      Creating content pack…
                      <em>Structuring titles, SEO description, tags &amp; upload time</em>
                    </span>
                  </span>
                  <Loader2 className="w-[18px] h-[18px] animate-spin ytcm-pack-spin" />
                  <div className="ytcm-pack-shimmer" aria-hidden="true" />
                </div>
              ) : null}

              {pack ? (
                <button type="button" className="ytcm-pack-card is-ready" onClick={() => setPackOpen(true)}>
                  <span className="ytcm-pack-title">
                    <span className="ytcm-pack-badge"><Youtube className="w-4 h-4" /></span>
                    <span className="ytcm-pack-title-text">
                      Content pack
                      <em>{pack.titles.length} titles · description · tags · upload time</em>
                    </span>
                  </span>
                  <span className="ytcm-pack-open-hint">
                    Open <ChevronRight className="w-4 h-4" />
                  </span>
                </button>
              ) : null}
            </div>
          </section>
        ) : null}
      </main>

      <footer className="ytcm-chat-composer">
        {showMentionMenu ? (
          <div ref={mentionMenuRef} className="ytcm-mention-menu">
            <div className="ytcm-mention-head">Select channel</div>
            {profiles.length === 0 ? (
              <button
                type="button"
                className="ytcm-mention-item"
                onClick={() => { setShowMentionMenu(false); setConfirmOpen(true); }}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>No channels yet — add one</span>
              </button>
            ) : profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={cn("ytcm-mention-item", selectedId === profile.id && "is-active")}
                onClick={() => selectMentionChannel(profile)}
              >
                <Youtube className="w-3.5 h-3.5" />
                <span>{profile.name || profile.channelInput}</span>
                <em>{profile.videoCount} videos</em>
              </button>
            ))}
          </div>
        ) : null}

        <form
          className="ytcm-input-card"
          onSubmit={(event) => {
            event.preventDefault();
            if (generating) return;
            void generate();
          }}
        >
          <textarea
            ref={textareaRef}
            value={topic}
            onChange={(event) => handleTopicChange(event.target.value)}
            placeholder="Ask for next upload idea, or type @channel name..."
            rows={1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (generating) return;
                void generate();
              }
            }}
          />
          <button
            type={generating ? "button" : "submit"}
            className={generating ? "ytcm-stop-btn" : ""}
            onClick={
              generating
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stopGeneration();
                  }
                : undefined
            }
            disabled={!generating && (!selectedId || !topic.trim() || scraping)}
            title={generating ? "Stop generation" : "Send"}
          >
            {generating ? (
              <Square className="w-4 h-4 fill-white" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
          </button>
        </form>
      </footer>

      {confirmOpen ? (
        <div className="ytcm-modal-backdrop" onClick={() => setConfirmOpen(false)}>
          <div className="ytcm-modal" onClick={(event) => event.stopPropagation()}>
            <div className="ytcm-modal-icon"><Youtube className="w-5 h-5" /></div>
            <h2>{pendingScrapeId ? "Refresh channel memory?" : "Add a channel"}</h2>
            <p>
              This runs a one-time scan of recent public channel metadata and saves about 50 video titles,
              all available tags and public stats, plus full descriptions for only the newest 5-8 videos.
            </p>
            <input
              className="ytcm-modal-input"
              value={channelInput}
              onChange={(event) => setChannelInput(event.target.value)}
              placeholder="@channel or YouTube channel URL"
              autoFocus
              onKeyDown={(event) => { if (event.key === "Enter" && channelInput.trim()) void startScrape(); }}
            />
            <div className="ytcm-modal-actions">
              <button type="button" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button type="button" disabled={!channelInput.trim() || scraping} onClick={() => void startScrape()}>
                {scraping ? "Scanning…" : pendingScrapeId ? "Refresh" : "Add channel"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {packOpen && pack ? (
        <div className="ytcm-pack-modal-backdrop" onClick={() => setPackOpen(false)}>
          <div className="ytcm-pack-modal" onClick={(event) => event.stopPropagation()}>
            <header className="ytcm-pack-modal-head">
              <span className="ytcm-pack-title">
                <span className="ytcm-pack-badge"><Youtube className="w-4 h-4" /></span>
                <span className="ytcm-pack-title-text">
                  Content pack
                  <em>{packProfileName || (selected ? selected.name : "Ready to publish")}</em>
                </span>
              </span>
              <div className="ytcm-pack-modal-actions">
                <button type="button" className="ytcm-pack-copy" onClick={() => void copy("full", fullPackText)}>
                  {copied === "full" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  Copy all
                </button>
                <button type="button" className="ytcm-pack-close" title="Close" onClick={() => setPackOpen(false)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </header>
            <div className="ytcm-pack-modal-body">
              <ResultBlock title="Best 5 titles" onCopy={() => void copy("titles", pack.titles.map((item, index) => `${index + 1}. ${item.title}`).join("\n"))} copied={copied === "titles"}>
                <div className="ytcm-title-list">
                  {pack.titles.map((item, index) => (
                    <div key={`${item.title}-${index}`} className="ytcm-title-item">
                      <span>{index + 1}</span>
                      <div>
                        <h3>{item.title}</h3>
                        <p>{item.rationale}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </ResultBlock>
              <ResultBlock title="SEO description" onCopy={() => void copy("description", pack.description)} copied={copied === "description"}>
                <p className="ytcm-preline">{pack.description}</p>
              </ResultBlock>
              <ResultBlock title="Tags" onCopy={() => void copy("tags", pack.tagsCsv)} copied={copied === "tags"}>
                <p className="ytcm-tags">{pack.tagsCsv}</p>
              </ResultBlock>
              <ResultBlock title="Best upload time">
                <h3 className="ytcm-time">{pack.bestUploadTime.day} - {pack.bestUploadTime.time} {pack.bestUploadTime.timezone}</h3>
                <p>{pack.bestUploadTime.rationale}</p>
              </ResultBlock>
              <ResultBlock title="Must do">
                <ul className="ytcm-bullets">{pack.mustDo.map((item) => <li key={item}>{item}</li>)}</ul>
              </ResultBlock>
              {pack.sources && pack.sources.length > 0 ? (
                <ResultBlock title="Sources">
                  <ul className="ytcm-sources">
                    {pack.sources.map((source) => (
                      <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>
                    ))}
                  </ul>
                </ResultBlock>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ThoughtStatusBlock({
  title,
  thoughtText,
  busy,
  children,
}: {
  title: string;
  thoughtText?: string;
  busy: boolean;
  children?: ReactNode;
}) {
  const [showThoughts, setShowThoughts] = useState(true);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const cleanThoughtText = String(thoughtText ?? "").trim();
  const hasThoughts = cleanThoughtText.length > 0;
  const expandable = hasThoughts || Boolean(children);
  const thinkingLabel = hasThoughts && !busy ? "Thought for a second" : title;

  useEffect(() => {
    if (busy && showThoughts && innerRef.current) {
      innerRef.current.scrollTop = innerRef.current.scrollHeight;
    }
  }, [cleanThoughtText, busy, showThoughts]);

  return (
    <section className="gs-thinking-block ytcm-copilot-thinking">
      <button
        type="button"
        className={cn("gs-thinking-header", expandable && "gs-thinking-header-clickable")}
        onClick={() => expandable && setShowThoughts((value) => !value)}
        disabled={!expandable}
        aria-expanded={expandable ? showThoughts : undefined}
        aria-live={busy ? "polite" : "off"}
      >
        <span className="gs-thinking-text">{thinkingLabel}</span>
        {busy && !hasThoughts ? (
          <span className="gs-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
        ) : null}
        {expandable ? (
          <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", showThoughts && "rotate-90")} />
        ) : null}
      </button>
      {showThoughts && expandable ? (
        <div className="gs-thinking-content">
          <div ref={innerRef} className="gs-thinking-content-inner">
            {cleanThoughtText}
            {children}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function VideoToolChips({ tools }: { tools: VideoToolStatus[] }) {
  if (!tools.length) return null;
  return (
    <div className="ytcm-search-chips ytcm-video-tool-chips">
      {tools.map((tool) => {
        const Icon = tool.name === "get_youtube_captions" ? Captions : Info;
        return (
          <span
            key={tool.name}
            className={cn("ytcm-search-chip ytcm-video-tool-chip", tool.status === "error" && "is-error")}
            title={tool.error || tool.label}
          >
            {tool.status === "running" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
            <span>{tool.label}</span>
            <em>{tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "done"}</em>
          </span>
        );
      })}
    </div>
  );
}

function CompletedTurn({
  turn,
  onOpenPack,
}: {
  turn: ContentTurn;
  onOpenPack: () => void;
}) {
  return (
    <>
      <section className="ytcm-user-message">
        <div className="ytcm-user-bubble">{turn.topic}</div>
      </section>
      {turn.thoughts.trim() || turn.searches.length > 0 || (turn.videoTools?.length ?? 0) > 0 ? (
        <ThoughtStatusBlock
          title="Thought for a second"
          thoughtText={turn.thoughts}
          busy={false}
        >
          <VideoToolChips tools={turn.videoTools ?? []} />
          {turn.searches.length > 0 ? (
            <div className="ytcm-search-chips">
              {turn.searches.map((item, index) => (
                <span key={`${turn.id}-${item.query}-${index}`} className="ytcm-search-chip">
                  <Globe className="w-3 h-3" />
                  <span>{item.query}</span>
                  {item.count !== null ? <em>{item.count} sources</em> : null}
                </span>
              ))}
            </div>
          ) : null}
        </ThoughtStatusBlock>
      ) : null}
      {(turn.summary || turn.pack) ? (
        <section className="ytcm-assistant-message">
          <div className="ytcm-assistant-avatar"><Sparkles className="w-4 h-4" /></div>
          <div className="ytcm-assistant-body">
            {cleanText(turn.summary) ? <p className="ytcm-summary">{cleanText(turn.summary)}</p> : null}
            {turn.pack ? (
              <button type="button" className="ytcm-pack-card is-ready" onClick={onOpenPack}>
                <span className="ytcm-pack-title">
                  <span className="ytcm-pack-badge"><Youtube className="w-4 h-4" /></span>
                  <span className="ytcm-pack-title-text">
                    Content pack
                    <em>{turn.profileName} · {turn.pack.titles.length} titles</em>
                  </span>
                </span>
                <span className="ytcm-pack-open-hint">
                  Open <ChevronRight className="w-4 h-4" />
                </span>
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

function ToolStatusBlock({
  title,
  thoughtText,
  busy,
}: {
  title: string;
  thoughtText?: string;
  busy: boolean;
}) {
  const cleanText = String(thoughtText ?? "").trim();
  const lines = cleanText.split("\n").map((line) => line.trim()).filter(Boolean);

  return (
    <section className="gs-thinking-block ytcm-copilot-thinking ytcm-tool-status">
      <div className="gs-thinking-header">
        <span className="gs-thinking-text">{busy ? title : "Channel scan complete"}</span>
        {busy ? (
          <span className="gs-thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
        ) : null}
      </div>
      {lines.length > 0 ? (
        <div className="gs-thinking-content">
          <div className="gs-thinking-content-inner">
            {lines.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ResultBlock({
  title,
  children,
  onCopy,
  copied,
}: {
  title: string;
  children: ReactNode;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <section className="ytcm-result">
      <div className="ytcm-result-head">
        <h2>{title}</h2>
        {onCopy ? (
          <button type="button" onClick={onCopy}>
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export default YouTubeContentManager;
