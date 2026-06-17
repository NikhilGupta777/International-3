# Technical Audit & Replacement Guide: PitajiLiveAgent.tsx

This document contains the location, description, original code block, and exact replacement block for each issue identified in `artifacts/yt-downloader/src/components/pitaji/PitajiLiveAgent.tsx`.

---

## 1. Local Clip Edits Ignored (Custom bounds cut)

*   **Location**: `dispatch` function (Lines 265–276)
*   **Issue**: When the operator adjusts clip bounds (modifying the React `clips` state) and clicks cut, the dispatcher only sends the clip IDs (`ids`). The backend ignores these manual adjustments and cuts the original bounds from the database.
*   **How to Fix**: Update `dispatch` and `dispatchPitajiClips` to send the edited bounds of each selected clip, and update the API payload to `{ clips: selectedClips, action }`.

### Original Code
```typescript
      const ids = clips.filter((c) => keep.has(c.id)).map((c) => c.id);
      if (ids.length === 0) return;
      setDispatching(true);
      ...
      try {
        toast("info", `Queued ${ids.length} selected clip${ids.length === 1 ? "" : "s"}`);
        const resp = await dispatchPitajiClips(jobId, ids, action);
```

### Replacement Code
```typescript
      const selectedClips = clips.filter((c) => keep.has(c.id));
      if (selectedClips.length === 0) return;
      setDispatching(true);
      ...
      try {
        toast("info", `Queued ${selectedClips.length} selected clip${selectedClips.length === 1 ? "" : "s"}`);
        // Send full clip details (including custom startSec/endSec bounds) to the API
        const resp = await dispatchPitajiClips(jobId, selectedClips, action);
```
*(Also update the request signature in `lib/pitaji-api.ts` to accept `clips: PitajiClip[]` and serialize it)*

---

## 2. Refine Action Recheckes Unchecked Clips

*   **Location**: `refine` event handler callback for `summary` (Lines 391–404)
*   **Issue**: Preserving kept clips across refines compares `!prev.has(c.id)`. Since `prev` only tracks *currently checked* clips, any clip explicitly unchecked by the user is treated as "new" and aggressively re-checked by the refine action.
*   **How to Fix**: Track against the previous clips array `clips` to only auto-check clips that are genuinely new.

### Original Code
```typescript
            case "summary":
              if (replacing) {
                setClips(nextClips);
                // Preserve the kept-set across refines for clips that still exist.
                setKeep((prev) => {
                  const validIds = new Set(nextClips.map((c) => c.id));
                  const next = new Set<string>();
                  for (const id of prev) if (validIds.has(id)) next.add(id);
                  // Newly added clips default to kept.
                  for (const c of nextClips) if (!prev.has(c.id)) next.add(c.id);
                  return next;
                });
              }
```

### Replacement Code
```typescript
            case "summary":
              if (replacing) {
                setClips(nextClips);
                // Preserve the kept-set across refines for clips that still exist.
                const existingClipIds = new Set(clips.map(c => c.id));
                setKeep((prev) => {
                  const validIds = new Set(nextClips.map((c) => c.id));
                  const next = new Set<string>();
                  for (const id of prev) if (validIds.has(id)) next.add(id);
                  // Newly added clips default to kept.
                  for (const c of nextClips) {
                    if (!existingClipIds.has(c.id)) {
                      next.add(c.id);
                    }
                  }
                  return next;
                });
              }
```

---

## 3. Missing Thumbnail Notifications in `both` Action

*   **Location**: `applyDispatchNotifications` function (Lines 108–130)
*   **Issue**: When the action is `"both"`, the code only inspects the cut status to show the success toast. Thumbnail completion notifications are entirely ignored.
*   **How to Fix**: Split status checks and state tracking so cut and thumbnail events generate separate toast notifications.

### Original Code
```typescript
  const applyDispatchNotifications = useCallback(
    (nextDispatches: PitajiDispatchView[]) => {
      for (const d of nextDispatches) {
        const currStatus = pitajiDispatchHasCut(d)
          ? pitajiDispatchCutStatus(d) ?? d.status ?? "unknown"
          : d.status ?? "unknown";
        const prevStatus = prevDispatchStatusRef.current.get(d.jobId);
        if (prevStatus && prevStatus !== "done" && currStatus === "done") {
          const title = d.clip.suggestedTitle || d.clip.title;
          const label = pitajiDispatchHasCut(d) ? "Clip ready" : "Thumbnail ready";
          toast("success", `${label}: ${title}`);
          pushChat("ok", `${label}: ${title}`);
        } else if (prevStatus && prevStatus !== "error" && currStatus === "error") {
          const title = d.clip.suggestedTitle || d.clip.title;
          toast("error", `Cut failed: ${title}`);
          pushChat("error", `Cut failed: ${title}`);
        }
        prevDispatchStatusRef.current.set(d.jobId, currStatus);
      }
      setDispatches(nextDispatches);
    },
    [pushChat, toast],
  );
```

