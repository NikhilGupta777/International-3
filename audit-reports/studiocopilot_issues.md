# Technical Audit & Replacement Guide: StudioCopilot.tsx

This document contains the location, description, original code block, and exact replacement block for each issue identified in `artifacts/yt-downloader/src/components/StudioCopilot.tsx`.

---

## 1. Broken Markdown Rendering (Dead Code Bypass)

*   **Location**: `renderMd` and `renderStreamingMd` functions (Lines 545–546, 687–688)
*   **Issue**: On the first line of both functions, the code immediately returns a `<MarkdownContent />` component. This bypasses hundreds of lines of custom formatting, token rendering, math formulas, and citation resolution, causing them to fail.
*   **How to Fix**: Remove the early returns to allow the custom parsing/typewriter logic to execute.

### Original Code (renderMd)
```typescript
function renderMd(text: string, sources?: Array<{ title: string; uri: string }>): React.ReactNode {
  return <MarkdownContent text={text} sources={sources} />;
  const lines = text.split("\n");
```

### Replacement Code (renderMd)
```typescript
function renderMd(text: string, sources?: Array<{ title: string; uri: string }>): React.ReactNode {
  const lines = text.split("\n");
```

### Original Code (renderStreamingMd)
```typescript
function renderStreamingMd(text: string, sources?: Array<{ title: string; uri: string }>): React.ReactNode {
  return <MarkdownContent text={text} sources={sources} streaming />;
  const lines = text.split("\n");
```

### Replacement Code (renderStreamingMd)
```typescript
function renderStreamingMd(text: string, sources?: Array<{ title: string; uri: string }>): React.ReactNode {
  const lines = text.split("\n");
```

---

## 2. Memory Bloat from Base64 Images in live React state

*   **Location**: `sendMessage` function (Lines 2864–2877)
*   **Issue**: Large base64-encoded image strings (`data`) are kept in the live React `sessions` state indefinitely. This causes extreme memory bloat, laggy typing, and UI slowdowns.
*   **How to Fix**: Delete the heavy base64 data string from the sessions state immediately after building the request payload.

### Original Code
```typescript
    updateSession(sessionId, msgs => [...msgs, {
      id: userMsgId, role: "user",
      parts: userParts,
      timestamp: new Date(),
    }]);

    upsertMsg(sessionId, assistantMsgId, m => m);
```

### Replacement Code
```typescript
    updateSession(sessionId, msgs => [...msgs, {
      id: userMsgId, role: "user",
      parts: userParts,
      timestamp: new Date(),
    }]);

    // Clean up heavy base64 data from live React sessions state to prevent memory leak
    updateSession(sessionId, msgs => msgs.map(m => {
      if (m.id !== userMsgId) return m;
      return {
        ...m,
        parts: m.parts.map(p => {
          if (p.kind === "attachment" && p.data) {
            const { data: _data, ...rest } = p as any;
            return rest;
          }
          return p;
        })
      };
    }));

    upsertMsg(sessionId, assistantMsgId, m => m);
```

---

## 3. Unrevoked Object URLs (Filesystem memory leak)

*   **Location**: Unmount cleanup `useEffect` (Lines 3399–3405)
*   **Issue**: Object URLs are created via `URL.createObjectURL(file)` when attaching files. However, the unmount hook only revokes URLs inside `sessionsRef`. Blob URLs in `pendingAttachmentsRef` are leaked if the component is unmounted while attachments are pending.
*   **How to Fix**: Iterate over all `pendingAttachmentsRef` and revoke their `previewUrl` during unmount.

### Original Code
```typescript
  // Cleanup: abort any in-flight stream and stop speech recognition on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      recognitionRef.current?.stop();
      sessionsRef.current.forEach(session => revokeMessagePreviewUrls(session.messages));
    };
  }, []);
```

