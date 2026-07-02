import test from "node:test";
import assert from "node:assert/strict";
import {
  mapYtDlpEntriesToScrapedVideos,
  normalizeYouTubeChannelInput,
} from "./youtube-content-scraper";

test("normalizeYouTubeChannelInput accepts handles and channel URLs", () => {
  assert.equal(normalizeYouTubeChannelInput("@malikanews"), "https://www.youtube.com/@malikanews/videos");
  assert.equal(
    normalizeYouTubeChannelInput("https://www.youtube.com/@malikanews"),
    "https://www.youtube.com/@malikanews/videos",
  );
  assert.equal(
    normalizeYouTubeChannelInput("https://www.youtube.com/channel/UC123456789/videos"),
    "https://www.youtube.com/channel/UC123456789/videos",
  );
});

test("mapYtDlpEntriesToScrapedVideos keeps public metadata and caps to 50", () => {
  const entries = Array.from({ length: 55 }, (_, index) => ({
    id: `abc${index}`,
    webpage_url: `https://www.youtube.com/watch?v=abc${index}`,
    title: `Video ${index}`,
    description: `Description ${index}`,
    tags: ["delhi", `tag-${index}`],
    upload_date: "20260701",
    duration: 700 + index,
    view_count: 1000 + index,
    like_count: 50 + index,
    comment_count: 5 + index,
    thumbnail: `https://img.youtube.com/vi/abc${index}/hqdefault.jpg`,
  }));

  const videos = mapYtDlpEntriesToScrapedVideos(entries);

  assert.equal(videos.length, 50);
  assert.equal(videos[0].id, "abc0");
  assert.equal(videos[0].publishedAt, "2026-07-01T00:00:00Z");
  assert.deepEqual(videos[0].tags, ["delhi", "tag-0"]);
  assert.equal(videos[49].title, "Video 49");
});