### Replacement Code
```typescript
  const applyDispatchNotifications = useCallback(
    (nextDispatches: PitajiDispatchView[]) => {
      for (const d of nextDispatches) {
        // Track cut status
        if (d.action === "cut" || d.action === "both") {
          const currCutStatus = pitajiDispatchCutStatus(d) ?? d.status ?? "unknown";
          const prevCutStatus = prevDispatchStatusRef.current.get(`${d.jobId}-cut`);
          if (prevCutStatus && prevCutStatus !== "done" && currCutStatus === "done") {
            const title = d.clip.suggestedTitle || d.clip.title;
            toast("success", `Clip ready: ${title}`);
            pushChat("ok", `Clip ready: ${title}`);
          } else if (prevCutStatus && prevCutStatus !== "error" && currCutStatus === "error") {
            const title = d.clip.suggestedTitle || d.clip.title;
            toast("error", `Cut failed: ${title}`);
            pushChat("error", `Cut failed: ${title}`);
          }
          prevDispatchStatusRef.current.set(`${d.jobId}-cut`, currCutStatus);
        }

        // Track thumbnail status
        if (d.action === "thumbnail" || d.action === "both") {
          const currThumbStatus = d.thumbnailStatus ?? d.status ?? "unknown";
          const prevThumbStatus = prevDispatchStatusRef.current.get(`${d.jobId}-thumb`);
          if (prevThumbStatus && prevThumbStatus !== "done" && currThumbStatus === "done") {
            const title = d.clip.suggestedTitle || d.clip.title;
            toast("success", `Thumbnail ready: ${title}`);
            pushChat("ok", `Thumbnail ready: ${title}`);
          } else if (prevThumbStatus && prevThumbStatus !== "error" && currThumbStatus === "error") {
            const title = d.clip.suggestedTitle || d.clip.title;
            toast("error", `Thumbnail failed: ${title}`);
            pushChat("error", `Thumbnail failed: ${title}`);
          }
          prevDispatchStatusRef.current.set(`${d.jobId}-thumb`, currThumbStatus);
        }
      }
      setDispatches(nextDispatches);
    },
    [pushChat, toast],
  );
```

---

## 4. Duplicate Dispatches Overwriting Badge Tracking

*   **Location**: `dispatchByClip` useMemo map builder (Lines 85–92) and badge rendering (Lines 587–608)
*   **Issue**: `dispatchByClip` maps one dispatch per `clip.id`. Dispatching a Thumbnail and then a Cut replaces the Thumbnail's status tracking entirely, losing its badge representation and UI progress.
*   **How to Fix**: Restructure `dispatchByClip` to return both cut and thumbnail dispatches independently, and render them on separate badges.

### Original Code (dispatchByClip)
```typescript
  const dispatchByClip = useMemo(() => {
    const m = new Map<string, PitajiDispatchView>();
    for (const d of dispatches) {
      const existing = m.get(d.clip.id);
      if (!existing || d.updatedAt > existing.updatedAt) m.set(d.clip.id, d);
    }
    return m;
  }, [dispatches]);
```

### Replacement Code (dispatchByClip)
```typescript
  const dispatchByClip = useMemo(() => {
    const m = new Map<string, { cut?: PitajiDispatchView; thumbnail?: PitajiDispatchView }>();
    for (const d of dispatches) {
      const existing = m.get(d.clip.id) || {};
      if (d.action === "cut" || d.action === "both") {
        if (!existing.cut || d.updatedAt > existing.cut.updatedAt) existing.cut = d;
      }
      if (d.action === "thumbnail" || d.action === "both") {
        if (!existing.thumbnail || d.updatedAt > existing.thumbnail.updatedAt) existing.thumbnail = d;
      }
      m.set(d.clip.id, existing);
    }
    return m;
  }, [dispatches]);
```

