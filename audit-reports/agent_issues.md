# Technical Audit & Replacement Guide: agent.ts

This document contains the location, description, original code block, and exact replacement block for each issue identified in `artifacts/api-server/src/routes/agent.ts`.

---

## 1. Sandbox Concurrency Leak (OOM & Cost Risk)

*   **Location**: `getChatSandbox` function (Lines 1403–1435)
*   **Issue**: Multiple concurrent requests for the same `sessionKey` will read `undefined` from `e2bSandboxBySession` and independently call `Sandbox.create()`. This leaks multiple expensive E2B sandboxes because only the last one to complete writes its ID to `e2bSandboxBySession`, while the others remain active and billable until their 1-hour timeout.
*   **How to Fix**: Store pending sandbox creation promises in a separate tracking Map to allow concurrent requests to wait for the same E2B sandbox initialization.

### Original Code
```typescript
async function getChatSandbox(req: any): Promise<any> {
  if (!e2bConfigured()) {
    throw new Error("E2B sandbox is not configured. Set E2B_API_KEY on the API server.");
  }

  pruneExpiredSandboxEntries();
  const sessionKey = sandboxSessionKey(req);
  const existing = e2bSandboxBySession.get(sessionKey);
  if (existing) {
    try {
      const connected = await Sandbox.connect(existing.sandboxId, { timeoutMs: E2B_SANDBOX_TIMEOUT_MS });
      await connected.setTimeout(E2B_SANDBOX_TIMEOUT_MS).catch(() => {});
      rememberSandbox(sessionKey, existing.sandboxId);
      await bootstrapSandboxMediaTools(connected, sessionKey);
      await preloadAppCodeIntoSandbox(connected, sessionKey);
      return connected;
    } catch (err) {
      logger.warn({ err, sessionKey, existingId: existing.sandboxId }, "Could not reconnect E2B sandbox; creating a new one");
      e2bSandboxBySession.delete(sessionKey);
    }
  }

  const sandbox = await Sandbox.create({
    timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
    metadata: {
      app: "videomaking-superagent",
      sessionId: sessionKey,
    },
  });
  rememberSandbox(sessionKey, sandbox.sandboxId);
  await bootstrapSandboxMediaTools(sandbox, sessionKey);
  await preloadAppCodeIntoSandbox(sandbox, sessionKey);
  return sandbox;
}
```

### Replacement Code
```typescript
const pendingSandboxCreations = new Map<string, Promise<any>>();

async function getChatSandbox(req: any): Promise<any> {
  if (!e2bConfigured()) {
    throw new Error("E2B sandbox is not configured. Set E2B_API_KEY on the API server.");
  }

  pruneExpiredSandboxEntries();
  const sessionKey = sandboxSessionKey(req);

  // Return existing pending creation promise if one is already active
  const pending = pendingSandboxCreations.get(sessionKey);
  if (pending) {
    return pending;
  }

  const existing = e2bSandboxBySession.get(sessionKey);
  if (existing) {
    try {
      const connected = await Sandbox.connect(existing.sandboxId, { timeoutMs: E2B_SANDBOX_TIMEOUT_MS });
      await connected.setTimeout(E2B_SANDBOX_TIMEOUT_MS).catch(() => {});
      rememberSandbox(sessionKey, existing.sandboxId);
      await bootstrapSandboxMediaTools(connected, sessionKey);
      await preloadAppCodeIntoSandbox(connected, sessionKey);
      return connected;
    } catch (err) {
      logger.warn({ err, sessionKey, existingId: existing.sandboxId }, "Could not reconnect E2B sandbox; creating a new one");
      e2bSandboxBySession.delete(sessionKey);
    }
  }

  const createPromise = (async () => {
    try {
      const sandbox = await Sandbox.create({
        timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
        metadata: {
          app: "videomaking-superagent",
          sessionId: sessionKey,
        },
      });
      rememberSandbox(sessionKey, sandbox.sandboxId);
      await bootstrapSandboxMediaTools(sandbox, sessionKey);
      await preloadAppCodeIntoSandbox(sandbox, sessionKey);
      return sandbox;
    } finally {
      pendingSandboxCreations.delete(sessionKey);
    }
  })();

  pendingSandboxCreations.set(sessionKey, createPromise);
  return createPromise;
}
```

