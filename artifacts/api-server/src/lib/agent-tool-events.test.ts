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
