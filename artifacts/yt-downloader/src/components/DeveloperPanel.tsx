import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyRound,
  Copy,
  Check,
  Trash2,
  Plus,
  RefreshCw,
  Terminal,
  ShieldAlert,
  Loader2,
  CircleDot,
  BookOpen,
  Activity,
  Sparkles,
  Zap
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Developer / API Keys panel - Premium UI
// ─────────────────────────────────────────────────────────────────────────────

const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const origin = typeof window !== "undefined" ? window.location.origin : "https://videomaking.in";

type ApiKey = {
  keyId: string;
  prefix: string;
  name: string;
  ownerEmail: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: number;
  createdBy: string;
  lastUsedAt: number | null;
  expiresAt: number | null;
  rateLimitPerMin?: number | null;
  monthlyQuota?: number | null;
  usageMonth?: number;
  usageTotal?: number;
};

const SERVICES = [
  { scope: "youtube", label: "YouTube - download / clip-cut / best-clips" },
  { scope: "subtitles", label: "Subtitle generation" },
  { scope: "youtube:timestamps", label: "Chapters / timestamps" },
  { scope: "translator", label: "Video translation & dubbing" },
  { scope: "bhagwat", label: "Bhagwat AI editor" },
  { scope: "thumbnail", label: "Thumbnail studio" },
  { scope: "agent", label: "AI Studio copilot" },
  { scope: "uploads", label: "Uploads & sharing" },
];

