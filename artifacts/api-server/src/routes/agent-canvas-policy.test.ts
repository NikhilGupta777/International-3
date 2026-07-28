import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const canvasStreamModuleUrl = new URL("./agent-canvas-stream.ts", import.meta.url);
const { findIncompleteCanvasOpeningTagStart } = (await import(
  canvasStreamModuleUrl.href
)) as typeof import("./agent-canvas-stream");

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "agent.ts"),
  "utf8",
);

test("short fenced code remains in chat instead of being rewritten server-side", () => {
  assert.doesNotMatch(
    source,
    /canvasRouteBuf\s*=\s*canvasRouteBuf\.replace\([\s\S]{0,300}```\(html\|css/,
  );
  assert.match(source, /Only the explicit hidden <canvas> protocol becomes a canvas/);
});

test("agent prompt always keeps subtitle output fenced for client-side canvas promotion", () => {
  assert.match(source, /Always output SRT and VTT subtitles in a normal markdown fenced code block/);
  assert.match(source, /regardless of cue count or whether the user asks for canvas/);
  assert.match(source, /Never wrap subtitles in the hidden <canvas> protocol/);
  assert.match(source, /UI promotes substantial subtitle blocks into a downloadable canvas automatically/);
  assert.doesNotMatch(source, /use canvas for long subtitle output/);
  assert.doesNotMatch(source, /text artifact\/canvas\/downloadable file/);
  assert.match(source, /Any non-subtitle fenced code or editable artifact longer than 15 lines/);
  assert.match(source, /SRT\/VTT always use fenced blocks instead/);
  assert.match(source, /complete HTML website\/page/);
  assert.match(source, /longer than 15 lines/);
  assert.match(source, /15 lines or fewer[\s\S]*normal chat code box/);
  assert.match(source, /user explicitly asks to open in canvas/);
  assert.doesNotMatch(source, /Triple backticks break the UI/);
});

test("canvas stream routing retains split tokens and incomplete attributes", () => {
  assert.equal(findIncompleteCanvasOpeningTagStart("Visible text <can"), 13);
  assert.equal(findIncompleteCanvasOpeningTagStart("<canvas"), 0);
  assert.equal(
    findIncompleteCanvasOpeningTagStart('<canvas\ntitle="English.srt"'),
    0,
  );
  assert.equal(
    findIncompleteCanvasOpeningTagStart(
      '<canvas\ntitle="English.srt"\nlanguage="text"',
    ),
    0,
  );
  assert.equal(findIncompleteCanvasOpeningTagStart("Visible <canvasx"), -1);
  assert.equal(
    findIncompleteCanvasOpeningTagStart('<canvas title="English.srt">'),
    -1,
  );
});

test("recorded canvas chunk sequence emits no hidden opening-tag text", () => {
  const chunks = [
    "<canvas",
    '\ntitle="EnglishSubtitles.srt"',
    '\nlanguage="text"',
    ">\n1\n00:00:00,080 --> 00:00:02,070\nLook, this is the beginning.",
  ];
  const openRe = /<canvas\b([^>]*)>/i;
  let buffer = "";
  let visible = "";
  let recognized = false;

  for (const chunk of chunks) {
    buffer += chunk;
    const open = openRe.exec(buffer);
    if (open) {
      recognized = true;
      buffer = buffer.slice((open.index || 0) + open[0].length);
      break;
    }
    const retainAt = findIncompleteCanvasOpeningTagStart(buffer);
    if (retainAt === -1) {
      visible += buffer;
      buffer = "";
    } else {
      visible += buffer.slice(0, retainAt);
      buffer = buffer.slice(retainAt);
    }
  }

  assert.equal(recognized, true);
  assert.equal(visible, "");
  assert.match(buffer, /^\n1\n00:00:00,080/);
});

test("disabled creative capabilities are exposed from the same server policy as tools", () => {
  assert.match(source, /createImage:\s*visibleToolNames\.has\("create_image"\)/);
  assert.match(source, /createMusic:\s*visibleToolNames\.has\("generate_music"\)/);
});

test("workspace artifact imports allow only trusted app paths or public HTTP URLs", () => {
  assert.match(source, /const isTrustedInternalArtifact = sourceUrl\.startsWith\("\/api\/"\)/);
  assert.match(source, /Only app \/api\/ artifact paths may be saved by relative URL/);
  assert.match(source, /buildArtifactFetchInit\([\s\S]*?isTrustedInternalArtifact/);
  assert.match(source, /fetchPublicUrl\(resolvedUrl, artifactFetchInit\)/);
});
