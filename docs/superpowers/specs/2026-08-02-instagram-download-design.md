# Instagram Download Support Design

## Goal

Extend the existing Download tab so it accepts YouTube videos and Instagram video posts/reels while preserving current YouTube behavior.

## Scope

- Show “YouTube and Instagram supported” at the top of the Download tab.
- Accept YouTube video URLs and Instagram `/p/`, `/reel/`, `/reels/`, `/tv/`, and `/stories/` media URLs.
- Reject Instagram profiles, lookalike domains, non-HTTP URLs, and photo-only posts.
- Use yt-dlp for metadata and downloads through both the API process and queue worker.
- Apply platform-specific request headers.
- Pass a single managed Netscape cookie bundle containing only the existing downloader cookies plus Instagram-domain cookies from `C:/Users/g_n-n/Downloads/cookies (8).txt`.
- Hide YouTube subtitle controls for Instagram results.
- Do not add Instagram support to unrelated tabs such as subtitles, clips, timestamps, or content management.

## Architecture

A small API library owns supported-source detection and platform header construction. The API info/download routes validate against it, while the queue worker mirrors the same narrow Instagram URL policy because it builds yt-dlp commands independently. Existing endpoint paths remain unchanged to avoid client/API compatibility work.

The existing `YTDLP_COOKIES_S3_KEY` remains the single runtime cookie source. Only Instagram-domain rows are merged into that object, after creating a recoverable backup. No unrelated browser cookies are uploaded.

## Error Handling

- Invalid or profile URLs return HTTP 400 before yt-dlp runs.
- Photo-only posts return HTTP 400 with a video-specific message.
- Private/login-required, unavailable, and rate-limited Instagram responses receive user-facing messages without exposing raw cookie or provider details.
- YouTube errors retain their current behavior.

## Verification

- Unit tests cover accepted and rejected URL shapes and header selection.
- API, queue worker, and frontend typechecks/builds must pass sequentially.
- A current public Instagram reel must pass metadata extraction and produce a downloadable MP4 whose bytes contain the `ftyp` signature.
- The deployed cookie object must verify the expected Instagram row count without printing cookie names or values.

## Non-Goals

- Instagram profile/channel downloads.
- Photo or carousel download support.
- Changes to the Android Seal application.
- New public API endpoint names.
- Deployment or git push before the final audit.
