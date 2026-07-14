import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(root, "../App.tsx"), "utf8");
const sidebarSource = readFileSync(join(root, "../components/layout/Sidebar.tsx"), "utf8");

test("login never puts credentials in a request URL", () => {
  assert.match(appSource, /fetch\(`\$\{base}\/api\/auth\/login`,/);
  assert.doesNotMatch(appSource, /auth\/login\?username|encodeURIComponent\(password\)/);
});

test("login fields and errors expose accessible semantics", () => {
  assert.match(appSource, /htmlFor="studio-username"/);
  assert.match(appSource, /name="username"/);
  assert.match(appSource, /htmlFor="studio-password"/);
  assert.match(appSource, /role="alert" aria-live="assertive"/);
});

test("closed mobile navigation is absent and the trigger exposes state", () => {
  assert.match(sidebarSource, /aria-expanded=\{drawerOpen\}/);
  assert.match(sidebarSource, /aria-controls="studio-mobile-navigation"/);
  assert.match(sidebarSource, /\{drawerOpen && <nav/);
  assert.match(sidebarSource, /event\.key === "Escape"/);
});
