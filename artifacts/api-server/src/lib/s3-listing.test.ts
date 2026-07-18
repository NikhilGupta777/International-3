import assert from "node:assert/strict";
import test from "node:test";

import { decodeS3ListedKey } from "./s3-listing";

test("decodes URL-encoded S3 listing keys including XML-hostile characters", () => {
  assert.equal(
    decodeS3ListedKey("workspace/subtitles/file%0D%23xD.txt"),
    "workspace/subtitles/file\r#xD.txt",
  );
  assert.equal(decodeS3ListedKey("folder/a%20b%2Bc.txt"), "folder/a b+c.txt");
});

test("leaves malformed percent sequences intact", () => {
  assert.equal(decodeS3ListedKey("folder/100%/file.txt"), "folder/100%/file.txt");
});
