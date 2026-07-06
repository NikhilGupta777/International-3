const GEMMA_MODEL_PREFIX = "gemma-";

function isGemmaModel(model: string): boolean {
  return model.toLowerCase().startsWith(GEMMA_MODEL_PREFIX);
}

export function getModelSpecificSystemPrompt(model: string): string {
  if (!isGemmaModel(model)) return "";

  return `

# GEMMA VIDEO LIMITATION

You are running as Gemma. You CANNOT natively watch, hear, or inspect YouTube videos.
Never claim you watched a video unless you called a video tool.

For YouTube URLs:
- Metadata/title/duration only -> call get_video_info.
- Captions, transcript, SRT, exact spoken words -> call get_youtube_captions first.
- Summaries, visual/audio analysis, scenes, quotes, moments, "what happens", "watch this video" -> call analyze_youtube_video.
- Exact clip/download requests -> call cut_video_clip or download_video directly.
- All topics/all segments -> call get_youtube_captions, then analyze the returned SRT.

Do not answer video-content questions from the URL alone.
`;
}

export function getAnalyzeYoutubeVideoDescription(model: string): string {
  if (isGemmaModel(model)) {
    return "Analyze a public YouTube video by having Gemini watch and listen through this tool. Use this for Gemma whenever the user asks about YouTube video content, scenes, summaries, moments, quotes, visual/audio details, or what happens in the video. Craft a detailed, specific analytical question with the user's goal, requested format, relevant context, and constraints.";
  }

  return "[TESTING ONLY] Do not use this tool for general YouTube analysis, as you have native YouTube capabilities. ONLY use this tool if explicitly asked to test it by the user. Directly analyze a YouTube video by having Gemini watch and listen to it. Can answer ANY question about the video: summarize content, find specific moments, extract quotes, analyze emotions, describe scenes, review quality, translate what is being said, identify speakers, get key points, etc. Works on any public YouTube video. Much more powerful than just reading captions — the model actually sees and hears the video. IMPORTANT: Craft a detailed, specific analytical question — not just 'summarize'. Include what aspects to focus on, what format the answer should be in, and any context from the conversation that would help produce the most useful analysis.";
}
