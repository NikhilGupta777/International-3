import { useState } from "react";
import { ArrowLeft, BookOpen, Copy, ExternalLink, Terminal, Code2, Cpu, Check, AlertCircle, Shield, Server, Box, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

// Use the live origin so copy-paste examples target whatever host the panel is
// served from (falls back to the production domain during SSR/build).
const API_BASE = typeof window !== "undefined" ? window.location.origin : "https://videomaking.in";

type EndpointDoc = {
  name: string;
  method: string;
  path: string;
  purpose: string;
  input: string;
  output: string;
  notes: string[];
  example: string;
};

const endpointDocs: EndpointDoc[] = [
  {
    name: "Best clips",
    method: "POST",
    path: "/api/v1/clips",
    purpose: "Analyze a YouTube video and return AI-selected clip ideas.",
    input: "{ url, durations?, auto?, instructions?, webhookUrl? }",
    output: "Job envelope with jobId, status, statusUrl, eventsUrl, and cancelUrl.",
    notes: [
      "Use this for AI discovery, not manual cutting.",
      "durations is an array of target lengths in seconds, for example [30, 60].",
      "instructions can bias the search toward a topic or style.",
    ],
    example: `curl -X POST ${API_BASE}/api/v1/clips \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID","durations":[30,60],"auto":true}'`,
  },
  {
    name: "Clip cut",
    method: "POST",
    path: "/api/v1/clip-cut",
    purpose: "Cut one exact time range from a YouTube video.",
    input: "{ url, startTime, endTime, quality?, webhookUrl? }",
    output: "Job envelope. Poll until done, then download from result.url.",
    notes: [
      "startTime and endTime are seconds.",
      "endTime must be greater than startTime.",
      "A single clip cannot exceed 60 minutes.",
    ],
    example: `curl -X POST ${API_BASE}/api/v1/clip-cut \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID","startTime":0,"endTime":30,"quality":"360p"}'`,
  },
  {
    name: "Download",
    method: "POST",
    path: "/api/v1/download",
    purpose: "Download a full YouTube video or audio track.",
    input: "{ url, formatId?, audioOnly?, webhookUrl? }",
    output: "Job envelope. Poll until done, then download the generated media.",
    notes: [
      "formatId defaults to the server's best compatible video selection.",
      "audioOnly=true requests audio extraction.",
      "YouTube availability can depend on server-side cookies, PO-token, or proxy health.",
    ],
    example: `curl -X POST ${API_BASE}/api/v1/download \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID","audioOnly":false}'`,
  },
  {
    name: "Timestamps",
    method: "POST",
    path: "/api/v1/timestamps",
    purpose: "Generate AI chapter timestamps for a YouTube video.",
    input: "{ url, instructions?, webhookUrl? }",
    output: "Job envelope. Poll for generated timestamps and video metadata.",
    notes: [
      "Works best when captions or transcript extraction is available.",
      "instructions can request chapter density or focus.",
    ],
    example: `curl -X POST ${API_BASE}/api/v1/timestamps \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID","instructions":"Make detailed chapters"}'`,
  },
  {
    name: "Subtitles",
    method: "POST",
    path: "/api/v1/subtitles",
    purpose: "Transcribe a public audio/video URL into subtitles.",
    input: "{ url, language?, translateTo?, webhookUrl? }",
    output: "Job envelope. Poll for SRT output, filename, progress, and warnings.",
    notes: [
      "The URL must be publicly accessible by the server.",
      "language may be a BCP-47 code or auto.",
      "translateTo optionally asks for translated subtitles.",
    ],
    example: `curl -X POST ${API_BASE}/api/v1/subtitles \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/video.mp4","language":"auto"}'`,
  },
  {
    name: "Translate / dub",
    method: "POST",
    path: "/api/v1/translate",
    purpose: "Translate and dub a public video URL.",
    input: "{ url, targetLang?, targetLangCode?, sourceLang?, voiceClone?, lipSync?, webhookUrl? }",
    output: "Job envelope. Poll translator status for progress, warnings, and final result metadata.",
    notes: [
      "The URL must be public and downloadable by the server.",
      "targetLang defaults to Hindi and targetLangCode defaults to hi.",
      "lipSync availability depends on account and deployment configuration.",
    ],
    example: `curl -X POST ${API_BASE}/api/v1/translate \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/video.mp4","targetLang":"Hindi","targetLangCode":"hi","voiceClone":true}'`,
  },
];

const statuses: [string, string][] = [
  ["pending", "Accepted but not started."],
  ["queued", "Submitted to a queue or worker."],
  ["running", "Work is in progress (downloading / generating / translating)."],
  ["done", "Completed successfully (succeeded=true). `result` is populated."],
  ["error", "Terminal failure (failed=true)."],
  ["cancelled", "Stopped by a user or worker."],
  ["expired", "Terminal state after queue or output expiry."],
];

const errorCodes: [string, string][] = [
  ["INVALID_API_KEY", "Missing, malformed, or revoked key (401)."],
  ["FORBIDDEN_SCOPE", "Key lacks the scope for this route (403)."],
  ["RATE_LIMIT_EXCEEDED", "Per-minute rate limit hit; see Retry-After (429, retryable)."],
  ["MONTHLY_QUOTA_EXCEEDED", "Monthly request quota reached (429)."],
  ["INVALID_REQUEST", "Bad parameters (400)."],
  ["JOB_NOT_FOUND", "Unknown jobId, or not owned by this key (404)."],
  ["NOT_CANCELLABLE", "The operation does not support cancellation (400)."],
  ["UPSTREAM_VALIDATION", "The underlying service rejected the input (400)."],
  ["UPSTREAM_ERROR / INTERNAL_ERROR", "Server-side failure (5xx, retryable)."],
];

function CodeBlock({ value, language = "bash" }: { value: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative mt-2 w-full overflow-hidden rounded-xl border border-white/10 bg-[#0d1117] shadow-lg">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="h-2.5 w-2.5 rounded-full bg-red-500/50" />
            <div className="h-2.5 w-2.5 rounded-full bg-amber-500/50" />
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500/50" />
          </div>
          <span className="ml-2 text-[10px] font-medium uppercase tracking-widest text-slate-500">{language}</span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed text-emerald-300/90 scrollbar-thin scrollbar-thumb-white/10">
        <code>{value}</code>
      </pre>
    </div>
  );
}

export function ApiDocumentationPage({ onBack }: { onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<"curl" | "node" | "python">("node");

  const quickStart = `curl -X POST ${API_BASE}/api/v1/clips \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID"}'`;

  const nodeExample = `const BASE = "${API_BASE}";
const KEY = process.env.VMS_API_KEY;
const headers = { Authorization: \`Bearer \${KEY}\`, "Content-Type": "application/json" };

// 1) Start a job
const r = await fetch(\`\${BASE}/api/v1/clips\`, {
  method: "POST", headers,
  body: JSON.stringify({ url: "https://youtu.be/VIDEO_ID", durations: [30, 60] }),
});
const { jobId, statusUrl } = await r.json();

// 2) Poll until terminal
for (;;) {
  const job = await (await fetch(statusUrl, { headers })).json();
  if (job.terminal) {
    if (job.succeeded) console.log("result:", job.result);
    else console.error("failed:", job.message);
    break;
  }
  await new Promise((s) => setTimeout(s, 5000));
}`;

  const pythonExample = `import os, time, requests

BASE = "${API_BASE}"
headers = {"Authorization": f"Bearer {os.environ.get('VMS_API_KEY')}"}

# 1) Start a job
r = requests.post(f"{BASE}/api/v1/subtitles",
                  headers=headers,
                  json={"url": "https://example.com/video.mp4", "language": "auto"})
job = r.json()
status_url = job["statusUrl"]

# 2) Poll until terminal
while True:
    job = requests.get(status_url, headers=headers).json()
    if job["terminal"]:
        print("result" if job["succeeded"] else "error", job.get("result") or job.get("message"))
        break
    time.sleep(5)`;

  const examples = { curl: quickStart, node: nodeExample, python: pythonExample };

  const pollExample = `curl ${API_BASE}/api/v1/jobs/JOB_ID \\
  -H "Authorization: Bearer vms_live_YOUR_KEY"`;

  const sseExample = `curl -N ${API_BASE}/api/v1/jobs/JOB_ID/events \\
  -H "Authorization: Bearer vms_live_YOUR_KEY"`;

  const cancelExample = `curl -X POST ${API_BASE}/api/v1/jobs/JOB_ID/cancel \\
  -H "Authorization: Bearer vms_live_YOUR_KEY"`;

  const idempotencyExample = `curl -X POST ${API_BASE}/api/v1/clips \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Idempotency-Key: 7e3f-client-generated-id" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID"}'`;

  const uploadsExample = `# 1) presign  2) upload to the returned URL  3) complete  4) use the file URL
curl -X POST ${API_BASE}/api/v1/uploads/presign \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"filename":"clip.mp4","size":1048576,"mimeType":"video/mp4"}'
# then POST /api/v1/uploads/complete { fileId } and pass the file URL to /subtitles or /translate`;

  return (
    <div className="mx-auto h-full w-full max-w-[1200px] overflow-y-auto px-4 py-10 font-sans text-slate-300 pb-24">
      {/* Header */}
      <header className="mb-14 relative">
        <button
          type="button"
          onClick={onBack}
          className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-4 py-2 text-xs font-medium text-slate-300 transition-all hover:bg-white/[0.05] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </button>

        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
              <BookOpen className="h-3.5 w-3.5" />
              API Reference
            </div>
            <h1 className="bg-gradient-to-br from-white via-slate-200 to-slate-400 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl">
              VideoMaking Studio API
            </h1>
            <p className="mt-4 text-base leading-relaxed text-slate-400">
              Integrate AI video generation, translation, and extraction into your own apps. 
              The <code className="rounded bg-white/5 px-1.5 py-0.5 text-emerald-300">/api/v1</code> routes are stable, fast, and built for scale.
            </p>
          </div>

          <a
            href={`${API_BASE}/api/v1/openapi.json`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-6 py-3 font-semibold text-slate-950 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all hover:opacity-90 active:scale-95"
          >
            <Code2 className="h-5 w-5" />
            OpenAPI Spec
            <ExternalLink className="ml-1 h-4 w-4" />
          </a>
        </div>
      </header>

      {/* Core Concepts */}
      <section className="mb-14 grid gap-5 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-lg backdrop-blur-md">
          <Server className="mb-4 h-6 w-6 text-blue-400" />
          <h3 className="font-bold text-slate-100">Base URL</h3>
          <code className="mt-2 block rounded bg-black/40 px-2 py-1 text-xs text-blue-300">{API_BASE}</code>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-lg backdrop-blur-md">
          <Shield className="mb-4 h-6 w-6 text-emerald-400" />
          <h3 className="font-bold text-slate-100">Authentication</h3>
          <p className="mt-2 text-sm text-slate-400">Pass your key via the <code className="text-emerald-300">Authorization: Bearer</code> header.</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-lg backdrop-blur-md">
          <Activity className="mb-4 h-6 w-6 text-purple-400" />
          <h3 className="font-bold text-slate-100">Asynchronous</h3>
          <p className="mt-2 text-sm text-slate-400">Start a job, then poll, stream via SSE, or use Webhooks.</p>
        </div>
      </section>

      {/* Quick Start / Examples */}
      <section className="mb-16">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-100">Quick Start</h2>
            <p className="mt-1 text-sm text-slate-400">Copy this code into your project to start your first job.</p>
          </div>
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/40 p-1">
            {(["node", "python", "curl"] as const).map((lang) => (
              <button
                key={lang}
                onClick={() => setActiveTab(lang)}
                className={cn(
                  "rounded-lg px-4 py-1.5 text-xs font-semibold capitalize transition-all",
                  activeTab === lang
                    ? "bg-white/10 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                )}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>
        <div className="animate-in fade-in zoom-in-95 duration-300">
          <CodeBlock value={examples[activeTab]} language={activeTab === 'node' ? 'typescript' : activeTab} />
        </div>
      </section>

      {/* Endpoints */}
      <section className="mb-16">
        <h2 className="mb-6 text-2xl font-bold text-slate-100">Core Endpoints</h2>
        <div className="grid gap-6">
          {endpointDocs.map((doc) => (
            <div key={doc.path} className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] shadow-xl backdrop-blur-md transition-all hover:bg-white/[0.04]">
              <div className="border-b border-white/5 bg-black/20 p-5 sm:p-6">
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <span className="rounded-lg bg-emerald-500/20 px-3 py-1 font-mono text-xs font-bold tracking-widest text-emerald-400 ring-1 ring-inset ring-emerald-500/30">
                    {doc.method}
                  </span>
                  <code className="text-sm font-semibold text-slate-200">{doc.path}</code>
                  <div className="ml-auto flex items-center gap-2">
                    <Box className="h-4 w-4 text-slate-500" />
                    <span className="font-semibold text-slate-300">{doc.name}</span>
                  </div>
                </div>
                <p className="text-sm leading-relaxed text-slate-400">{doc.purpose}</p>
              </div>
              <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-2">
                <div className="space-y-5">
                  <div>
                    <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Payload</h4>
                    <code className="block rounded-lg bg-black/40 px-3 py-2 text-xs text-cyan-300 ring-1 ring-inset ring-white/5">
                      {doc.input}
                    </code>
                  </div>
                  <div>
                    <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Response</h4>
                    <p className="text-sm text-slate-300">{doc.output}</p>
                  </div>
                  <div>
                    <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Notes</h4>
                    <ul className="space-y-1.5">
                      {doc.notes.map((note, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-slate-400">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/50" />
                          <span>{note}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div>
                  <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Example Request</h4>
                  <CodeBlock value={doc.example} language="bash" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Advanced Features Grid */}
      <section className="mb-16 grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-xl backdrop-blur-md">
          <h2 className="mb-3 text-lg font-bold text-slate-100 flex items-center gap-2">
            <Activity className="h-5 w-5 text-blue-400" /> Polling
          </h2>
          <p className="mb-4 text-sm text-slate-400">
            The unified <code className="text-emerald-300">GET /api/v1/jobs/&#123;id&#125;</code> route works for all jobs. Poll every 5 seconds until <code className="text-emerald-300">terminal</code> is true.
          </p>
          <CodeBlock value={pollExample} />
        </div>
        
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-xl backdrop-blur-md">
          <h2 className="mb-3 text-lg font-bold text-slate-100 flex items-center gap-2">
            <Cpu className="h-5 w-5 text-cyan-400" /> Server-Sent Events (SSE)
          </h2>
          <p className="mb-4 text-sm text-slate-400">
            Subscribe to <code className="text-cyan-300">eventsUrl</code> for real-time progress without the overhead of a polling loop.
          </p>
          <CodeBlock value={sseExample} />
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-xl backdrop-blur-md">
          <h2 className="mb-3 text-lg font-bold text-slate-100 flex items-center gap-2">
            <Shield className="h-5 w-5 text-amber-400" /> Idempotency
          </h2>
          <p className="mb-4 text-sm text-slate-400">
            Add an <code className="text-amber-300">Idempotency-Key</code> header to safely retry requests without accidentally triggering duplicate jobs.
          </p>
          <CodeBlock value={idempotencyExample} />
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-xl backdrop-blur-md">
          <h2 className="mb-3 text-lg font-bold text-slate-100 flex items-center gap-2">
            <Server className="h-5 w-5 text-purple-400" /> Cancellation
          </h2>
          <p className="mb-4 text-sm text-slate-400">
            Hit <code className="text-purple-300">/api/v1/jobs/&#123;id&#125;/cancel</code> to abort. Returns <code className="text-purple-300">NOT_CANCELLABLE</code> if unsupported.
          </p>
          <CodeBlock value={cancelExample} />
        </div>
      </section>

      {/* Webhooks & Uploads Full Width */}
      <section className="mb-16 grid gap-6">
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-xl backdrop-blur-md">
          <h2 className="mb-3 text-xl font-bold text-slate-100">Webhooks</h2>
          <p className="mb-4 text-sm text-slate-400">
            Pass <code className="text-emerald-300">webhookUrl</code> on job creation. Your server will receive a POST request upon completion. Ensure you verify the <code className="text-emerald-300">X-VMS-Signature</code> using your Webhook Secret.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <CodeBlock value={`// 1) The payload sent to your server
{
  "jobId": "...",
  "status": "done",
  "succeeded": true,
  "result": { "url": "..." },
  "timestamp": 123456789
}`} language="json" />
            <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-white/10 p-6 text-center">
              <Shield className="mb-2 h-8 w-8 text-slate-600" />
              <p className="text-sm font-medium text-slate-400">Always verify HMAC SHA256 signatures to prevent spoofed job completions.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Reference Tables */}
      <section className="mb-16 grid gap-8 lg:grid-cols-2">
        <div>
          <h2 className="mb-4 text-xl font-bold text-slate-100">Job Statuses</h2>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-black/20 shadow-lg">
            {statuses.map(([status, meaning], i) => (
              <div key={status} className={cn("flex items-start gap-4 p-4", i > 0 && "border-t border-white/5")}>
                <code className="w-24 shrink-0 font-bold text-emerald-400">{status}</code>
                <span className="text-sm text-slate-400">{meaning}</span>
              </div>
            ))}
          </div>
        </div>
        
        <div>
          <h2 className="mb-4 text-xl font-bold text-slate-100">Error Codes</h2>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-black/20 shadow-lg">
            {errorCodes.map(([code, meaning], i) => (
              <div key={code} className={cn("flex items-start gap-4 p-4", i > 0 && "border-t border-white/5")}>
                <code className="w-48 shrink-0 font-bold text-red-400">{code}</code>
                <span className="text-sm text-slate-400">{meaning}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      
      {/* Footer Info */}
      <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
        <AlertCircle className="h-4 w-4" />
        If your API key is compromised, revoke it immediately from the Developer panel.
      </div>
    </div>
  );
}
