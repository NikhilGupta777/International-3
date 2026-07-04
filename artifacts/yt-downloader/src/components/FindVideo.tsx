import React, { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Plus, History, Trash2, Loader2, Play,
  Send, Check, Copy, ExternalLink,
  Database, Video, FileText, Bot, Square, ChevronDown, ChevronRight
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  thoughts?: string;
  thinkingTrace?: Array<{ name: string; message: string; result?: string }>;
  isStreaming?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
}

interface DatabaseStats {
  total_qa_items: number;
  total_unique_videos: number;
  total_words: number;
  total_characters: number;
  date_range: { start: string; end: string };
}

const HISTORY_KEY = "malika-search-history-v2";
const MAX_SESSIONS = 50;

const SUGGESTIONS_DATA = [
  { title: "Floods in the USA", desc: "Find all predictions about massive floods and cataclysms in America.", query: "give me all videos where said about usa will get very big flood" },
  { title: "Missile Strike Areas", desc: "Check which areas of India are predicted to be hit first by missiles.", query: "missiles in which area first in india" },
  { title: "Delhi Predictions", desc: "Search for earthquakes and natural disaster predictions for India's capital.", query: "what will happen to Delhi during the world war?" },
  { title: "China-India Conflict", desc: "What does Bhavishya Malika predict about China attacking India?", query: "china attack india Ladakh conflict" },
  { title: "Signs of Satyug", desc: "Explore prophecies regarding the transition from Kalyug to Satyug.", query: "what are the signs of Satyug?" },
  { title: "Jagannath Temple Signs", desc: "Prophecies about the Puri Temple flag falling or stones dropping.", query: "jagannath temple sign prophecies" },
  { title: "World War 3 Timeline", desc: "When will the third world war start and what will trigger it?", query: "when will the third world war start?" },
  { title: "Kalki Avatar Prophecy", desc: "Learn about the birth and arrival predictions of Lord Kalki.", query: "prophecies about kalki avatar arrival" },
  { title: "Mumbai Submersion", desc: "Will Mumbai sink under the sea? Search sea-level predictions.", query: "mumbai submerge under sea" },
  { title: "Sun Darkness", desc: "Prophecies about solar eclipses and the sun being blocked for 7 days.", query: "sun dark for seven days" },
  { title: "Future King of India", desc: "Who will rule India during the final stages of the transition?", query: "future prime minister or ruler of india" },
  { title: "Operation Sindoor", desc: "Prophecies about Pakistan's fate and border operations.", query: "operation sindoor predictions" },
  { title: "UK & England Sinking", desc: "Prophecies about the British Isles sinking under the ocean.", query: "england sinking under ocean" },
  { title: "Meteors and Comets", desc: "Check predictions about space rocks colliding with Earth.", query: "meteor comet collision earth" },
  { title: "Famine and Drought", desc: "Prophecies regarding global crop failures and food shortages.", query: "famine and food shortage" },
  { title: "Odisha Catastrophes", desc: "What predictions are made for Puri and the state of Odisha?", query: "odisha Puri flood cyclone predictions" },
  { title: "Russia-Ukraine Role", desc: "Prophecies about Russia's role in the global world conflict.", query: "russia ukraine war role" },
  { title: "Destruction of Pakistan", desc: "What predictions detail the collapse or division of Pakistan?", query: "pakistan destruction collapse" },
  { title: "Kalyug End Year", desc: "Prophecies detailing the exact years and calculations for the end of Kalyug.", query: "kalyug end calculations" }
];

function sanitizeMessage(message: Message): Message {
  return { ...message, thoughts: typeof message.thoughts === "string" ? message.thoughts : "" };
}

function sanitizeSession(session: ChatSession): ChatSession {
  return {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages.map(sanitizeMessage) : []
  };
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15);
}