---

## 2. Heap Out of Memory (OOM) in S3 Uploads

*   **Location**: `save_artifact_to_workspace` case in router execution (Lines 3107–3118)
*   **Issue**: Despite the comments saying they stream to avoid buffering through the heap, `Buffer.from(await r.arrayBuffer())` forces the entire file stream into memory. For large video files, this causes the Node process to crash with an Out of Memory (OOM) error.
*   **How to Fix**: Stream the readable body of the HTTP response (`r.body`) directly to `fetch` for S3 upload using the `duplex: "half"` option.

### Original Code
```typescript
      // Stream into a presigned PUT so we never buffer huge files through Lambda heap.
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength > WORKSPACE_LIMITS.MAX_FILE_BYTES) {
        throw new Error(`source too large (${buf.byteLength} bytes)`);
      }
      const presign = await ws.s3.presignPut(path, { size: buf.byteLength, contentType });
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        body: buf,
        headers: contentType ? { "Content-Type": contentType } : undefined,
      });
      if (!putRes.ok) throw new Error(`workspace upload failed: ${putRes.status}`);
      const { url: downloadUrl } = await ws.s3.presignGet(path, { disposition: "attachment" });
      return {
        result: { path, size: buf.byteLength, contentType, downloadUrl },
```

### Replacement Code
```typescript
      // Stream into a presigned PUT so we never buffer huge files through Lambda heap.
      if (!size) {
        throw new Error("Content-Length header is missing, unable to stream artifact.");
      }
      if (size > WORKSPACE_LIMITS.MAX_FILE_BYTES) {
        throw new Error(`source too large (${size} bytes)`);
      }
      const presign = await ws.s3.presignPut(path, { size, contentType });
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        body: r.body,
        duplex: "half",
        headers: {
          ...(contentType ? { "Content-Type": contentType } : {}),
          "Content-Length": String(size),
        },
      } as any);
      if (!putRes.ok) throw new Error(`workspace upload failed: ${putRes.status}`);
      const { url: downloadUrl } = await ws.s3.presignGet(path, { disposition: "attachment" });
      return {
        result: { path, size, contentType, downloadUrl },
```

---

## 3. Web Fetching OOM Risk

*   **Location**: `fetchReadableWebPage` function (Line 1942)
*   **Issue**: Calling `await r.text()` loads the entire response into V8 string memory without checking its size first. Infinite streams or large files will exhaust memory limits.
*   **How to Fix**: Read the incoming response stream in chunks and throw an error if the accumulated size exceeds 5MB.

### Original Code
```typescript
    if (!r.ok) throw new Error(`Page fetch failed: HTTP ${r.status}`);
    const contentType = r.headers.get("content-type") ?? "";
    const raw = await r.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g, " ").trim();
```

### Replacement Code
```typescript
    if (!r.ok) throw new Error(`Page fetch failed: HTTP ${r.status}`);
    const contentType = r.headers.get("content-type") ?? "";
    const sizeHeader = r.headers.get("content-length");
    if (sizeHeader && Number(sizeHeader) > 5 * 1024 * 1024) {
      throw new Error("Page response too large (limit 5MB).");
    }

    if (!r.body) throw new Error("Response body is empty.");
    let raw = "";
    const reader = r.body.getReader();
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 5 * 1024 * 1024) {
        controller.abort();
        throw new Error("Response exceeds size limit of 5MB.");
      }
      raw += new TextDecoder().decode(value, { stream: true });
    }
    raw += new TextDecoder().decode();

    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g, " ").trim();
```

---

## 4. Attachment Text Reading OOM Risk

*   **Location**: `readAttachmentText` function (Line 1752)
*   **Issue**: Reading attachments with `await r.text()` poses the same OOM risk as web page fetching.
*   **How to Fix**: Read the body in chunked streams and enforce a 5MB size limit.

### Original Code
```typescript
    const contentType = r.headers.get("content-type") ?? attachment.mimeType;
    if (contentType.includes("pdf")) {
      return { content: `[PDF attachment: ${url}]`, name: attachment.name, mimeType: contentType };
    }
    return { content: await r.text(), name: attachment.name, mimeType: contentType };
```

