import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContentManagerModelContext,
  buildScrapedChannelProfile,
  type ScrapedVideoInput,
} from "./youtube-content-profile";

function video(index: number, overrides: Partial<ScrapedVideoInput> = {}): ScrapedVideoInput {
  const day = String((index % 28) + 1).padStart(2, "0");
  const hour = String((index % 6) + 12).padStart(2, "0");
  return {
    id: `vid-${index}`,
    url: `https://www.youtube.com/watch?v=vid-${index}`,
    title: `Delhi border update ${index}`,
    description: `Full description for video ${index}`,
    tags: [`tag-${index}`, "delhi", index % 2 === 0 ? "border" : "protest"],
    publishedAt: `2026-06-${day}T${hour}:30:00Z`,
    durationSec: 600 + index,
    viewCount: 1000 + index * 100,
    likeCount: 50 + index,
    commentCount: 10 + index,
    thumbnailUrl: `https://img.youtube.com/vi/vid-${index}/hqdefault.jpg`,
    ...overrides,
  };
}

test("buildScrapedChannelProfile stores 50 video summaries but full descriptions only for the newest 8", () => {
  const inputs = Array.from({ length: 60 }, (_, i) => video(i + 1));

  const profile = buildScrapedChannelProfile({
    channelName: "Malika News",
    channelInput: "https://www.youtube.com/@malikanews",
    videos: inputs,
  });

  assert.equal(profile.recentVideos.length, 50);
  assert.equal(profile.recentDescriptions.length, 8);
  assert.deepEqual(
    profile.recentDescriptions.map((item) => item.videoId),
    inputs.slice(0, 8).map((item) => item.id),
  );
  assert.equal(profile.recentVideos[0].title, "Delhi border update 1");
  assert.equal(profile.recentVideos[49].title, "Delhi border update 50");
  assert.deepEqual(profile.recentVideos[49].tags, ["tag-50", "delhi", "border"]);
  assert.equal(profile.recentVideos[49].description, undefined);
});

test("buildScrapedChannelProfile derives public analytics without private YouTube Studio claims", () => {
  const profile = buildScrapedChannelProfile({
    channelName: "Malika News",
    channelInput: "@malikanews",
    videos: [
      video(1, { title: "Border tension big update", viewCount: 9000, tags: ["border", "delhi"] }),
      video(2, { title: "Protest latest update", viewCount: 1000, tags: ["protest", "delhi"] }),
      video(3, { title: "Border meeting news", viewCount: 8000, tags: ["border", "government"] }),
    ],
  });

  assert.match(profile.analyticsSummary.topTags.join(","), /border/);
  assert.match(profile.analyticsSummary.highPerformingTopics.join(","), /Border/);
  assert.ok(profile.analyticsSummary.bestObservedUploadWindows.length > 0);
  assert.doesNotMatch(JSON.stringify(profile.analyticsSummary), /ctr|retention|impression/i);
});

test("buildContentManagerModelContext includes full channel data and marks live research preference", () => {
  const profile = buildScrapedChannelProfile({
    channelName: "Malika News",
    channelInput: "@malikanews",
    videos: Array.from({ length: 10 }, (_, i) => video(i + 1)),
  });

  const context = buildContentManagerModelContext({
    profile,
    topic: "Delhi clashes and border tension",
  });

  assert.match(context, /Delhi clashes and border tension/);
  assert.match(context, /RECENT 50 VIDEO SUMMARIES/);
  assert.match(context, /RECENT FULL DESCRIPTIONS \(MAX 8\)/);
  assert.match(context, /call request_content_pack/);
});