function fmtDate(ms: number | null): string {
  if (!ms) return "-";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

export function DeveloperPanel({ onOpenDocs }: { onOpenDocs?: () => void }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [storeDisabled, setStoreDisabled] = useState(false);

  // create form
  const [name, setName] = useState("");
  const [fullAccess, setFullAccess] = useState(true);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState("");
  const [creating, setCreating] = useState(false);

  // one-time secret reveal
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [freshWebhookSecret, setFreshWebhookSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // key detail expansion
  const [expandedKeyId, setExpandedKeyId] = useState<string | null>(null);

  // test-a-key tool
  const [testKey, setTestKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { ok: boolean; status: number; rate: { limit: string | null; remaining: string | null }; body: unknown }
    | null
  >(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/api/keys`, { 
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      if (res.status === 503) {
        setStoreDisabled(true);
        setKeys([]);
        return;
      }
      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (err) {
        throw new Error(`Invalid JSON response: ${text.slice(0, 80)}...`);
      }
      if (!res.ok) {
        throw new Error(data?.error || `Failed (${res.status})`);
      }
      if (!data.keys) throw new Error("Invalid response from server (missing 'keys' array)");
      setStoreDisabled(false);
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const createKey = useCallback(async () => {
    setCreating(true);
    setError(null);
    setFreshKey(null);
    try {
      const scopes = fullAccess
        ? ["*"]
        : selectedScopes.length > 0 ? selectedScopes : ["*"];
      const body: Record<string, unknown> = { name: name.trim() || "Untitled key", scopes };
      const days = Number(expiresInDays);
      if (Number.isFinite(days) && days > 0) body.expiresInDays = days;

      const res = await fetch(`${base}/api/keys`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Failed (${res.status})`);
      setFreshKey(data.key as string);
      setFreshWebhookSecret((data.webhookSecret as string) ?? null);
      setName("");
      setSelectedScopes([]);
      setExpiresInDays("");
      setFullAccess(true);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  }, [name, fullAccess, selectedScopes, expiresInDays, loadKeys]);

  const revokeKey = useCallback(
    async (keyId: string) => {
      if (!window.confirm("Revoke this key? Any client using it will stop working immediately.")) return;
      try {
        const res = await fetch(`${base}/api/keys/${encodeURIComponent(keyId)}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Failed (${res.status})`);
        await loadKeys();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke key");
      }
    },
    [loadKeys],
  );

  const copyFresh = useCallback(() => {
    if (!freshKey) return;
    void navigator.clipboard?.writeText(freshKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [freshKey]);

  const runTest = useCallback(async () => {
    const k = testKey.trim();
    if (!k) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${origin}/api/v1/jobs/test`, {
        headers: { Authorization: `Bearer ${k}` },
      });
      const body = await res.json().catch(() => ({}));
      const ok = res.ok || res.status === 404; // 404 means auth passed
      setTestResult({
        ok,
        status: res.status,
        rate: {
          limit: res.headers.get("X-RateLimit-Limit"),
          remaining: res.headers.get("X-RateLimit-Remaining"),
        },
        body,
      });
    } catch (err) {
      setTestResult({
        ok: false,
        status: 0,
        rate: { limit: null, remaining: null },
        body: { error: err instanceof Error ? err.message : "Request failed" },
      });
    } finally {
      setTesting(false);
    }
  }, [testKey]);

  const curlExample = useMemo(() => {
    const k = freshKey || "vms_live_YOUR_KEY";
    return `curl -X POST ${origin}/api/v1/clips \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID"}'`;
  }, [freshKey]);

  return (
    <div className="dev-console mx-auto w-full h-full overflow-y-auto max-w-[1000px] px-4 py-10 font-sans text-[14px] leading-relaxed text-slate-300 pb-24 scroll-smooth">
      {/* Header */}
      <header className="mb-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 ring-1 ring-emerald-500/30 shadow-[0_0_30px_rgba(16,185,129,0.15)]">
            <Terminal className="h-6 w-6 text-emerald-400" />
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-tr from-emerald-400/10 to-transparent blur-xl" />
          </div>
          <div>
            <h1 className="bg-gradient-to-r from-emerald-400 via-cyan-400 to-blue-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
              Developer Portal
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              One API key. Infinite programmatic possibilities.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {onOpenDocs && (
            <button
              onClick={onOpenDocs}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-800/50 px-4 py-2 text-sm font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20 transition-all hover:bg-emerald-500/10 hover:text-emerald-200 active:scale-95"
            >
              <BookOpen className="h-4 w-4" />
              API Docs
            </button>
          )}
          <button
            onClick={() => void loadKeys()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-slate-800/50 text-slate-400 ring-1 ring-inset ring-slate-700/50 transition-all hover:bg-slate-700 hover:text-slate-200 active:scale-95"
            title="Refresh keys"
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin text-emerald-400" : "h-4 w-4"} />
          </button>
        </div>
      </header>

      {storeDisabled && (
        <div className="mb-8 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 shadow-lg shadow-amber-500/5 backdrop-blur-md">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
          <div>
            <h3 className="font-semibold text-amber-200">API Store Disabled</h3>
            <p className="mt-1 text-sm text-amber-300/80">
              The API key store is not configured yet. Set <code className="font-mono text-amber-200">ACCESS_TABLE</code> (or <code className="font-mono text-amber-200">API_KEYS_TABLE</code>) on the server to enable keys.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-8 rounded-2xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300 shadow-lg shadow-red-500/5 backdrop-blur-md">
          {error}
        </div>
      )}

      {/* One-time secret reveal */}
      {freshKey && (
        <div className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500 rounded-2xl border border-emerald-500/50 bg-gradient-to-b from-emerald-500/10 to-transparent p-6 shadow-[0_0_40px_rgba(16,185,129,0.15)] backdrop-blur-xl relative overflow-hidden">
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/20 blur-3xl pointer-events-none" />
          
          <div className="mb-3 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/20">
              <KeyRound className="h-4 w-4 text-emerald-400" />
            </div>
            <h2 className="text-lg font-semibold text-emerald-300">Save your new API key</h2>
          </div>
          <p className="mb-4 text-sm text-emerald-400/80">This key will only be displayed once. Please store it securely.</p>
          
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <code className="block w-full overflow-x-auto whitespace-nowrap rounded-xl bg-slate-950/80 px-4 py-3 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
                {freshKey}
              </code>
            </div>
            <button
              onClick={copyFresh}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3 font-semibold text-slate-950 transition-all hover:bg-emerald-400 hover:shadow-[0_0_20px_rgba(16,185,129,0.4)] active:scale-95 overflow-hidden"
            >
              <div className="relative w-4 h-4">
                <Check className={cn("absolute inset-0 transition-all duration-300", copied ? "scale-100 opacity-100 rotate-0" : "scale-50 opacity-0 -rotate-90")} />
                <Copy className={cn("absolute inset-0 transition-all duration-300", copied ? "scale-50 opacity-0 rotate-90" : "scale-100 opacity-100 rotate-0")} />
              </div>
              <span className="relative">
                <span className={cn("block transition-all duration-300", copied ? "-translate-y-8 opacity-0" : "translate-y-0 opacity-100")}>Copy Key</span>
                <span className={cn("absolute inset-0 block transition-all duration-300", copied ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0")}>Copied!</span>
              </span>
            </button>
          </div>

          {freshWebhookSecret && (
            <div className="mt-5 rounded-xl bg-slate-950/40 p-4 ring-1 ring-inset ring-amber-500/20">
              <p className="mb-2 text-sm text-slate-300">
                Webhook signing secret <span className="text-slate-500">(verify X-VMS-Signature)</span> - also shown once:
              </p>
              <code className="block overflow-x-auto whitespace-nowrap rounded-lg bg-slate-950/80 px-3 py-2 font-mono text-sm text-amber-300 ring-1 ring-inset ring-amber-500/20">
                {freshWebhookSecret}
              </code>
            </div>
          )}
          <div className="mt-5 flex items-start gap-3 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-300/90">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p>
              Treat this like a password. Never embed it in browser/client code, public repos, or screenshots.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        
        {/* Left Column: Keys List & Creation */}
        <div className="space-y-8">
          
          {/* Create key */}
          <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-2xl backdrop-blur-xl transition-all hover:bg-white/[0.03]">
            <div className="mb-5 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-cyan-400" />
              <h2 className="text-lg font-semibold text-slate-100">Generate New Key</h2>
            </div>
            
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-slate-400">Key Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. production-backend"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-slate-200 placeholder-slate-600 outline-none transition-all focus:border-emerald-500/50 focus:bg-black/40 focus:ring-1 focus:ring-emerald-500/50"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-slate-400">Expires In (Days)</label>
                <input
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="Never (leave blank)"
                  inputMode="numeric"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-slate-200 placeholder-slate-600 outline-none transition-all focus:border-emerald-500/50 focus:bg-black/40 focus:ring-1 focus:ring-emerald-500/50"
                />
              </div>
            </div>

            <div className="mt-5 rounded-xl bg-black/20 p-4 ring-1 ring-inset ring-white/5">
              <label className="flex cursor-pointer items-center gap-3 text-sm text-slate-300">
                <div className="relative flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={fullAccess}
                    onChange={(e) => setFullAccess(e.target.checked)}
                    className="peer h-5 w-5 cursor-pointer appearance-none rounded border border-slate-600 bg-slate-800 transition-all checked:border-emerald-500 checked:bg-emerald-500 hover:border-emerald-400"
                  />
                  <Check className="pointer-events-none absolute h-3.5 w-3.5 text-slate-900 opacity-0 transition-opacity peer-checked:opacity-100" />
                </div>
                <span className="font-medium text-white">Full access (all services)</span>
                <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-400">Recommended</span>
              </label>
              
              {!fullAccess && (
                <div className="mt-4 animate-in fade-in slide-in-from-top-2 duration-300">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {SERVICES.map((srv) => (
                      <label key={srv.scope} className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/5 bg-black/40 p-3 transition-colors hover:border-cyan-500/30 hover:bg-black/60">
                        <div className="relative mt-0.5 flex items-center justify-center">
                          <input
                            type="checkbox"
                            checked={selectedScopes.includes(srv.scope)}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedScopes(prev => [...prev, srv.scope]);
                              else setSelectedScopes(prev => prev.filter(s => s !== srv.scope));
                            }}
                            className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-slate-600 bg-slate-800 transition-all checked:border-cyan-500 checked:bg-cyan-500 hover:border-cyan-400"
                          />
                          <Check className="pointer-events-none absolute h-3 w-3 text-slate-900 opacity-0 transition-opacity peer-checked:opacity-100" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-slate-200">{srv.scope}</span>
                          <span className="text-xs text-slate-500">{srv.label}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => void createKey()}
              disabled={creating || storeDisabled || (!fullAccess && selectedScopes.length === 0)}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-3 font-semibold text-slate-950 transition-all hover:opacity-90 hover:shadow-[0_0_20px_rgba(16,185,129,0.3)] active:scale-95 disabled:pointer-events-none disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
              {creating ? "Generating..." : "Generate API Key"}
            </button>
          </section>

          {/* Existing keys */}
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
              <KeyRound className="h-5 w-5 text-blue-400" />
              Active Keys
            </h2>
            
            {loading ? (
              <div className="grid gap-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="group relative overflow-hidden rounded-2xl border border-white/5 bg-white/[0.02] p-1">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
                      <div className="h-8 w-8 rounded-full bg-slate-800/50 animate-pulse" />
                      <div className="flex-1 min-w-[120px] space-y-2">
                        <div className="h-4 w-32 rounded bg-slate-800/80 animate-pulse" />
                        <div className="h-3 w-48 rounded bg-slate-800/50 animate-pulse" />
                      </div>
                      <div className="hidden flex-col items-end gap-2 sm:flex">
                        <div className="h-3 w-24 rounded bg-slate-800/50 animate-pulse" />
                        <div className="h-3 w-16 rounded bg-slate-800/30 animate-pulse" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : keys.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.01] py-16 text-center animate-in fade-in zoom-in-95 duration-500">
                <div className="relative mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-800/50 ring-1 ring-white/10">
                  <KeyRound className="h-8 w-8 text-slate-400" />
                  <div className="absolute inset-0 rounded-full bg-emerald-500/20 blur-xl" />
                </div>
                <h3 className="text-lg font-semibold text-slate-200">No API keys found</h3>
                <p className="mt-2 text-sm text-slate-500 max-w-[250px]">Generate your first key above to unlock programmatic access.</p>
              </div>
            ) : (
              <div className="grid gap-3">
                {keys.map((k, i) => (
                  <div 
                    key={k.keyId} 
                    style={{ animationDelay: `${i * 50}ms`, animationFillMode: "both" }}
                    className={cn(
                      "animate-in fade-in slide-in-from-bottom-2 duration-500",
                      "group relative overflow-hidden rounded-2xl border border-white/5 bg-white/[0.02] p-1 transition-all hover:border-white/10 hover:bg-white/[0.04]",
                      k.status === "revoked" && "opacity-50 grayscale"
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setExpandedKeyId((cur) => (cur === k.keyId ? null : k.keyId))}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800/50 text-slate-400 transition-all hover:bg-slate-700 hover:text-white active:scale-95"
                      >
                        <CircleDot className={cn("h-4 w-4", k.status === "active" ? "text-emerald-400" : "text-slate-600")} />
                      </button>
                      
                      <div className="flex-1 min-w-[120px]">
                        <div className="flex items-center gap-2">
                          <span className={cn("font-semibold text-slate-200", k.status === "revoked" && "line-through text-slate-400")}>{k.name}</span>
                          <span className="rounded-full bg-slate-800/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400 ring-1 ring-inset ring-white/10">
                            {k.scopes.includes("*") ? "Full Access" : "Custom Scopes"}
                          </span>
                        </div>
                        <code className="mt-1 block font-mono text-xs text-slate-500">
                          {k.prefix}••••••••••••
                        </code>
                      </div>

                      <div className="hidden flex-col items-end text-xs text-slate-500 sm:flex">
                        <span>Used: {k.lastUsedAt ? fmtDate(k.lastUsedAt) : "Never"}</span>
                        <span>{k.usageMonth ?? 0} reqs this month</span>
                      </div>

                      {k.status === "active" && (
                        <button
                          onClick={() => void revokeKey(k.keyId)}
                          title="Revoke Key"
                          className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>

                    {/* Details Expansion */}
                    {expandedKeyId === k.keyId && (
                      <div className="animate-in fade-in slide-in-from-top-2 overflow-hidden rounded-xl bg-black/40 p-5 mt-1 duration-200">
                        <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
                          {[
                            ["Key ID", k.keyId],
                            ["Status", <span key="status" className={k.status === 'active' ? 'text-emerald-400 capitalize' : 'text-slate-500 capitalize'}>{k.status}</span>],
                            ["Scopes", k.scopes.join(", ")],
                            ["Created", fmtDate(k.createdAt)],
                            ["Last used", fmtDate(k.lastUsedAt)],
                            ["Usage this month", <span key="usage" className="font-mono text-cyan-400">{k.usageMonth ?? 0}</span>],
                            ["Lifetime requests", <span key="total" className="font-mono">{k.usageTotal ?? 0}</span>],
                            ["Expires", k.expiresAt ? fmtDate(k.expiresAt * 1000) : <span key="exp" className="text-slate-500">Never</span>],
                          ].map(([label, value]) => (
                            <div key={label as string} className="flex flex-col gap-1">
                              <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</dt>
                              <dd className="break-words text-slate-200">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Tools & Quick Start */}
        <div className="space-y-8">
          
          {/* Test a key */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-xl backdrop-blur-xl">
            <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-slate-100">
              <Activity className="h-5 w-5 text-purple-400" />
              API Playground
            </h2>
            <p className="mb-5 text-sm text-slate-400">
              Verify a key instantly by pinging the <code className="text-slate-300 font-mono text-xs">/api/v1/jobs/test</code> endpoint.
            </p>
            
            <div className="space-y-3">
              <input
                value={testKey}
                onChange={(e) => setTestKey(e.target.value)}
                placeholder="Paste key: vms_live_..."
                className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 font-mono text-sm text-slate-200 placeholder-slate-600 outline-none transition-all focus:border-purple-500/50 focus:bg-black/50 focus:ring-1 focus:ring-purple-500/50"
              />
              <button
                onClick={() => void runTest()}
                disabled={testing || !testKey.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-purple-500/20 px-4 py-2.5 font-semibold text-purple-300 ring-1 ring-inset ring-purple-500/30 transition-all hover:bg-purple-500/30 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
              >
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                Run Test
              </button>
            </div>

            {testResult && (
              <div className="mt-5 animate-in fade-in slide-in-from-top-2 rounded-xl bg-black/40 p-4 ring-1 ring-inset ring-white/5 duration-300">
                <div className="mb-3 flex items-center gap-2 border-b border-white/10 pb-3">
                  {testResult.ok ? (
                    <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-400">
                      <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                      Success ({testResult.status})
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-sm font-medium text-red-400">
                      <div className="h-2 w-2 rounded-full bg-red-400 shadow-[0_0_8px_#f87171]" />
                      Failed ({testResult.status || "Network Error"})
                    </span>
                  )}
                  {testResult.rate.limit && (
                    <span className="ml-auto text-xs text-slate-500">
                      Rate: {testResult.rate.remaining}/{testResult.rate.limit}
                    </span>
                  )}
                </div>
                <pre className="overflow-x-auto text-[11px] font-mono leading-relaxed text-slate-300 scrollbar-thin scrollbar-thumb-white/10">
                  {JSON.stringify(testResult.body, null, 2)}
                </pre>
              </div>
            )}
          </section>

          {/* Quick start */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 shadow-xl backdrop-blur-xl">
            <h2 className="mb-4 font-semibold text-slate-100 flex items-center gap-2">
              <Terminal className="w-5 h-5 text-blue-400" /> Quick Snippet
            </h2>
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 rounded-xl blur-md transition-opacity opacity-0 group-hover:opacity-100" />
              <pre className="relative overflow-x-auto rounded-xl border border-white/10 bg-black/60 p-4 font-mono text-[11px] leading-relaxed text-emerald-300 scrollbar-thin scrollbar-thumb-white/10">
                {curlExample}
              </pre>
            </div>
            
            <div className="mt-6">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-500">Available Services</p>
              <ul className="grid gap-2">
                {SERVICES.map((s) => (
                  <li key={s.scope} className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-3 py-2 text-sm transition-colors hover:bg-white/[0.04]">
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500/50 shadow-[0_0_5px_#10b981]" />
                    <code className="text-xs text-emerald-200">{s.scope}</code>
                    <span className="truncate text-slate-400 text-xs">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
