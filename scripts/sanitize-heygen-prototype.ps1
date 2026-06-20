param(
  [string]$SourcePath = "C:\Users\g_n-n\Desktop\temp\index.html",
  [string]$Path = "artifacts\yt-downloader\public\heygen\index.html"
)

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$sourceFullPath = (Resolve-Path -LiteralPath $SourcePath).Path
$text = [System.IO.File]::ReadAllText($sourceFullPath, [System.Text.Encoding]::UTF8)

$fetchPatch = @'
// Route HeyGen API calls through the authenticated app session. The original
// standalone page used a client-side API key header; this embedded version keeps
// the key server-side and relies on the app's same-origin auth cookie.
(function patchHeyGenFetch() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
    const isHeyGenProxy = rawUrl.startsWith('/api/heygen');
    if (!isHeyGenProxy) return nativeFetch(input, init);

    const nextInit = Object.assign({}, init || {}, { credentials: 'same-origin' });
    const headers = new Headers(nextInit.headers || {});
    headers.delete('x-api-key');
    nextInit.headers = headers;
    return nativeFetch(input, nextInit);
  };
})();

'@

$loginMarker = "(async function initLogin()"
$loginIndex = $text.IndexOf($loginMarker)
if ($loginIndex -lt 0) {
  throw "Could not find initLogin marker in HeyGen prototype."
}
$text = $text.Substring(0, $loginIndex) +
  $fetchPatch +
  "try { localStorage.setItem('vt_auth', 'ok'); sessionStorage.setItem('vt_auth', 'ok'); } catch(e) {}`n" +
  $text.Substring($loginIndex)

$text = $text.Replace("fetch('config.env')", "fetch('/api/heygen/disabled-config')")
$text = $text.Replace("config.env", "server configuration")
$text = $text.Replace("APP_USER", "SERVER_USER")
$text = $text.Replace("APP_PASS", "SERVER_PASS")

$loadApiPattern = "async function loadApiKeyFromEnv\(\) \{[\s\S]*?\r?\n\}\r?\n\r?\nasync function validateApiKey\(\)"
$loadApiReplacement = @'
async function loadApiKeyFromEnv() {
  state.apiKey = 'server-managed';
  state.geminiKeys = ['server-managed'];
  validateApiKey();
}

async function validateApiKey()
'@
$text = [regex]::Replace($text, $loadApiPattern, $loadApiReplacement)

$replacements = @{
  "fetch('https://api.heygen.com/v3/users/me'" = "fetch('/api/heygen/me'"
  "fetch('https://api.heygen.com/v3/brand-glossaries'" = "fetch('/api/heygen/brand-glossaries'"
  "fetch('https://api.heygen.com/v3/assets'" = "fetch('/api/heygen/assets'"
  "fetch('https://api.heygen.com/v3/video-translations'" = "fetch('/api/heygen/video-translations'"
  "fetch('https://api.heygen.com/v3/video-translations/' + jobId" = "fetch('/api/heygen/video-translations/' + jobId"
  "fetch('https://api.heygen.com/v3/video-translations/' + id" = "fetch('/api/heygen/video-translations/' + id"
  "let url = 'https://api.heygen.com/v3/video-translations?limit=50';" = "let url = '/api/heygen/video-translations?limit=50';"
}

foreach ($entry in $replacements.GetEnumerator()) {
  $text = $text.Replace($entry.Key, $entry.Value)
}

$text = $text.Replace(
  'fetch(`https://api.heygen.com/v3/video-translations/${job.id}`',
  'fetch(`/api/heygen/video-translations/${job.id}`'
)

$uploadGeminiPattern = "async function uploadToGeminiFileApi\(file, apiKey\) \{[\s\S]*?\r?\n\}\r?\n\r?\nasync function generateSrtWithGemini\(\)"
$uploadGeminiReplacement = @'
async function uploadToGeminiFileApi(file, apiKey) {
  throw new Error('Gemini upload is server-managed in this build.');
}

async function generateSrtWithGemini()
'@
$text = [regex]::Replace($text, $uploadGeminiPattern, $uploadGeminiReplacement)

$generateStart = $text.IndexOf("async function generateSrtWithGemini()")
$generateEndMarker = "function handleSrtUpload(file)"
$generateEnd = $text.IndexOf($generateEndMarker, $generateStart)
if ($generateStart -ge 0 -and $generateEnd -gt $generateStart) {
  $replacement = @'
async function generateSrtWithGemini() {
  if (!state.selectedUrl && !state.selectedFile) {
    showToast('Please select a video file or enter a YouTube URL first.', 'error');
    return;
  }
  if (state.isSrtGenerating) {
    showToast('SRT is already generating. Please wait.', 'info');
    return;
  }
  state.isSrtGenerating = true;
  const btnTexts = document.querySelectorAll('.generate-srt-text');
  const btnEls = document.querySelectorAll('.generate-srt-btn');
  btnTexts.forEach(t => t.textContent = 'Generating SRT on server...');
  btnEls.forEach(b => b.classList.add('anim-pulse-glow'));
  try {
    const fd = new FormData();
    if (state.selectedFile) fd.append('file', state.selectedFile);
    if (state.selectedUrl) fd.append('url', state.selectedUrl);
    const res = await fetch('/api/heygen/generate-srt', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `SRT generation failed: HTTP ${res.status}`);
    const srtResult = String(data.srt || '').trim();
    if (!srtResult) throw new Error('Empty SRT response');
    const blob = new Blob([srtResult], { type: 'text/plain' });
    const srtFile = new File([blob], 'ai_generated_subtitles.srt', { type: 'text/plain' });
    handleSrtUpload(srtFile);
    showToast('SRT generated successfully', 'success');
  } catch (err) {
    showToast(err.message || 'SRT generation failed', 'error');
  } finally {
    state.isSrtGenerating = false;
    btnTexts.forEach(t => t.textContent = '\u2728 Generate SRT with AI');
    btnEls.forEach(b => b.classList.remove('anim-pulse-glow', 'anim-shimmer'));
  }
}

'@
  $text = $text.Substring(0, $generateStart) + $replacement + $text.Substring($generateEnd)
}

$targetFullPath = Join-Path (Get-Location) $Path
$targetDir = Split-Path -Parent $targetFullPath
if ($targetDir) {
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}
[System.IO.File]::WriteAllText($targetFullPath, $text, $utf8NoBom)
