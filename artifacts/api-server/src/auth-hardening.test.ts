import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.ts"), "utf8");
const pitajiAuthSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "lib/pitaji-auth.ts"),
  "utf8",
);

test("password login accepts credentials from the request body only", () => {
  const extractor = source.match(/function extractLoginCredentials[\s\S]*?\/\/ Minimal security headers/)?.[0] ?? "";
  assert.ok(extractor, "expected credential extractor source");
  assert.doesNotMatch(extractor, /req\.query|query\.username|query\.password/);
  assert.match(source, /app\.post\("\/api\/auth\/login"[\s\S]*?loginRateLimiter\.check/);
});

test("Pita Ji credentials are also body-only", () => {
  assert.doesNotMatch(pitajiAuthSource, /req\.query|query\.username|query\.password/);
  assert.match(pitajiAuthSource, /never accepted from query parameters/);
});

test("anonymous auth endpoints are not globally blocked by allowlist hydration", () => {
  assert.doesNotMatch(source, /app\.use\(async \(_req[\s\S]*?await allowlistHydrationPromise/);
  assert.match(source, /if \(session\.email\) await allowlistHydrationPromise/);
  assert.match(source, /app\.use\("\/api\/admin"[\s\S]*?await allowlistHydrationPromise/);
});

test("CORS and proxy trust use explicit production configuration", () => {
  assert.match(source, /allowedCorsOrigins\.has\(origin\)/);
  assert.doesNotMatch(source, /app\.use\(cors\(\)\)/);
  assert.doesNotMatch(source, /app\.set\("trust proxy", true\)/);
  assert.match(source, /app\.disable\("x-powered-by"\)/);
});

test("Google ID tokens are verified without placing credentials in URLs", () => {
  assert.match(source, /googleOAuthClient\.verifyIdToken/);
  assert.doesNotMatch(source, /tokeninfo\?id_token|encodeURIComponent\(idToken\)/);
});

test("cookie-authenticated mutations reject cross-site browser requests", () => {
  assert.match(source, /function isTrustedBrowserMutation/);
  assert.match(source, /sec-fetch-site/);
  assert.match(source, /if \(isAuthenticated\(req\)\) \{[\s\S]*?!isTrustedBrowserMutation\(req\)/);
  assert.match(source, /req\.path\.startsWith\("\/pitaji\/"\)[\s\S]*?!isTrustedBrowserMutation\(req\)/);
  assert.match(source, /app\.post\("\/api\/email-submissions"[\s\S]*?!isTrustedBrowserMutation\(req\)/);
});
