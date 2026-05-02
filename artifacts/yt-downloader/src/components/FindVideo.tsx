import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock, Loader2, Search, Send, Square, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type FindVideoEvent =
  | { type: "queued"; position?: number; message?: string; elapsedMs?: number }
  | { type: "waiting_global"; attempt?: number; message?: string; elapsedMs?: number }
  | { type: "cooldown"; message?: string; elapsedMs?: number }
  | { type: "asking"; message?: string; elapsedMs?: number }
  | { type: "answer"; answer?: string; references?: NotebookReference[]; elapsedMs?: number }
  | { type: "done"; elapsedMs?: number }
  | { type: "error"; message?: string; elapsedMs?: number };

type NotebookReference = {
  sourceId?: string | null;
  citationNumber?: number | null;
  citedText?: string | null;
  startChar?: number | null;
  endChar?: number | null;
};

type NotebookHealth = {
  enabled?: boolean;
  configured?: boolean;
};

type RunState = "idle" | "queued" | "waiting" | "asking" | "done" | "error";

function formatElapsed(ms?: number | null): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function parseSseChunk(buffer: string): { events: FindVideoEvent[]; rest: string } {
  const events: FindVideoEvent[] = [];
  const blocks = buffer.split(/\n\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const line = block
      .split("\n")
      .find((x) => x.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      events.push(JSON.parse(payload) as FindVideoEvent);
    } catch {
      // Ignore malformed stream frames.
    }
  }
  return { events, rest };
}

export function FindVideo() {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<RunState>("idle");
  const [statusText, setStatusText] = useState("");
  const [answer, setAnswer] = useState("");
  const [references, setReferences] = useState<NotebookReference[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [position, setPosition] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [isConfigured, setIsConfigured] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${BASE}/api/notebook/health`, {
      credentials: "include",
      headers: { "Cache-Control": "no-cache" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((health: NotebookHealth | null) => {
        if (cancelled) return;
        setIsConfigured(Boolean(health?.enabled && health?.configured));
      })
      .catch(() => {
        if (!cancelled) setIsConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!startedAt || status === "done" || status === "error" || status === "idle") return;
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, status]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    setStatusText("");
  };

  const handleEvent = (event: FindVideoEvent) => {
    if (typeof event.elapsedMs === "number") setElapsedMs(event.elapsedMs);
    if (event.type === "queued") {
      setStatus("queued");
      setPosition(typeof event.position === "number" ? event.position : null);
      setStatusText(event.message ?? "Waiting for your turn");
      return;
    }
    if (event.type === "waiting_global") {
      setStatus("waiting");
      setStatusText(event.message ?? "Waiting for NotebookLM");
      return;
    }
    if (event.type === "cooldown") {
      setStatus("waiting");
      setStatusText(event.message ?? "Waiting briefly before asking");
      return;
    }
    if (event.type === "asking") {
      setStatus("asking");
      setPosition(null);
      setStatusText(event.message ?? "Asking NotebookLM");
      return;
    }
    if (event.type === "answer") {
      setStatus("done");
      setStatusText("Answer ready");
      setAnswer(event.answer ?? "");
      setReferences(Array.isArray(event.references) ? event.references : []);
      return;
    }
    if (event.type === "error") {
      setStatus("error");
      setStatusText(event.message ?? "Find Video failed");
    }
  };

  const ask = async () => {
    const message = prompt.trim();
    if (!message || !isConfigured) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStartedAt(Date.now());
    setElapsedMs(0);
    setStatus("queued");
    setStatusText("Joining NotebookLM queue");
    setPosition(null);
    setAnswer("");
    setReferences([]);

    try {
      const res = await fetch(`${BASE}/api/notebook/ask/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Find Video request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseChunk(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) handleEvent(event);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "Find Video failed");
    } finally {
      abortRef.current = null;
    }
  };

  const isRunning = status === "queued" || status === "waiting" || status === "asking";
  const canSubmit = isConfigured && prompt.trim().length > 0 && !isRunning;

  return (
    <div className="find-video-page">
      <div className="find-video-inner">
        <header className="find-video-header">
          <div className="find-video-icon">
            <Search className="w-5 h-5 text-sky-300" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Find Video</h1>
            <p className="text-sm text-white/50 mt-1">Ask the connected NotebookLM sources and get only the result.</p>
          </div>
        </header>

        <section className="find-video-card">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="find-video-input"
            placeholder="e.g. asteroid girega 3 bhag hojayega find this please"
            rows={4}
            disabled={isRunning || !isConfigured}
            onKeyDown={(e) => {
              if (isConfigured && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void ask();
              }
            }}
          />
          <div className="find-video-actions">
            <div className="find-video-status">
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : status === "done" ? <CheckCircle2 className="w-4 h-4" /> : status === "error" ? <AlertCircle className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
              <span>{statusText || "Ready"}</span>
              {position && position > 1 && <span className="find-video-chip">turn {position}</span>}
              {(isRunning || status === "done" || status === "error") && <span className="find-video-chip">{formatElapsed(elapsedMs)}</span>}
            </div>
            {isRunning ? (
              <button type="button" className="find-video-btn find-video-btn-secondary" onClick={stop}>
                <Square className="w-4 h-4" />
                Stop
              </button>
            ) : (
              <button type="button" className="find-video-btn" disabled={!canSubmit} onClick={() => void ask()}>
                <Send className="w-4 h-4" />
                Ask
              </button>
            )}
          </div>
        </section>

        {(answer || status === "error" || isRunning) && (
          <section className={cn("find-video-result", status === "error" && "find-video-result-error")}>
            {answer ? (
              <>
                <div className="find-video-result-top">
                  <span>Result</span>
                  <button
                    type="button"
                    className="find-video-copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(answer);
                      toast({ title: "Copied" });
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </button>
                </div>
                <pre className="find-video-answer">{answer}</pre>
                {references.length > 0 && (
                  <div className="find-video-references">
                    <p>References</p>
                    {references.slice(0, 8).map((ref, idx) => (
                      <div key={`${ref.sourceId ?? "ref"}-${idx}`} className="find-video-reference">
                        <span>{ref.citationNumber ? `[${ref.citationNumber}]` : `#${idx + 1}`}</span>
                        <span>{ref.citedText || ref.sourceId || "NotebookLM source"}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="find-video-waiting">
                {status === "error" ? <AlertCircle className="w-5 h-5 text-red-300" /> : <Loader2 className="w-5 h-5 animate-spin text-sky-300" />}
                <span>{statusText || "Waiting"}</span>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
