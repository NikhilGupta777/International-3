import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("agent prompt keeps short subtitle examples in chat and routes substantial artifacts to canvas", () => {
  assert.match(source, /more than 5 subtitle cues/);
  assert.match(source, /5 cues or fewer in a normal fenced code block/);
  assert.match(source, /complete HTML website\/page/);
  assert.match(source, /longer than 15 lines/);
  assert.match(source, /15 lines or fewer[\s\S]*normal chat code box/);
  assert.match(source, /user explicitly asks to open in canvas/);
  assert.doesNotMatch(source, /Triple backticks break the UI/);
});

test("canvas stream routing retains partial opening markers across chunks", () => {
  assert.match(source, /longest suffix[\s\S]*could still become "<canvas"/);
  assert.match(source, /openToken\.startsWith\(lower\.slice\(-length\)\)/);
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
