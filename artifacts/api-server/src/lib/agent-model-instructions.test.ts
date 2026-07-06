import assert from "node:assert/strict";
import test from "node:test";
import {
  getAnalyzeYoutubeVideoDescription,
  getModelSpecificSystemPrompt,
} from "./agent-model-instructions";

test("getModelSpecificSystemPrompt tells Gemma to use tools for YouTube video analysis", () => {
  const prompt = getModelSpecificSystemPrompt("gemma-4-31b-it");

  assert.match(prompt, /CANNOT natively watch/i);
  assert.match(prompt, /call analyze_youtube_video/i);
  assert.match(prompt, /Do not answer video-content questions from the URL alone/i);
});

test("getModelSpecificSystemPrompt does not add Gemma limitations to native media models", () => {
  assert.equal(getModelSpecificSystemPrompt("gemini-3.5-flash"), "");
});

test("getAnalyzeYoutubeVideoDescription allows Gemma to use the video analysis tool", () => {
  const description = getAnalyzeYoutubeVideoDescription("gemma-4-31b-it");

  assert.doesNotMatch(description, /TESTING ONLY/i);
  assert.match(description, /Use this for Gemma/i);
});

test("getAnalyzeYoutubeVideoDescription keeps native models on native video analysis", () => {
  const description = getAnalyzeYoutubeVideoDescription("gemini-3.5-flash");

  assert.match(description, /TESTING ONLY/i);
  assert.match(description, /native YouTube capabilities/i);
});
