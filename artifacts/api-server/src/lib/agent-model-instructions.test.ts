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
  assert.match(prompt, /Do not answer media-content questions/i);
});

test("getModelSpecificSystemPrompt does not add Gemma limitations to native media models", () => {
  assert.equal(getModelSpecificSystemPrompt("gemini-3.5-flash"), "");
});

test("getModelSpecificSystemPrompt routes GPT-OSS and Llama media through tools", () => {
  for (const model of ["gpt-oss:120b", "llama-3.1-8b-instant"]) {
    const prompt = getModelSpecificSystemPrompt(model);
    assert.match(prompt, /text-only agent model/i);
    assert.match(prompt, /call describe_image/i);
    assert.match(prompt, /call read_uploaded_file/i);
  }
});

test("getAnalyzeYoutubeVideoDescription allows text-only models to use the video analysis tool", () => {
  const description = getAnalyzeYoutubeVideoDescription("gemma-4-31b-it");

  assert.doesNotMatch(description, /TESTING ONLY/i);
  assert.match(description, /text-only agent models/i);
});

test("getAnalyzeYoutubeVideoDescription keeps native models on native video analysis", () => {
  const description = getAnalyzeYoutubeVideoDescription("gemini-3.5-flash");

  assert.match(description, /TESTING ONLY/i);
  assert.match(description, /native YouTube capabilities/i);
});
