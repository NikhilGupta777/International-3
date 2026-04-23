# YTDLP Cookies Runbook (Serverless)

This runbook keeps YouTube cookie handling stable on the serverless stack.

## Why this exists

- Lambda environment variables have a hard size limit.
- CloudFormation parameter values also have practical length limits.
- Raw exported cookie blobs can exceed those limits and break deploys.

## Rules

- Do not place full unfiltered cookie exports directly in `.env.green` / `.env.production`.
- Keep `YTDLP_COOKIES_BASE64` compact enough for deploy parameters.
- Prefer short-lived operational cookies over massive full browser exports.

## Current deploy-safe pattern

1. Start from a Netscape-format cookie file (or convert browser export to Netscape format).
1. Filter to required YouTube host rows and active auth/session cookies only.
1. Base64-encode the filtered file.
1. Verify encoded size is safely below CloudFormation/Lambda limits.
1. Put the encoded value in `YTDLP_COOKIES_BASE64` in the deploy env file.
1. Deploy serverless stack.

## Size guardrails

- Recommended target for `YTDLP_COOKIES_BASE64`: `< 3500` chars.
- Absolute hard stop: if size is near or above `4096`, deploy can fail.

## Validation checklist after deploy

1. Confirm API health:
   - `GET /api/healthz` returns 200.
1. Submit clip-cut and subtitles jobs for a public YouTube URL.
1. Confirm both reach terminal states (`done` or clear `error`) with no stuck `queued`.
1. If YouTube bot/cookie errors appear, refresh cookies and redeploy.

## Failure playbook

- If deploy fails with parameter length errors:
  - Reduce `YTDLP_COOKIES_BASE64` size (use filtered/minimal cookie set), redeploy.
- If runtime gets YouTube sign-in/bot messages:
  - Refresh cookies from logged-in browser session, re-filter, re-encode, redeploy.
- If subtitles/clip-cut intermittently fail from model overload:
  - Treat as retryable AI failure; queue retry path should continue across keys/models.

