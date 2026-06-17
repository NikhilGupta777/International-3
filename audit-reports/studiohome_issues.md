# Technical Audit & Replacement Guide: StudioHome.tsx

This document contains the location, description, original code block, and exact replacement block for each issue identified in `artifacts/yt-downloader/src/components/StudioHome.tsx`.

---

## 1. Submit Race Condition

*   **Location**: `submit` function (Lines 121–128), form submit handler (Line 352), and `onKeyDown` handler (Lines 380–385)
*   **Issue**: Users can submit prompts while an attachment is still uploading. This submits an empty or partial message, and the attachment URL is appended later, breaking conversation flow.
*   **How to Fix**: Add a check for `!uploading` in both keypress and form submission handlers to block submission during uploads.

### Original Code (submit)
```typescript
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onLaunchAgent(t);
    setText("");
    setShowPlusMenu(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };
```

### Replacement Code (submit)
```typescript
  const submit = () => {
    if (uploading) return;
    const t = text.trim();
    if (!t) return;
    onLaunchAgent(t);
    setText("");
    setShowPlusMenu(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };
```

### Original Code (form & keyboard handlers)
```typescript
          onSubmit={e => { e.preventDefault(); submit(); }}
```
and
```typescript
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
```

### Replacement Code (form & keyboard handlers)
```typescript
          onSubmit={e => { e.preventDefault(); if (!uploading) submit(); }}
```
and
```typescript
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!uploading) submit();
                }
              }}
```

---

## 2. IME Premature Submission

*   **Location**: `onKeyDown` handler (Lines 380–385)
*   **Issue**: Pressing `Enter` to confirm characters in an IME keyboard (CJK languages) triggers form submission prematurely.
*   **How to Fix**: Prevent submission if `e.nativeEvent.isComposing` is true.

### Original Code
```typescript
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
```

### Replacement Code
```typescript
              onKeyDown={e => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!uploading) submit();
                }
              }}
```

---

## 3. Voice Input Stale Closure

*   **Location**: `toggleVoice` recognition result callback (Lines 145–155)
*   **Issue**: The voice event listener captures the initial text in a `baseline` variable. If the user types in the textarea while the voice input is running, their typed characters are overwritten by the stale `baseline` variable.
*   **How to Fix**: Use a state updater callback `setText(prev => ...)` instead of capturing a static `baseline` variable.

### Original Code
```typescript
    let baseline = text;
    rec.onresult = (e: any) => {
      let chunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) chunk += e.results[i][0].transcript;
      const next = (baseline + (baseline && !baseline.endsWith(" ") ? " " : "") + chunk).trimStart();
      setText(next);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
      }
    };
```

### Replacement Code
```typescript
    rec.onresult = (e: any) => {
      let chunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) chunk += e.results[i][0].transcript;
      setText(prev => {
        const base = prev.trim();
        return (base + (base && !base.endsWith(" ") ? " " : "") + chunk).trimStart();
      });
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
          textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
        }
      });
    };
```

---

## 4. Concurrent Upload State Breakage

*   **Location**: `uploading` state declaration (Line 164) and usage in `uploadFile` (Lines 194 & 213)
*   **Issue**: `uploading` is stored as a boolean. In parallel uploads, the first one to finish sets `uploading = false`, unlocking send options while the other upload is still running.
*   **How to Fix**: Replace the boolean state with an active upload counter `activeUploads`.

### Original Code
```typescript
  const [uploading, setUploading] = useState(false);
```
and
```typescript
    try {
      setUploading(true);
      ...
    } finally {
      setUploading(false);
    }
```

### Replacement Code
```typescript
  const [activeUploads, setActiveUploads] = useState(0);
  const uploading = activeUploads > 0;
```
and
```typescript
    try {
      setActiveUploads(prev => prev + 1);
      ...
    } finally {
      setActiveUploads(prev => Math.max(0, prev - 1));
    }
```

---