### Replacement Code
```typescript
    const contentType = r.headers.get("content-type") ?? attachment.mimeType;
    if (contentType.includes("pdf")) {
      return { content: `[PDF attachment: ${url}]`, name: attachment.name, mimeType: contentType };
    }
    const sizeHeader = r.headers.get("content-length");
    if (sizeHeader && Number(sizeHeader) > 5 * 1024 * 1024) {
      throw new Error(`Attachment too large (${sizeHeader} bytes), limit 5MB.`);
    }
    if (!r.body) throw new Error("Attachment response body is empty.");
    let content = "";
    const reader = r.body.getReader();
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 5 * 1024 * 1024) {
        ac.abort();
        throw new Error("Attachment exceeds size limit of 5MB.");
      }
      content += new TextDecoder().decode(value, { stream: true });
    }
    content += new TextDecoder().decode();
    return { content, name: attachment.name, mimeType: contentType };
```

---

## 5. Sandbox Execution Unbounded Output OOM Risk

*   **Location**: `runE2BSandboxCommand` function (Lines 1496–1505)
*   **Issue**: Running infinite commands (like `yes`) will accumulate stdout and stderr infinitely in memory via string concatenation, causing a crash.
*   **How to Fix**: Cap stdout and stderr accumulations to 500KB.

### Original Code
```typescript
  let liveOut = "";
  let liveErr = "";
  const commandWithPath = `export PATH="/home/user/bin:/home/user/.local/bin:$PATH"\n${command}`;
  sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Running in sandbox: ${command.slice(0, 120)}` });
  const result = await sandbox.commands.run(commandWithPath, {
    cwd,
    timeoutMs,
    onStdout: (data: string) => { liveOut += data; },
    onStderr: (data: string) => { liveErr += data; },
  });
```

### Replacement Code
```typescript
  let liveOut = "";
  let liveErr = "";
  const commandWithPath = `export PATH="/home/user/bin:/home/user/.local/bin:$PATH"\n${command}`;
  sseEvent(res, { type: "tool_progress", runId, toolId, name, message: `Running in sandbox: ${command.slice(0, 120)}` });
  const result = await sandbox.commands.run(commandWithPath, {
    cwd,
    timeoutMs,
    onStdout: (data: string) => {
      if (liveOut.length < 500 * 1024) liveOut += data;
    },
    onStderr: (data: string) => {
      if (liveErr.length < 500 * 1024) liveErr += data;
    },
  });
```

---

## 6. Google Drive Import stream-body crash

*   **Location**: `import_from_drive` case in router execution (Lines 3171–3175)
*   **Issue**: Node.js throws a TypeError when sending a readable stream body to `fetch` without passing `duplex: "half"`.
*   **How to Fix**: Add `duplex: "half"` to the `fetch` options.

### Original Code
```typescript
      const presign = await ws.s3.presignPut(path, { size, contentType: mimeType });
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        body,
        headers: { "Content-Type": mimeType },
      });
```

### Replacement Code
```typescript
      const presign = await ws.s3.presignPut(path, { size, contentType: mimeType });
      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        body,
        duplex: "half",
        headers: { "Content-Type": mimeType },
      } as any);
```

---

## 7. Event Spam Prevention Defeated

*   **Location**: `pollJobUntilDone` function (Lines 223–235)
*   **Issue**: Deduplication checking compares `liveMessage` with `lastLogMsg`. However, because `elapsedSeconds` updates every single second and is inside `liveMessage`, the message is never identical, defeating the spam blocker and flooding logs.
*   **How to Fix**: Compare the base message (without elapsed seconds) for deduplication.

### Original Code
```typescript
    let liveMessage = message ?? status;
    if (toolName === "cut_video_clip" && !["done", "error", "cancelled", "expired", "not_found"].includes(status)) {
      const base = message && message !== status ? message : "Cutting selected section";
      liveMessage = `${base}... ${elapsedSeconds}s`;
    }
    sseEvent(res, { type: "tool_progress", runId, toolId, name: toolName, status, percent: percent ?? null, message: liveMessage, jobId });
    // Only push to the Activity log when the message actually changed —
    // otherwise we spam the timeline with N identical "Cutting selected section… 5s" lines.
    if (toolName === "cut_video_clip" && liveMessage !== lastLogMsg) {
      sseEvent(res, { type: "tool_log", runId, toolId, name: toolName, message: liveMessage, level: "info" });
      lastLogMsg = liveMessage;
    }
