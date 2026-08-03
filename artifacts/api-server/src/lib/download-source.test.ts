import test from "node:test";
import assert from "node:assert/strict";

import {
  getDownloadPlatform,
  getDownloadPlatformArgs,
  isInstagramUrl,
  isSupportedDownloadUrl,
} from "./download-source.js";

test("accepts supported YouTube video URLs", () => {
  assert.equal(getDownloadPlatform("https://youtu.be/dQw4w9WgXcQ"), "youtube");
  assert.equal(
    getDownloadPlatform("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "youtube",
  );
});

test("accepts Instagram video media URLs", () => {
  for (const url of [
    "https://www.instagram.com/p/ABC123/",
    "https://instagram.com/reel/ABC123/?igsh=example",
    "https://m.instagram.com/reels/ABC123/",
    "https://www.instagram.com/tv/ABC123/",
    "https://www.instagram.com/stories/example/123456789/",
  ]) {
    assert.equal(isInstagramUrl(url), true, url);
    assert.equal(isSupportedDownloadUrl(url), true, url);
  }
});

test("rejects profiles, lookalike hosts, and non-http URLs", () => {
  for (const url of [
    "https://www.instagram.com/example/",
    "https://www.youtube.com/",
    "https://www.youtube.com/@example",
    "https://youtu.be/",
    "https://instagram.com.evil.example/reel/ABC123/",
    "https://youtube.com.evil.example/watch?v=ABC123",
    "file:///tmp/video.mp4",
    "not a URL",
  ]) {
    assert.equal(isSupportedDownloadUrl(url), false, url);
  }
});

test("uses platform-specific request headers", () => {
  assert.deepEqual(
    getDownloadPlatformArgs("https://www.instagram.com/reel/ABC123/"),
    [
      "--add-headers",
      "Referer:https://www.instagram.com/",
      "--add-headers",
      "Origin:https://www.instagram.com",
    ],
  );
  assert.deepEqual(
    getDownloadPlatformArgs("https://youtu.be/dQw4w9WgXcQ"),
    [
      "--add-headers",
      "Referer:https://www.youtube.com/",
      "--add-headers",
      "Origin:https://www.youtube.com",
    ],
  );
});