## 5. Clipboard Image + Text Drop

*   **Location**: `handlePaste` function (Lines 229–242)
*   **Issue**: If a user pastes both an image and text, `e.preventDefault()` is called, swallowing the text completely.
*   **How to Fix**: Extract the text item from the clipboard and append it manually before preventing the default behavior.

### Original Code
```typescript
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(i => i.type.startsWith("image/"));
    if (!imageItem) return; // let normal text paste through
    e.preventDefault();
    const rawFile = imageItem.getAsFile();
```

### Replacement Code
```typescript
  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(i => i.type.startsWith("image/"));
    if (!imageItem) return; // let normal text paste through

    // Extract co-pasted text if present
    const textItem = items.find(i => i.type === "text/plain");
    if (textItem) {
      textItem.getAsString(str => {
        setText(prev => prev ? prev + "\n" + str : str);
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + "px";
          }
        });
      });
    }

    e.preventDefault();
    const rawFile = imageItem.getAsFile();
```

---

## 6. Batch File Upload UI Flicker

*   **Location**: `handleFileUpload` function (Lines 217–227)
*   **Issue**: Sequential file uploads flip the `uploading` state back and forth, causing the loading animation to blink/flicker.
*   **How to Fix**: Split the upload logic into `uploadFileInternal`, and increment `activeUploads` by `files.length` at the start of the batch.

### Original Code
```typescript
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    try {
      for (const file of files) await uploadFile(file);
    } finally {
      // Always reset the input — without this, picking the same file twice
      // in a row silently no-ops because `change` doesn't fire on identical values.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
```

### Replacement Code
```typescript
  // 1. Rename existing uploadFile function to uploadFileInternal and remove setActiveUploads/setUploading from it.
  // 2. Define uploadFile wrap and batch handleFileUpload:

  const uploadFile = async (file: File) => {
    try {
      setActiveUploads(prev => prev + 1);
      await uploadFileInternal(file);
    } finally {
      setActiveUploads(prev => Math.max(0, prev - 1));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    try {
      setActiveUploads(prev => prev + files.length);
      for (const file of files) {
        try {
          await uploadFileInternal(file);
        } finally {
          setActiveUploads(prev => Math.max(0, prev - 1));
        }
      }
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
```

---

## 7. Stale DOM Height Calculation

*   **Location**: `<textarea>` onChange handler (Lines 375–379)
*   **Issue**: Measuring `scrollHeight` happens synchronously after calling `setText`, before React has updated the DOM with the new value. The height calculation is always one character render cycle behind.
*   **How to Fix**: Wrap the height adjustment in `requestAnimationFrame` so it runs after the browser applies DOM updates.

### Original Code
```typescript
              onChange={e => {
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
```

### Replacement Code
```typescript
              onChange={e => {
                const target = e.target;
                setText(target.value);
                requestAnimationFrame(() => {
                  target.style.height = "auto";
                  target.style.height = Math.min(target.scrollHeight, 160) + "px";
                });
              }}
```

---

## 8. Placeholder Text Overflow

*   **Location**: Placeholder rendering container style (Lines 358–363)
*   **Issue**: If the window is narrow, the absolute positioned animated placeholder wraps to a second line and overlaps other elements.
*   **How to Fix**: Add overflow constraints to keep the placeholder on a single line.

### Original Code
```typescript
                style={{
                  position: "absolute", left: "12px", top: "12px", right: "12px",
                  color: "rgba(255,255,255,0.3)", pointerEvents: "none",
                  whiteSpace: "pre-wrap", zIndex: 1, background: "transparent",
                  border: "none", boxShadow: "none",
                }}
```

### Replacement Code
```typescript
                style={{
                  position: "absolute", left: "12px", top: "12px", right: "12px",
                  color: "rgba(255,255,255,0.3)", pointerEvents: "none",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  zIndex: 1, background: "transparent",
                  border: "none", boxShadow: "none",
                }}
```
