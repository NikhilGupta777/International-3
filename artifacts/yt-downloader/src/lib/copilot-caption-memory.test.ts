import assert from "node:assert/strict";
import test from "node:test";
import {
  FULL_CAPTION_USER_MESSAGE_WINDOW,
  captionResultForHistory,
} from "./copilot-caption-memory";

const captionPart = (content: string) => ({
  kind: "tool_start",
  name: "get_youtube_captions",
  done: true,
  result: { filename: "subtitles.srt", content, fullContentInContext: true },
});

test("keeps the newest caption result complete through seven subsequent user messages", () => {
  const caption = captionPart("FULL TRANSCRIPT");
  const messages = [
    { role: "assistant", parts: [caption] },
    ...Array.from({ length: FULL_CAPTION_USER_MESSAGE_WINDOW }, () => ({ role: "user", parts: [] })),
  ];

  assert.equal((captionResultForHistory(messages, 0, caption) as any).content, "FULL TRANSCRIPT");
});

test("compacts the newest caption result after the seventh subsequent user message", () => {
  const caption = captionPart("FULL TRANSCRIPT");
  const messages = [
    { role: "assistant", parts: [caption] },
    ...Array.from({ length: FULL_CAPTION_USER_MESSAGE_WINDOW + 1 }, () => ({ role: "user", parts: [] })),
  ];

  const result = captionResultForHistory(messages, 0, caption) as any;
  assert.equal(result.content, undefined);
  assert.equal(result.contentOmittedReason, "expired");
});

test("a newer caption fetch immediately compacts the previous caption only", () => {
  const previous = captionPart("OLD FULL TRANSCRIPT");
  const newest = captionPart("NEW FULL TRANSCRIPT");
  const messages = [
    { role: "assistant", parts: [previous] },
    { role: "user", parts: [] },
    { role: "assistant", parts: [newest] },
    { role: "user", parts: [] },
  ];

  const oldResult = captionResultForHistory(messages, 0, previous) as any;
  const newResult = captionResultForHistory(messages, 2, newest) as any;
  assert.equal(oldResult.content, undefined);
  assert.equal(oldResult.contentOmittedReason, "superseded");
  assert.equal(newResult.content, "NEW FULL TRANSCRIPT");
});

test("does not alter ordinary tool results", () => {
  const part = { kind: "tool_start", name: "get_video_info", done: true, result: { content: "normal" } };
  assert.equal(captionResultForHistory([{ role: "assistant", parts: [part] }], 0, part), part.result);
});
