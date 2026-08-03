# Instagram Downloads in Super Agent

## Goal

Allow Super Agent to download supported Instagram posts, reels, and video URLs through the existing `download_video` tool, with the same completion polling and delivered file link used for YouTube downloads.

## Scope

- Full Instagram video downloads from supported post/reel/video URLs.
- Existing quality choices: best, 1080p, 720p, 480p, 360p, and audio.
- Explicit agent instructions that route Instagram download requests to `download_video`.
- Early URL validation and a clear unsupported-link error.
- No change to YouTube behavior.

Instagram captions, transcript analysis, subtitle operations, and clip cutting remain unsupported and must continue to be described as YouTube-only.

## Design

### Tool contract

Update the `download_video` tool declaration in `agent.ts` so its description and URL parameter explicitly accept either a YouTube video URL or a supported Instagram post/reel/video URL.

### Routing instructions

Update the Super Agent system prompt and compact model instructions so:

- A request to download an Instagram post, reel, or video routes directly to `download_video`.
- The agent does not send Instagram URLs to YouTube-only caption, transcript, analysis, subtitle, or clip-cutting tools.
- Existing YouTube routing remains unchanged.

### Runtime behavior

Before submitting the download job, classify the URL using the shared download-source policy already used by the Download tab. Accept strict YouTube video URLs and supported Instagram post/reel/video URLs. Reject Instagram profile pages and unrelated URLs with a concise, actionable error.

Continue submitting accepted jobs to the existing `/youtube/download` endpoint. Despite its legacy path name, this endpoint already supports and has been locally verified with both platforms. Keep the current job polling, timeout handling, quality mapping, completion payload, and file delivery URL unchanged.

### Testing

Add focused unit coverage for the agent download request policy before changing production behavior:

- Accept an Instagram reel URL.
- Accept an Instagram post URL.
- Accept an existing YouTube video URL.
- Reject an Instagram profile URL.
- Reject unrelated URLs.
- Preserve every existing quality-to-format mapping.

Then run the relevant API test suite, type checking/build validation, and a real local server test that asks the agent to download an Instagram video and verifies that the completed file is a non-empty playable media response. Re-run a YouTube download as a regression check.

## Error handling

- Unsupported URLs fail before job submission with a clear supported-platform message.
- Provider/job failures continue through the existing agent tool-error path.
- Polling timeouts retain the existing timeout response.
- No credentials, cookies, or provider internals are exposed in agent output.

## Files expected to change

- `artifacts/api-server/src/routes/agent.ts`
- `artifacts/api-server/src/lib/agent-model-instructions.ts`
- A focused agent-download policy helper and its test, if needed to keep validation and quality mapping independently testable.

No frontend change is required because Studio Copilot already renders `download_video` progress and completed downloads generically.