```

### Replacement Code
```typescript
    const baseMessage = message && message !== status ? message : "Cutting selected section";
    let liveMessage = message ?? status;
    if (toolName === "cut_video_clip" && !["done", "error", "cancelled", "expired", "not_found"].includes(status)) {
      liveMessage = `${baseMessage}... ${elapsedSeconds}s`;
    }
    sseEvent(res, { type: "tool_progress", runId, toolId, name: toolName, status, percent: percent ?? null, message: liveMessage, jobId });
    // Only push to the Activity log when the message actually changed —
    // otherwise we spam the timeline with N identical "Cutting selected section…" lines.
    if (toolName === "cut_video_clip" && baseMessage !== lastLogMsg) {
      sseEvent(res, { type: "tool_log", runId, toolId, name: toolName, message: liveMessage, level: "info" });
      lastLogMsg = baseMessage;
    }
```

---

## 8. LRU Job Cache ID Dropping

*   **Location**: `scanKnownJobIds` function (Lines 1832–1838)
*   **Issue**: Set insertion order is fixed. When jobs are re-referenced in conversation history, `ids.add(id)` has no effect, leaving the job ID at its initial position. The `[...ids].slice(-20)` call will drop recently-referenced older jobs.
*   **How to Fix**: Explicitly delete and re-add job IDs so they are bumped to the end of the Set insertion order.

### Original Code
```typescript
function scanKnownJobIds(req: any): string[] {
  const ids = new Set<string>();
  const text = conversationText(req);
  for (const match of text.matchAll(/\bjob(?:Id)?:?\s*([a-f0-9-]{8,})\b/gi)) ids.add(match[1]);
  for (const match of text.matchAll(/\/api\/(?:youtube\/file|subtitles\/status|translator\/status|translator\/result)\/([a-f0-9-]{8,})/gi)) ids.add(match[1]);
  return [...ids].slice(-20);
}
```

### Replacement Code
```typescript
function scanKnownJobIds(req: any): string[] {
  const ids = new Set<string>();
  const text = conversationText(req);
  const addId = (id: string) => {
    ids.delete(id);
    ids.add(id);
  };
  for (const match of text.matchAll(/\bjob(?:Id)?:?\s*([a-f0-9-]{8,})\b/gi)) addId(match[1]);
  for (const match of text.matchAll(/\/api\/(?:youtube\/file|subtitles\/status|translator\/status|translator\/result)\/([a-f0-9-]{8,})/gi)) addId(match[1]);
  return [...ids].slice(-20);
}
```

---

## 9. Markdown Closing Fence Corruption (Replacing Supported Canvas Blocks)

*   **Location**: `emitCanvasRoutedText` function inside route rendering (Lines 3449–3450)
*   **Issue**: The closing fence regex `replace(/\n```[ \t]*(\r?\n|$)/g, "\n</canvas>\n")` is executed globally, turning any standard un-converted code fence (e.g. bash) into `</canvas>`, causing markdown breaks.
*   **How to Fix**: Only apply the regex replacement if the router is currently inside an active canvas or if there is an unclosed `<canvas` tag in the buffer.

### Original Code
```typescript
        // Convert bare closing fence that follows converted canvas content
        canvasRouteBuf = canvasRouteBuf.replace(/\n```[ \t]*(\r?\n|$)/g, "\n</canvas>\n");
```

### Replacement Code
```typescript
        // Convert bare closing fence that follows converted canvas content
        if (activeCanvas || /<canvas\b[^>]*>(?:(?!<\/canvas>)[\s\S])*$/i.test(canvasRouteBuf)) {
          canvasRouteBuf = canvasRouteBuf.replace(/\n```[ \t]*(\r?\n|$)/g, "\n</canvas>\n");
        }
```
