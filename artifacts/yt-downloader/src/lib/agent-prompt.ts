export function generateAgentPrompt(apiKey: string | null = null): string {
  const keyToUse = apiKey || "vms_live_YOUR_KEY";
  
  return `You are an AI agent or Copilot. The user has provided you with access to the VideoMaking Studio API.
Your task is to use the API to accomplish the user's video-related goals (downloading, cutting clips, translating, transcribing, etc.).

When making API calls, use the following base URL: https://videomaking.in
Always authenticate your requests using the Bearer token below.

API Key: \`${keyToUse}\`

Headers to include in every request:
- Authorization: Bearer ${keyToUse}
- Content-Type: application/json

====================
API DOCUMENTATION
====================

# 1. Best clips
POST /api/v1/clips
Purpose: Analyze a YouTube video and return AI-selected clip ideas.
Input (JSON): { url: string, durations?: number[], auto?: boolean, instructions?: string, webhookUrl?: string }
Output: Job envelope with jobId, statusUrl
Notes:
- Use this for AI discovery, not manual cutting.
- durations is an array of target lengths in seconds, for example [30, 60].

# 2. Clip cut
POST /api/v1/clip-cut
Purpose: Cut one exact time range from a YouTube video.
Input (JSON): { url: string, startTime: number, endTime: number, quality?: string, webhookUrl?: string }
Output: Job envelope. Poll until done, then download from result.url.
Notes:
- startTime and endTime are seconds.
- A single clip cannot exceed 60 minutes.

# 3. Download
POST /api/v1/download
Purpose: Download a full YouTube video or audio track.
Input (JSON): { url: string, formatId?: string, audioOnly?: boolean, webhookUrl?: string }
Output: Job envelope. Poll until done, then download the generated media.

# 4. Timestamps
POST /api/v1/timestamps
Purpose: Generate AI chapter timestamps for a YouTube video.
Input (JSON): { url: string, instructions?: string, webhookUrl?: string }
Output: Job envelope. Poll for generated timestamps and video metadata.

# 5. Subtitles
POST /api/v1/subtitles
Purpose: Transcribe a public audio/video URL into subtitles.
Input (JSON): { url: string, language?: string, translateTo?: string, webhookUrl?: string }
Output: Job envelope. Poll for SRT output, filename, progress, and warnings.
Notes:
- language may be a BCP-47 code or 'auto'.

# 6. Translate / dub
POST /api/v1/translate
Purpose: Translate and dub a public video URL.
Input (JSON): { url: string, targetLang?: string, targetLangCode?: string, sourceLang?: string, voiceClone?: boolean, lipSync?: boolean, webhookUrl?: string }
Output: Job envelope. Poll translator status for progress, warnings, and final result metadata.
Notes:
- targetLang defaults to Hindi and targetLangCode defaults to hi.

# Job Polling
All routes return a Job envelope immediately.
To check status, use:
GET /api/v1/jobs/JOB_ID
Wait until \`terminal\` is true, then check if \`succeeded\` is true.
`;
}