### Replacement Code
```typescript
  // Cleanup: abort any in-flight stream and stop speech recognition on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      recognitionRef.current?.stop();
      sessionsRef.current.forEach(session => revokeMessagePreviewUrls(session.messages));
      pendingAttachmentsRef.current.forEach(a => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      });
    };
  }, []);
```

---

## 4. Concurrent Tool Resolution

*   **Location**: `parseSseFrame` under `evt.type === "tool_done"` (Lines 3170–3175)
*   **Issue**: When a `tool_done` event lacks a `toolId`, it updates *every* unfinished tool matching `evt.name`. Parallel tool execution with the same name (such as parallel web searches) will all get prematurely resolved with the first result.
*   **How to Fix**: Use `findIndex` to find and resolve only the first (oldest) matching unfinished tool.

### Original Code
```typescript
      if (evt.type === "tool_done") {
        setActiveToolLabel(null);
        patchAssistant(m => ({
          ...m, parts: m.parts.map(p =>
            p.kind === "tool_start" && ((evt.toolId && (p as any).toolId === evt.toolId) || (!evt.toolId && (p as any).name === evt.name && !(p as any).done))
              ? { ...p, done: true, result: evt.result, progress: 100 } : p),
        }));
        return;
      }
```

### Replacement Code
```typescript
      if (evt.type === "tool_done") {
        setActiveToolLabel(null);
        patchAssistant(m => {
          let targetIdx = -1;
          if (evt.toolId) {
            targetIdx = m.parts.findIndex(p => p.kind === "tool_start" && (p as any).toolId === evt.toolId);
          } else {
            // Target the oldest unfinished tool of this name
            targetIdx = m.parts.findIndex(p => p.kind === "tool_start" && (p as any).name === evt.name && !(p as any).done);
          }
          if (targetIdx === -1) return m;
          const parts = [...m.parts];
          parts[targetIdx] = {
            ...parts[targetIdx],
            done: true,
            result: evt.result,
            progress: 100,
          };
          return { ...m, parts };
        });
        return;
      }
```

---

## 5. Text-to-Speech Unmount speech leak

*   **Location**: `ReadAloudButton` component (Lines 2040–2061)
*   **Issue**: Lacks unmount cleanup. The browser will continue speaking text even after the component is destroyed.
*   **How to Fix**: Add a cleanup `useEffect` that calls `window.speechSynthesis.cancel()`.

### Original Code
```typescript
function ReadAloudButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const read = () => {
    if (!("speechSynthesis" in window)) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(clientStripTags(text));
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };
  return (
    <button onClick={read} title={speaking ? "Stop reading" : "Read aloud"} className="gs-message-action-btn">
      <Volume2 className="w-3 h-3" />
    </button>
  );
}
```

### Replacement Code
```typescript
function ReadAloudButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    return () => {
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const read = () => {
    if (!("speechSynthesis" in window)) return;
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(clientStripTags(text));
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };
  return (
    <button onClick={read} title={speaking ? "Stop reading" : "Read aloud"} className="gs-message-action-btn">
      <Volume2 className="w-3 h-3" />
    </button>
  );
}
```

---

## 6. Textarea Won't Shrink (No inputRef resizing)

*   **Location**: `sendMessage` clearing logic (Lines 2839 & 2846) and `<textarea>` markup (Line 3844)
*   **Issue**: Calling `setInput("")` when a message is sent updates React state but doesn't fire the DOM `onChange` event where height calculations reside. The textarea stays artificially large until typed in again.
*   **How to Fix**: Create a React ref `textareaRef`, hook it to the textarea, and programmatically clear its height in `sendMessage`.

### Original Code (State updates in sendMessage)
```typescript
        activeSkillsRef.current = snapshotSkills;
        setActiveSkills(snapshotSkills);
        setInput("");
```
and
```typescript
    const sessionId = ensureSession();
    setInput("");
```

### Replacement Code (State updates in sendMessage)
```typescript
        activeSkillsRef.current = snapshotSkills;
        setActiveSkills(snapshotSkills);
        setInput("");
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
          textareaRef.current.style.overflowY = "hidden";
        }
```
and
```typescript
    const sessionId = ensureSession();
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.overflowY = "hidden";
    }
```

