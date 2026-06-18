import { ArrowLeft, BookOpen, Copy, ExternalLink } from "lucide-react";

const API_BASE = "https://videomaking.in";

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
    output: "Job envelope with jobId, statusUrl, streamUrl, and eventsUrl.",
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
    output: "Job envelope. Poll until done, then download from resultUrl or returned file URL.",
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

const statuses = [
  ["pending", "Accepted but not started."],
  ["queued", "Submitted to a queue or worker."],
  ["running / downloading / generating / translating", "Work is in progress."],
  ["done / DONE", "Completed successfully."],
  ["error / failed / FAILED", "Terminal failure."],
  ["cancelled / CANCELLED", "Stopped by a user or worker."],
  ["expired / EXPIRED", "Terminal state after queue or output expiry."],
];

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

function CodeBlock({ value }: { value: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/80 p-4 text-[12px] leading-relaxed text-emerald-300">
        {value}
      </pre>
      <button
        type="button"
        onClick={() => copy(value)}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900/90 px-2 py-1 text-[11px] text-slate-300 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
      >
        <Copy className="h-3 w-3" />
        Copy
      </button>
    </div>
  );
}

export function ApiDocumentationPage({ onBack }: { onBack: () => void }) {
  const quickStart = `curl -X POST ${API_BASE}/api/v1/clips \\
  -H "Authorization: Bearer vms_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID"}'`;

  const pollExample = `curl ${API_BASE}/api/v1/jobs/JOB_ID \\
  -H "Authorization: Bearer vms_live_YOUR_KEY"`;

  const sseExample = `curl -N ${API_BASE}/api/v1/jobs/JOB_ID/events \\
  -H "Authorization: Bearer vms_live_YOUR_KEY"`;

  const webhookExample = `{
  "url": "https://youtu.be/VIDEO_ID",
  "startTime": 0,
  "endTime": 30,
  "webhookUrl": "https://example.com/vms-webhook"
}`;

  return (
    <div className="mx-auto h-full w-full max-w-[1120px] overflow-y-auto px-4 py-8 text-slate-300">
      <header className="mb-8 border-b border-slate-800 pb-6">
        <button
          type="button"
          onClick={onBack}
          className="mb-5 inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to keys
        </button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-emerald-400">
              <BookOpen className="h-3.5 w-3.5" />
              API Documentation
            </div>
            <h1 className="font-sans text-3xl font-semibold tracking-tight text-slate-100">VideoMaking Studio API</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              One API key can start jobs across YouTube, subtitles, timestamps, translation, and downloads.
              Use the stable <code className="text-slate-200">/api/v1</code> routes for scripts, servers, and automations.
            </p>
          </div>
          <a
            href={`${API_BASE}/api/v1/openapi.json`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-emerald-500 px-3.5 py-2 text-xs font-medium text-slate-950 transition-colors hover:bg-emerald-400"
          >
            OpenAPI JSON
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 font-sans text-lg font-semibold text-slate-100">Quick start</h2>
        <p className="mb-3 text-sm text-slate-400">
          Send your key as a bearer token. Do not put API keys in frontend code, public repos, screenshots, or logs.
        </p>
        <CodeBlock value={quickStart} />
      </section>

      <section className="mb-10 grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-900/35 p-4">
          <h3 className="font-sans text-sm font-semibold text-slate-100">Base URL</h3>
          <code className="mt-2 block text-xs text-emerald-300">{API_BASE}</code>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/35 p-4">
          <h3 className="font-sans text-sm font-semibold text-slate-100">Authentication</h3>
          <p className="mt-2 text-xs text-slate-400">Use <code>Authorization: Bearer vms_live_...</code> or <code>X-API-Key</code>.</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/35 p-4">
          <h3 className="font-sans text-sm font-semibold text-slate-100">Job model</h3>
          <p className="mt-2 text-xs text-slate-400">Create a job, then poll, stream SSE, or receive a webhook.</p>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-4 font-sans text-lg font-semibold text-slate-100">Endpoints</h2>
        <div className="space-y-4">
          {endpointDocs.map((doc) => (
            <article key={doc.path} className="rounded-lg border border-slate-800 bg-slate-900/30 p-5">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <span className="rounded bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-300">{doc.method}</span>
                <code className="text-sm text-slate-100">{doc.path}</code>
                <span className="font-sans text-sm font-semibold text-slate-200">{doc.name}</span>
              </div>
              <p className="mb-3 text-sm text-slate-400">{doc.purpose}</p>
              <div className="mb-3 grid gap-3 md:grid-cols-2">
                <p className="text-xs text-slate-500">Input: <code className="text-slate-300">{doc.input}</code></p>
                <p className="text-xs text-slate-500">Output: <span className="text-slate-300">{doc.output}</span></p>
              </div>
              <ul className="mb-4 grid gap-1 text-xs text-slate-500">
                {doc.notes.map((note) => <li key={note}>- {note}</li>)}
              </ul>
              <CodeBlock value={doc.example} />
            </article>
          ))}
        </div>
      </section>

      <section className="mb-10 grid gap-5 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 font-sans text-lg font-semibold text-slate-100">Polling</h2>
          <p className="mb-3 text-sm text-slate-400">Poll every 5-10 seconds. Stop on a terminal status.</p>
          <CodeBlock value={pollExample} />
        </div>
        <div>
          <h2 className="mb-3 font-sans text-lg font-semibold text-slate-100">Server-Sent Events</h2>
          <p className="mb-3 text-sm text-slate-400">Use SSE when you want live progress without writing a polling loop.</p>
          <CodeBlock value={sseExample} />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-sans text-lg font-semibold text-slate-100">Statuses</h2>
        <div className="overflow-hidden rounded-lg border border-slate-800">
          {statuses.map(([status, meaning], index) => (
            <div key={status} className={`grid gap-3 px-4 py-3 text-sm md:grid-cols-[220px_1fr] ${index ? "border-t border-slate-800" : ""}`}>
              <code className="text-emerald-300">{status}</code>
              <span className="text-slate-400">{meaning}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-sans text-lg font-semibold text-slate-100">Webhooks</h2>
        <p className="mb-3 text-sm text-slate-400">
          Include <code>webhookUrl</code> in a create request. The URL must be public HTTPS and cannot point to localhost,
          private IP ranges, or internal hostnames. Completion callbacks include <code>X-VMS-Event</code> and
          <code> X-VMS-Signature</code>.
        </p>
        <CodeBlock value={webhookExample} />
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-sans text-lg font-semibold text-slate-100">Operational notes</h2>
        <ul className="grid gap-2 text-sm text-slate-400">
          <li>- API keys are shown once. Revoke and recreate a key if it is exposed.</li>
          <li>- The key is scoped to its own client identity, so job history and outputs are isolated per key.</li>
          <li>- Full access keys use the <code>*</code> scope. Narrow keys can use service scopes such as <code>youtube</code>, <code>subtitles</code>, and <code>translator</code>.</li>
          <li>- Rate limiting is per key. When exceeded, the API returns <code>429</code> and may include <code>Retry-After</code>.</li>
          <li>- Public API clients should prefer <code>/api/v1</code>. Other <code>/api/youtube</code>, <code>/api/subtitles</code>, and <code>/api/translator</code> routes are canonical app routes and may expose service-specific behavior.</li>
          <li>- YouTube jobs depend on server-side YouTube access. Some videos may fail if YouTube blocks server download streams.</li>
        </ul>
      </section>
    </div>
  );
}
