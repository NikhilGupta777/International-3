// Dependency-free security verification for the API-key route allowlist + scope
// model. Bundles the REAL source (src/lib/api-key-auth.ts) with esbuild and
// asserts the access-control properties. Run:
//
//   pnpm --filter ./artifacts/api-server run verify:scopes
//
// Exits non-zero on any failure so it can gate CI.

import { build } from "esbuild";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { rmSync } from "node:fs";
import path from "node:path";

// Emit the bundle inside the package so Node can resolve the externalized
// @aws-sdk/* imports from the local node_modules tree.
const outfile = path.join(process.cwd(), `.verify-scopes-${Date.now()}.mjs`);

await build({
  entryPoints: ["src/lib/api-key-auth.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["@aws-sdk/*"],
  outfile,
  logLevel: "silent",
});

const mod = await import(pathToFileURL(outfile).href);
const { apiKeyAllowsPath, validateScopes, PUBLIC_API_SEGMENTS } = mod;
rmSync(outfile, { force: true });

const keyWith = (scopes) => ({
  keyId: "k",
  prefix: "vms_live_x",
  name: "t",
  ownerEmail: "a@b.c",
  scopes,
  status: "active",
  createdAt: 0,
  createdBy: "a@b.c",
});

let failures = 0;
const check = (label, actual, expected) => {
  try {
    assert.equal(actual, expected);
    console.log(`  ok   ${label}`);
  } catch {
    failures++;
    console.error(`  FAIL ${label} (got ${actual}, expected ${expected})`);
  }
};

console.log("Internal segments must be DENIED even for a wildcard '*' key:");
const star = keyWith(["*"]);
for (const p of [
  "/workspace/x",
  "/video-editor/render",
  "/ops/metrics",
  "/ops/alerts",
  "/notebook/ask/stream",
  "/pitaji/analyze",
  "/notifications/subscribe",
  "/admin/overview",
  "/keys",
]) {
  check(`* denied ${p}`, apiKeyAllowsPath(star, p), false);
}

console.log("\nPublic segments must be ALLOWED for a wildcard '*' key:");
for (const p of [
  "/youtube/clips",
  "/youtube/download",
  "/youtube/timestamps",
  "/subtitles/generate-from-url",
  "/translator/translate",
  "/uploads/presign",
  "/thumbnail/chat",
  "/agent/chat",
  "/bhagwat/analyze",
  "/v1/clips",
]) {
  check(`* allowed ${p}`, apiKeyAllowsPath(star, p), true);
}

console.log("\nGranular least-privilege (youtube:clips):");
const clipsOnly = keyWith(["youtube:clips"]);
check("clips key -> /youtube/clips allowed", apiKeyAllowsPath(clipsOnly, "/youtube/clips"), true);
check("clips key -> /youtube/download DENIED", apiKeyAllowsPath(clipsOnly, "/youtube/download"), false);
check("clips key -> /youtube/clip-cut DENIED", apiKeyAllowsPath(clipsOnly, "/youtube/clip-cut"), false);
check("clips key -> /youtube/cancel/123 allowed (shared op)", apiKeyAllowsPath(clipsOnly, "/youtube/cancel/123"), true);
check("clips key -> /youtube/file/123 allowed (shared op)", apiKeyAllowsPath(clipsOnly, "/youtube/file/123"), true);
check("clips key -> /subtitles/x DENIED", apiKeyAllowsPath(clipsOnly, "/subtitles/x"), false);

console.log("\nService-level youtube scope grants all youtube ops:");
const yt = keyWith(["youtube"]);
check("youtube -> download", apiKeyAllowsPath(yt, "/youtube/download"), true);
check("youtube -> timestamps", apiKeyAllowsPath(yt, "/youtube/timestamps"), true);
check("youtube -> subtitles DENIED", apiKeyAllowsPath(yt, "/subtitles/x"), false);

console.log("\nOther-service sub-scopes:");
const subs = keyWith(["subtitles:create"]);
check("subtitles:create -> /subtitles/x", apiKeyAllowsPath(subs, "/subtitles/generate-from-url"), true);
check("subtitles:create -> /youtube/x DENIED", apiKeyAllowsPath(subs, "/youtube/download"), false);

console.log("\nScope validation rejects unknown/internal scopes:");
assert.throws(() => validateScopes(["workspace"]), /Unknown scope/);
console.log("  ok   validateScopes rejects 'workspace'");
assert.throws(() => validateScopes(["ops"]), /Unknown scope/);
console.log("  ok   validateScopes rejects 'ops'");
assert.deepEqual(validateScopes(["youtube:clips", "youtube:clips", " subtitles "]), ["youtube:clips", "subtitles"]);
console.log("  ok   validateScopes de-dupes + trims valid scopes");

console.log(`\nPUBLIC_API_SEGMENTS = [${[...PUBLIC_API_SEGMENTS].join(", ")}]`);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll API-key access-control checks passed.");