### Original Code (Textarea markup)
```typescript
          <textarea
            className="gs-input-textarea gs-input-textarea-inline"
            value={input}
```

### Replacement Code (Textarea markup)
```typescript
          <textarea
            ref={textareaRef}
            className="gs-input-textarea gs-input-textarea-inline"
            value={input}
```
*(Also add `const textareaRef = useRef<HTMLTextAreaElement>(null);` near state declarations)*

---

## 7. Live Canvas Blocking

*   **Location**: `extractCanvasCandidate` function (Lines 1043–1056)
*   **Issue**: The parser prioritizes the largest closed code block. When multiple files are generated, the first closed file blocks live previews for subsequent files currently streaming in an "open" state.
*   **How to Fix**: Check if there is an unclosed streaming block (indicated by an odd number of code fences) and prioritize it.

### Original Code
```typescript
function extractCanvasCandidate(text: string): CanvasCandidate | null {
  const closed = Array.from(text.matchAll(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*?)```/g));
  let match: RegExpMatchArray | null = null;
  let live = false;

  if (closed.length > 0) {
    match = closed.reduce((best, item) => (item[2].length > best[2].length ? item : best), closed[0]);
  } else {
    const open = text.match(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*)$/);
    if (open) {
      match = open;
      live = true;
    }
  }
```

### Replacement Code
```typescript
function extractCanvasCandidate(text: string): CanvasCandidate | null {
  const closed = Array.from(text.matchAll(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*?)```/g));
  let match: RegExpMatchArray | null = null;
  let live = false;

  const lastFenceIndex = text.lastIndexOf("```");
  if (lastFenceIndex !== -1) {
    const occurrences = (text.match(/```/g) || []).length;
    if (occurrences % 2 === 1) { // Unclosed code block
      const open = text.match(/```([a-zA-Z0-9+#.-]*)[^\n]*\n([\s\S]*)$/);
      if (open) {
        match = open;
        live = true;
      }
    }
  }

  if (!match && closed.length > 0) {
    match = closed.reduce((best, item) => (item[2].length > best[2].length ? item : best), closed[0]);
  }
```

---

## 8. Massive DOM Bloat in TextArtifact

*   **Location**: `TextArtifact` rendering (Lines 1466–1484)
*   **Issue**: The component renders a duplicated legacy layout inside `<div className="hidden">`. The browser must maintain thousands of hidden DOM nodes for every message in the chat history, causing slow scrolling.
*   **How to Fix**: Delete the hidden block completely.

### Original Code
```typescript
      </ArtifactShell>
      {/* HIDDEN — old card body retained below replaced by ArtifactShell above */}
      <div className="hidden">
        <div className="flex items-start gap-3 px-3 py-3 border-b border-white/8">
          <div className="mt-0.5 p-2 rounded-xl bg-cyan-400/12 border border-cyan-300/15">
            <SquarePen className="w-4 h-4 text-cyan-200" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-cyan-100 truncate">{label}</p>
            <p className="text-[11px] text-white/40 mt-0.5">{content.length.toLocaleString()} chars - {live ? "writing live" : "canvas ready"}{canPreview ? " - preview supported" : ""}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <a href={artifactUrl} download={downloadName} title="Download" className="p-1.5 rounded-lg bg-white/6 hover:bg-white/10 text-white/55 hover:text-white">
              <Download className="w-3.5 h-3.5" />
            </a>
            <SaveTextToWorkspaceBtn content={content} suggestedName={downloadName} />
          </div>
        </div>
        <pre className="text-xs text-white/70 font-mono p-3 overflow-x-auto max-h-56 whitespace-pre-wrap bg-black/20">{preview}</pre>
      </div>
      <AnimatePresence>
```

### Replacement Code
```typescript
      </ArtifactShell>
      <AnimatePresence>
```