export function FindVideo() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [thinkingText, setThinkingText] = useState("");
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [collapsedThoughts, setCollapsedThoughts] = useState<Record<number, boolean>>({});
  const [suggestionIndex, setSuggestionIndex] = useState(0);

  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUpRef = useRef(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Always-current sessions ref to avoid stale closures in async callbacks
  const sessionsRef = useRef<ChatSession[]>([]);
  const currentSessionIdRef = useRef<string | null>(null);

  // Keep refs in sync with state
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { currentSessionIdRef.current = currentSessionId; }, [currentSessionId]);

  // Suggestions rotation interval
  useEffect(() => {
    const interval = setInterval(() => {
      setSuggestionIndex(prev => (prev + 4) % SUGGESTIONS_DATA.length);
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  const getVisibleSuggestions = () => {
    const list = [];
    for (let i = 0; i < 4; i++) {
      const idx = (suggestionIndex + i) % SUGGESTIONS_DATA.length;
      list.push(SUGGESTIONS_DATA[idx]);
    }
    return list;
  };

  const fetchStats = async () => {
    try {
      const response = await fetch("/api/notebook/health");
      if (response.ok) {
        const data = await response.json();
        if (data.stats) {
          setStats(data.stats);
        }
      }
    } catch (err) {
      console.error("Failed to load search stats:", err);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setSessions(parsed.map(sanitizeSession));
        }
      }
    } catch (err) {
      console.error("Failed to load history sessions:", err);
    }
  }, []);

  const saveSessions = (updated: ChatSession[]) => {
    // Cap at MAX_SESSIONS to prevent unbounded localStorage growth
    const capped = updated.slice(0, MAX_SESSIONS);
    setSessions(capped);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(capped));
    } catch (err) {
      console.error("Failed to save history sessions:", err);
    }
  };

  const scrollToBottom = useCallback((force = false) => {
    const el = messagesAreaRef.current;
    if (!el) return;
    if (force || !userHasScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const handleScroll = () => {
    const el = messagesAreaRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
    userHasScrolledUpRef.current = !atBottom;
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        showHistoryDropdown &&
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        historyButtonRef.current &&
        !historyButtonRef.current.contains(e.target as Node)
      ) {
        setShowHistoryDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [showHistoryDropdown]);

  const handleNewChat = () => {
    setMessages([]);
    setCurrentSessionId(null);
    userHasScrolledUpRef.current = false;
  };

  const handleSelectSession = (session: ChatSession) => {
    setMessages(session.messages.map(sanitizeMessage));
    setCurrentSessionId(session.id);
    setShowHistoryDropdown(false);
    userHasScrolledUpRef.current = false;

    setTimeout(() => scrollToBottom(true), 50);
  };

  const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = sessionsRef.current.filter(s => s.id !== sessionId);
    saveSessions(updated);
    if (currentSessionIdRef.current === sessionId) {
      handleNewChat();
    }
  };

  const handleClearAllHistory = () => {
    if (window.confirm("Are you sure you want to clear all search history?")) {
      saveSessions([]);
      handleNewChat();
      setShowHistoryDropdown(false);
    }
  };

  const toggleThoughts = (index: number) => {
    setCollapsedThoughts(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  const stopSearch = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setStreaming(false);
    setMessages(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m));
  };

  const copyToClipboard = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  };

  const handleSearch = async (queryText: string) => {
    if (!queryText.trim() || streaming) return;
    setInput("");

    const userMsg: Message = {
      role: "user",
      content: queryText.trim(),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setStreaming(true);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    userHasScrolledUpRef.current = false;
    setTimeout(() => scrollToBottom(true), 50);

    let assistantContent = "";
    let assistantTrace: Array<{ name: string; message: string; result?: string }> = [];
    const assistantMsgIndex = newMessages.length;

    const thoughtQueue: string[] = [];
    const textQueue: string[] = [];
    let printedThoughts = "";
    let printedContent = "";

    const thoughtTimer = setInterval(() => {
      if (thoughtQueue.length > 0) {
        const batchSize = thoughtQueue.length > 80 ? 2 : 1;
        for (let i = 0; i < batchSize; i++) {
          const char = thoughtQueue.shift();
          if (char) printedThoughts += char;
        }
        const snapshot = printedThoughts;
        setMessages(prev => {
          const copy = [...prev];
          const msg = copy[assistantMsgIndex];
          if (msg) copy[assistantMsgIndex] = { ...msg, thoughts: snapshot };
          return copy;
        });
        scrollToBottom();
      }
    }, 10);

    const textTimer = setInterval(() => {
      if (textQueue.length > 0) {
        const batchSize = textQueue.length > 120 ? 3 : (textQueue.length > 60 ? 2 : 1);
        for (let i = 0; i < batchSize; i++) {
          const char = textQueue.shift();
          if (char) printedContent += char;
        }
        const snapshot = printedContent;
        setMessages(prev => {
          const copy = [...prev];
          const msg = copy[assistantMsgIndex];
          if (msg) copy[assistantMsgIndex] = { ...msg, content: snapshot };
          return copy;
        });
        scrollToBottom();
      }
    }, 10);

    try {
      // Only send clean content fields — strip thoughts/thinkingTrace to keep payload small
      const historyForApi = newMessages.map(m => ({
        role: m.role,
        content: m.content
      }));

      const response = await fetch("/api/notebook/ask/stream", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: queryText.trim(),
          messages: historyForApi
        })
      });

      if (!response.ok) {
        let message = `Server returned error status: ${response.status}`;
        try {
          const contentType = response.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const body = await response.json();
            if (body?.error || body?.message) message = body.error || body.message;
          } else {
            const body = (await response.text()).trim();
            if (body) message = body;
          }
        } catch {
          // Keep the status fallback if the error body is unreadable.
        }
        throw new Error(message);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Stream response body is not readable.");

      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Insert assistant slot
      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content: "",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          thoughts: "",
          thinkingTrace: [],
          isStreaming: true
        }
      ]);

      const handleSseLines = (lines: string[]) => {
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          try {
            const event = JSON.parse(trimmed.substring(5).trim());

            if (event.type === "thinking") {
              setThinkingText(event.data.message || "Thinking...");
            } else if (event.type === "thought_chunk") {
              const chunk = event.data.content;
              if (chunk) for (const char of chunk) thoughtQueue.push(char);
            } else if (event.type === "text_chunk") {
              const chunk = event.data.content;
              if (chunk) for (const char of chunk) textQueue.push(char);
            } else if (event.type === "tool_start") {
              assistantTrace = [
                ...assistantTrace,
                { name: event.data.name, message: event.data.message, result: "Executing..." }
              ];
              const trace = assistantTrace;
              setMessages(prev => {
                const copy = [...prev];
                const msg = copy[assistantMsgIndex];
                if (msg) copy[assistantMsgIndex] = { ...msg, thinkingTrace: trace };
                return copy;
              });
              scrollToBottom();
            } else if (event.type === "tool_end") {
              if (assistantTrace.length > 0) {
                const updatedTrace = assistantTrace.map((t, i) =>
                  i === assistantTrace.length - 1 ? { ...t, result: event.data.result } : t
                );
                assistantTrace = updatedTrace;
              }
              const trace = assistantTrace;
              setMessages(prev => {
                const copy = [...prev];
                const msg = copy[assistantMsgIndex];
                if (msg) copy[assistantMsgIndex] = { ...msg, thinkingTrace: trace };
                return copy;
              });
              scrollToBottom();
            } else if (event.type === "final_result") {
              assistantContent = event.data.content;
            } else if (event.type === "error") {
              throw new Error(event.data.message || "Streaming search failed.");
            }
          } catch (e: any) {
            // Only swallow JSON parse / keepalive noise — re-throw intentional errors
            if (!(e instanceof SyntaxError)) throw e;
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        handleSseLines(lines);
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        handleSseLines(buffer.split("\n"));
      }

      // Drain typewriter queues then finalize — bail out after 10s max
      const checkAndClean = (attempt = 0) => {
        if ((thoughtQueue.length > 0 || textQueue.length > 0) && attempt < 200) {
          setTimeout(() => checkAndClean(attempt + 1), 50);
          return;
        }

        clearInterval(thoughtTimer);
        clearInterval(textTimer);
        setStreaming(false);
        setThinkingText("");

        setMessages(prev => {
          const copy = [...prev];
          const msg = copy[assistantMsgIndex];
          if (msg) {
            copy[assistantMsgIndex] = {
              ...msg,
              isStreaming: false,
              content: assistantContent || msg.content
            };
          }
          return copy;
        });

        const finalMsg: Message = {
          role: "assistant",
          content: assistantContent || printedContent || "No results found.",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          thoughts: printedThoughts,
          thinkingTrace: assistantTrace,
          isStreaming: false
        };

        const finalMessages = [...newMessages, finalMsg];

        // Use refs for current sessions/sessionId to avoid stale closure
        const currentSessions = sessionsRef.current;
        const targetSessionId = currentSessionIdRef.current;
        const sessionIndex = targetSessionId
          ? currentSessions.findIndex(s => s.id === targetSessionId)
          : -1;

        if (sessionIndex !== -1 && targetSessionId) {
          const updatedSessions = currentSessions.map((s, i) =>
            i === sessionIndex
              ? { ...s, messages: finalMessages, updatedAt: new Date().toISOString() }
              : s
          );
          saveSessions(updatedSessions);
        } else {
          const newSessionId = createSessionId();
          const newSession: ChatSession = {
            id: newSessionId,
            title: queryText.trim().substring(0, 50) + (queryText.trim().length > 50 ? "..." : ""),
            messages: finalMessages,
            updatedAt: new Date().toISOString()
          };
          setCurrentSessionId(newSessionId);
          saveSessions([newSession, ...currentSessions]);
        }
      };

      checkAndClean();

    } catch (err: any) {
      clearInterval(thoughtTimer);
      clearInterval(textTimer);
      setStreaming(false);
      setThinkingText("");

      if (err?.name === "AbortError") {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        setMessages(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m));
        return;
      }

      console.error("Search failed:", err);
      if (abortControllerRef.current === controller) abortControllerRef.current = null;

      // Restore input so the user doesn't have to retype
      setInput(queryText.trim());

      setMessages(prev => {
        const copy = [...prev];
        const msg = copy[assistantMsgIndex];
        if (msg && msg.role === "assistant") {
          copy[assistantMsgIndex] = {
            ...msg,
            content: `Error: ${err.message || "An unexpected error occurred while searching. Please try again."}`,
            thoughts: printedThoughts,
            isStreaming: false
          };
        } else {
          copy.push({
            role: "assistant",
            content: `Error: ${err.message || "An unexpected error occurred while searching. Please try again."}`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            thoughts: printedThoughts,
            thinkingTrace: [],
            isStreaming: false
          });
        }
        return copy;
      });
      scrollToBottom(true);
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div
      className="relative flex flex-col flex-grow w-full h-full min-h-0 bg-[#0a0c10] overflow-hidden"
      style={{
        backgroundImage: "radial-gradient(circle at 70% 20%, rgba(212, 175, 55, 0.05) 0%, transparent 60%)"
      }}
    >
      {/* Top Navbar Header Bar */}
      <header className="h-16 shrink-0 border-b border-white/5 flex items-center justify-between px-6 bg-[#0a0c10]/60 backdrop-blur-md z-30">
        <h1 className="text-[17px] font-bold text-[#f1f3f5]">
          Bhavishya Malika Search Assistant
        </h1>
        <div className="flex items-center gap-3">
          {/* New Chat */}
          <button
            onClick={handleNewChat}
            className="text-[#adb5bd] hover:text-[#d4af37] hover:bg-white/[0.03] p-1.5 rounded-lg transition-all"
            title="New Chat"
          >
            <Plus className="w-5 h-5" />
          </button>

          {/* History Toggle */}
          <div className="relative">
            <button
              ref={historyButtonRef}
              onClick={() => setShowHistoryDropdown(v => !v)}
              className={cn(
                "text-[#adb5bd] hover:text-[#d4af37] hover:bg-white/[0.03] p-1.5 rounded-lg transition-all",
                showHistoryDropdown && "text-white bg-white/10"
              )}
              title="Chat History & Stats"
            >
              <History className="w-5 h-5" />
            </button>

            <AnimatePresence>
              {showHistoryDropdown && (
                <motion.div
                  ref={dropdownRef}
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="absolute right-0 mt-2 w-72 max-h-[420px] flex flex-col rounded-2xl bg-zinc-950/95 backdrop-blur-xl border border-[#d4af37]/20 shadow-2xl overflow-hidden"
                >
                  <div className="flex items-center justify-between p-3 border-b border-[#d4af37]/10 bg-white/[0.02]">
                    <span className="text-[11px] font-semibold text-[#d4af37]/60 tracking-wider uppercase">History</span>
                    {sessions.length > 0 && (
                      <button
                        onClick={handleClearAllHistory}
                        className="flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 font-medium transition-colors"
                      >
                        <Trash2 className="w-3 h-3" /> Clear All
                      </button>
                    )}
                  </div>

                  <div className="flex-1 overflow-y-auto custom-scrollbar p-1.5 space-y-1 max-h-[220px]">
                    {sessions.length === 0 ? (
                      <div className="py-8 text-center text-xs text-white/30 flex flex-col items-center justify-center gap-1.5">
                        <History className="w-5 h-5 opacity-40 text-[#d4af37]" />
                        <span>No sessions yet</span>
                      </div>
                    ) : (
                      sessions.map((s) => (
                        <div
                          key={s.id}
                          onClick={() => handleSelectSession(s)}
                          className={cn(
                            "group flex items-center justify-between w-full p-2.5 rounded-xl text-left text-xs font-medium cursor-pointer transition-all hover:bg-white/5",
                            currentSessionId === s.id && "bg-[#d4af37]/10 text-[#d4af37] border border-[#d4af37]/20"
                          )}
                        >
                          <span className="truncate flex-1 pr-2 text-white/80 group-hover:text-white">
                            {s.title}
                          </span>
                          <button
                            onClick={(e) => handleDeleteSession(s.id, e)}
                            className="opacity-0 group-hover:opacity-100 hover:text-red-400 p-1 rounded-md hover:bg-white/10 transition-all shrink-0"
                            title="Delete Session"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {stats && (
                    <div className="p-3 border-t border-[#d4af37]/10 bg-white/[0.01] space-y-2">
                      <div className="text-[9px] font-bold text-[#d4af37]/50 uppercase tracking-wider">Indexed Database</div>
                      <div className="grid grid-cols-2 gap-2 text-[10px]">
                        <div className="flex items-center gap-1 text-white/50">
                          <FileText className="w-3 h-3 text-[#d4af37] shrink-0" />
                          <span>{stats.total_qa_items.toLocaleString()} Q&As</span>
                        </div>
                        <div className="flex items-center gap-1 text-white/50">
                          <Video className="w-3 h-3 text-[#d4af37] shrink-0" />
                          <span>{stats.total_unique_videos} Videos</span>
                        </div>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* Main Chat Area */}
      <div className="flex-1 min-h-0 w-full flex flex-col justify-between overflow-hidden">
        <div
          ref={messagesAreaRef}
          onScroll={handleScroll}
          className="flex-grow overflow-y-auto px-6 py-8 flex flex-col gap-6 custom-scrollbar"
        >
          {!hasMessages ? (
            <div className="max-w-[720px] mx-auto my-5 text-center py-10 flex flex-col items-center">
              <div className="w-20 h-20 rounded-[24px] bg-[#12161e]/70 border border-[#d4af37]/30 flex items-center justify-center shadow-[0_0_20px_rgba(212,175,55,0.15)] mb-6">
                <Bot className="w-10 h-10 text-[#d4af37]" />
              </div>

              <h2 className="text-2xl md:text-[28px] font-extrabold mb-3 bg-clip-text text-transparent bg-gradient-to-br from-[#f1f3f5] via-[#f1f3f5] to-[#d4af37]">
                Ask me anything about Bhavishya Malika
              </h2>

              <p className="text-[#adb5bd] text-[15px] leading-relaxed max-w-[540px] mb-10 text-center">
                This agent has direct access to the entire Bhavishya Malika Q&A database. It will dynamically search the records, parse answers, and reference exact video links.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
                {getVisibleSuggestions().map((s) => (
                  <div
                    key={s.title}
                    onClick={() => handleSearch(s.query)}
                    className="bg-[#12161e]/70 border border-white/5 rounded-2xl p-5 text-left cursor-pointer transition-all hover:border-[#d4af37] hover:bg-[#d4af37]/3 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(212,175,55,0.15)]"
                  >
                    <span className="block font-semibold text-[15px] text-[#f1f3f5] mb-1.5">
                      {s.title}
                    </span>
                    <span className="block text-[13px] text-[#adb5bd] leading-relaxed">
                      {s.desc}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto w-full space-y-6">
              {messages.map((m, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "flex gap-4 w-full",
                    m.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  {m.role === "user" ? (
                    <div className="bg-[#d4af37]/8 border border-[#d4af37]/30 text-[#f1f3f5] rounded-2xl rounded-tr-[2px] px-5 py-4 text-xs md:text-sm max-w-[70%] w-fit shadow-sm">
                      {m.content}
                    </div>
                  ) : (
                    <>
                      <div className="w-9 h-9 rounded-full bg-white/[0.03] border border-[#d4af37]/40 flex items-center justify-center text-[#d4af37] shadow-[0_0_10px_rgba(212,175,55,0.1)] shrink-0">
                        <Bot className="w-5 h-5" />
                      </div>

                      <div className="bg-[#12161e]/85 border border-white/5 rounded-2xl rounded-tl-[2px] p-5 text-xs md:text-sm leading-relaxed max-w-[calc(100%-52px)] w-full shadow-sm space-y-3">
                        {/* Tool execution trace */}
                        {m.thinkingTrace && m.thinkingTrace.length > 0 && (
                          <div className="flex flex-col gap-2">
                            {m.thinkingTrace.map((step, sIdx) => {
                              let icon = <Search className="w-3.5 h-3.5 text-[#d4af37]" />;
                              if (step.name === "get_video_qas") {
                                icon = <Video className="w-3.5 h-3.5 text-[#d4af37]" />;
                              } else if (step.name === "get_database_stats") {
                                icon = <Database className="w-3.5 h-3.5 text-[#d4af37]" />;
                              }
                              return (
                                <div key={sIdx} className="flex items-center justify-between w-full p-2.5 rounded-xl bg-white/[0.02] border border-white/5 text-[11px] text-[#adb5bd]">
                                  <div className="flex items-center gap-2">
                                    {icon}
                                    <span>{step.message}</span>
                                  </div>
                                  <div className="border-l border-white/10 pl-3 text-[#d4af37] font-semibold text-right min-w-[80px]">
                                    {step.result === "Executing..." ? (
                                      <span className="flex items-center justify-end gap-1.5">
                                        <Loader2 className="w-3 h-3 animate-spin text-[#d4af37]" />
                                        Executing...
                                      </span>
                                    ) : (
                                      step.result
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {m.thoughts && m.thoughts.trim() && (
                          <div className="thought-container">
                            <button
                              type="button"
                              onClick={() => toggleThoughts(idx)}
                              className="flex items-center gap-1.5 text-xs text-white/40 font-semibold select-none cursor-pointer hover:text-white/60"
                            >
                              <span>
                                {m.isStreaming ? (thinkingText || "Thinking...") : "Thought for a second"}
                              </span>
                              {collapsedThoughts[idx] ? (
                                <ChevronRight className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronDown className="w-3.5 h-3.5" />
                              )}
                            </button>

                            {!collapsedThoughts[idx] && (
                              <div className="border-l-2 border-white/10 ml-1.5 pl-3.5 mt-2 text-xs text-[#adb5bd] leading-relaxed whitespace-pre-wrap font-sans">
                                {m.thoughts}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Final answer content */}
                        {(!m.content && m.isStreaming) ? (
                          null
                        ) : (
                          <div className="prose prose-invert prose-xs max-w-none space-y-3">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                a: ({ href, children }) => {
                                  const isYoutube = href && (href.includes("youtube.com") || href.includes("youtu.be"));
                                  return (
                                    <a
                                      href={href}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className={cn(
                                        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all font-medium text-xs mt-1",
                                        isYoutube
                                          ? "bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/20"
                                          : "text-[#d4af37] hover:underline"
                                      )}
                                    >
                                      {isYoutube && <Play className="w-3.5 h-3.5 fill-current text-red-500" />}
                                      {children}
                                      {!isYoutube && <ExternalLink className="w-2.5 h-2.5 inline opacity-65" />}
                                    </a>
                                  );
                                },
                                p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
                                ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
                                ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
                                li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                                code: ({ children }) => <code className="bg-white/10 px-1 py-0.5 rounded text-[11px] font-mono">{children}</code>
                              }}
                            >
                              {m.content}
                            </ReactMarkdown>
                          </div>
                        )}

                        {/* Copy button for finished assistant messages */}
                        {!m.isStreaming && m.content && (
                          <div className="flex justify-end pt-1">
                            <button
                              onClick={() => copyToClipboard(m.content, idx)}
                              className="flex items-center gap-1 text-[10px] text-white/30 hover:text-[#d4af37] transition-colors"
                              title="Copy response"
                            >
                              {copiedIndex === idx ? (
                                <><Check className="w-3 h-3" /> Copied</>
                              ) : (
                                <><Copy className="w-3 h-3" /> Copy</>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Input Form Panel */}
        <div className="px-4 pb-3 pt-0 md:px-6 md:pb-4 bg-transparent border-none shrink-0">
          <div className="max-w-3xl mx-auto">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSearch(input);
              }}
              className="max-w-[800px] mx-auto flex bg-[#12161e]/70 border border-white/5 rounded-2xl p-1.5 focus-within:border-[#d4af37] focus-within:shadow-[0_0_20px_rgba(212,175,55,0.15)] transition-all"
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={streaming}
                placeholder="Ask about videos, countries, signs of Satyug..."
                className="flex-grow bg-transparent border-none text-[#f1f3f5] px-4 py-3 text-[15px] focus:outline-none placeholder-white/20 disabled:opacity-50"
              />
              <button
                type={streaming ? "button" : "submit"}
                onClick={streaming ? stopSearch : undefined}
                disabled={!streaming && !input.trim()}
                className={cn(
                  "rounded-xl w-[42px] h-[42px] flex items-center justify-center cursor-pointer hover:scale-[1.02] active:scale-95 transition-all shrink-0",
                  streaming
                    ? "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-600 disabled:text-white"
                    : "bg-[#d4af37] text-[#0a0c10] hover:bg-[#f3e5ab] disabled:bg-white/5 disabled:text-white/20"
                )}
                title={streaming ? "Stop search" : "Send Message"}
              >
                {streaming ? <Square className="w-4 h-4 fill-current" /> : <Send className="w-4 h-4 fill-current" />}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