### Original Code (badge variables in clips list)
```typescript
                const dispatchInfo = dispatchByClip.get(clip.id);
                const cutPct =
                  typeof dispatchInfo?.cutProgress?.progressPct === "number"
                    ? dispatchInfo.cutProgress.progressPct
                    : null;
                const hasCut = dispatchInfo ? pitajiDispatchHasCut(dispatchInfo) : false;
                const cutStatus = dispatchInfo ? pitajiDispatchCutStatus(dispatchInfo) : null;
                const cutReady = dispatchInfo ? pitajiDispatchCutReady(dispatchInfo) : false;
                const thumbnailReady = dispatchInfo ? pitajiDispatchThumbnailReady(dispatchInfo) : false;
                const thumbnailPending = Boolean(
                  dispatchInfo &&
                    (dispatchInfo.action === "thumbnail" || dispatchInfo.action === "both") &&
                    !thumbnailReady &&
                    !dispatchInfo.error &&
                    dispatchInfo.status !== "error",
                );
                const thumbnailFailed = Boolean(
                  dispatchInfo &&
                    (dispatchInfo.action === "thumbnail" || dispatchInfo.action === "both") &&
                    !thumbnailReady &&
                    dispatchInfo.error,
                );
```

### Replacement Code (badge variables in clips list)
```typescript
                const dispatchesForClip = dispatchByClip.get(clip.id);
                const cutDispatch = dispatchesForClip?.cut;
                const thumbDispatch = dispatchesForClip?.thumbnail;

                const cutPct =
                  typeof cutDispatch?.cutProgress?.progressPct === "number"
                    ? cutDispatch.cutProgress.progressPct
                    : null;
                const hasCut = !!cutDispatch;
                const cutStatus = cutDispatch ? pitajiDispatchCutStatus(cutDispatch) : null;
                const cutReady = cutDispatch ? pitajiDispatchCutReady(cutDispatch) : false;

                const thumbnailReady = thumbDispatch ? pitajiDispatchThumbnailReady(thumbDispatch) : false;
                const thumbnailPending = Boolean(
                  thumbDispatch &&
                    !thumbnailReady &&
                    !thumbDispatch.error &&
                    thumbDispatch.status !== "error",
                );
                const thumbnailFailed = Boolean(
                  thumbDispatch &&
                    !thumbnailReady &&
                    thumbDispatch.status === "error",
                );
```

---

## 5. Misleading Thumbnail Errors

*   **Location**: `thumbnailFailed` check (Lines 603–608)
*   **Issue**: A failure in clip cutting sets the unified `dispatchInfo.error`. Because `thumbnailFailed` checks `dispatchInfo.error`, it incorrectly lights up "Thumb failed" even if thumbnail generation succeeded.
*   **How to Fix**: Use the decoupled `thumbDispatch.status === "error"` instead of `dispatchInfo.error` (resolved by decoupling dispatches in Issue #4).

---

## 6. Silent Stream Error Swallowing

*   **Location**: `handleEvent` for error type (Lines 197–200) and `start` resolution (Line 239)
*   **Issue**: Receiving an `error` event prints it to chat and sets `error` state, but does not update `runState` to `"error"`. When the stream closes, `start()` sets `runState` to `"done"`, showing a green success state for a failed operation.
*   **How to Fix**: Set `runState` to `"error"` inside `handleEvent` on receiving an error event.

### Original Code
```typescript
        case "error":
          setError(evt.message);
          pushChat("error", evt.message);
          break;
```

### Replacement Code
```typescript
        case "error":
          setError(evt.message);
          pushChat("error", evt.message);
          setRunState("error");
          break;
```

---

## 7. Missing Abort Cleanups on Unmount

*   **Location**: Component initialization (Lines 94–102)
*   **Issue**: Starting refine or analysis starts long-lived streams/fetches. If the component unmounts mid-run, these continue in the background with no AbortController cleanup.
*   **How to Fix**: Add a cleanup `useEffect` that aborts any active controller when the component unmounts.

### Original Code
```typescript
  const abortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const prevDispatchStatusRef = useRef<Map<string, string>>(new Map());

  // Scroll chat to bottom on new lines.
  useEffect(() => {
    const node = chatScrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat]);
```

### Replacement Code
```typescript
  const abortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const prevDispatchStatusRef = useRef<Map<string, string>>(new Map());

  // Scroll chat to bottom on new lines.
  useEffect(() => {
    const node = chatScrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat]);

  // Clean up any active streams on component unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);
```
