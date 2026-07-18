import assert from "node:assert/strict";
import test from "node:test";
import {
  getArtifactValidationError,
  getCleanAgentErrorMessage,
} from "./agent-tool-events";

test("getArtifactValidationError requires download artifacts to include a downloadUrl", () => {
  assert.equal(
    getArtifactValidationError({
      artifactType: "download",
      label: "Ready",
    }),
    "download artifact is missing downloadUrl",
  );
});

test("getArtifactValidationError accepts valid image artifacts", () => {
  assert.equal(
    getArtifactValidationError({
      artifactType: "image",
      label: "Image",
      imageUrl: "https://example.com/image.png",
    }),
    null,
  );
});

test("getCleanAgentErrorMessage extracts embedded Gemini error payloads", () => {
  assert.equal(
    getCleanAgentErrorMessage(
      'got status: UNAVAILABLE. {"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}',
    ),
    "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
  );
});

test("getCleanAgentErrorMessage never exposes provider or schema internals", () => {
  assert.equal(
    getCleanAgentErrorMessage(
      "Groq request failed (400): invalid JSON schema for tool get_video_info, tools[0].function.parameters: params.json compilation failed",
    ),
    "AI models are temporarily unavailable. Please retry in a moment.",
  );
  assert.equal(
    getCleanAgentErrorMessage(
      "NVIDIA NIM request failed (429): account rate limited",
    ),
    "AI models are temporarily unavailable. Please retry in a moment.",
  );
});
