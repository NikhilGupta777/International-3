import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inferCanvasLanguage, shouldPromoteFencedBlockToCanvas } from "./copilot-canvas-policy";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../components/StudioCopilot.tsx"),
  "utf8",
);

test("stale requests cannot update or clear the active stream", () => {
  assert.match(source, /if \(activeRequestIdRef\.current !== requestId\) return/);
  assert.match(source, /if \(activeRequestIdRef\.current === requestId\) \{[\s\S]*?setStreaming\(false\)/);
  assert.match(source, /signal: requestController\.signal/);
});

test("composer is IME-safe and core icon controls have accessible labels", () => {
  assert.match(source, /nativeEvent\.isComposing/);
  assert.match(source, /aria-label="Message Super Agent"/);
  assert.match(source, /aria-label="Stop generating response"/);
  assert.match(source, /aria-label="Remove active skill"/);
});

test("code blocks expose copy, download, wrapping, and canvas actions", () => {
  assert.match(source, /aria-label=\{copied \? "Code copied" : "Copy code"\}/);
  assert.match(source, /aria-label=\{`Download \$\{filename\}`\}/);
  assert.match(source, /aria-label="Open code in canvas"/);
  assert.match(source, /aria-label=\{wrapped \? "Disable code wrapping" : "Wrap code"\}/);
});

test("canvas policy promotes subtitles, full HTML pages, and code over 15 lines", () => {
  const shortCode = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n");
  const longCode = `${shortCode}\nline 16`;
  const unlabelledSrt = "1\n00:00:01,000 --> 00:00:02,000\nHello";
  const plainVtt = "WEBVTT\n\n00:01.000 --> 00:02.000\nHello";

  assert.equal(shouldPromoteFencedBlockToCanvas("js", shortCode), false);
  assert.equal(shouldPromoteFencedBlockToCanvas("js", longCode), true);
  assert.equal(shouldPromoteFencedBlockToCanvas("", unlabelledSrt), true);
  assert.equal(shouldPromoteFencedBlockToCanvas("text", plainVtt), true);
  assert.equal(shouldPromoteFencedBlockToCanvas("html", "<div>Small snippet</div>"), false);
  assert.equal(shouldPromoteFencedBlockToCanvas("", "<!doctype html><html><body>Site</body></html>"), true);
  assert.equal(inferCanvasLanguage("", unlabelledSrt), "srt");
  assert.equal(inferCanvasLanguage("text", plainVtt), "vtt");
});

test("session switching and edit cancellation clear edit-owned attachments", () => {
  assert.match(source, /onPickSession=\{\(id\) => \{[\s\S]*?if \(editingMessageId\)[\s\S]*?setPendingAttachments\(\[\]\)/);
  assert.match(source, /aria-label="Cancel editing message"[\s\S]*?setPendingAttachments\(\[\]\)/);
});
