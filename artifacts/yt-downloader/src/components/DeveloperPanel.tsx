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
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Developer / API Keys panel
//
// Deliberately distinct from the rest of the studio: a minimal "console"
// aesthetic (monospace, slate surface, emerald accent). Visible only to admins
// and admin-granted emails (gated by features.apiAccessAllowed upstream).
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
  { scope: "timestamps", label: "Chapters / timestamps" },
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
  const [scopesText, setScopesText] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [creating, setCreating] = useState(false);

  // one-time secret reveal
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/api/keys`, { credentials: "include" });
      if (res.status === 503) {
        setStoreDisabled(true);
        setKeys([]);
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Failed (${res.status})`);
      const data = (await res.json()) as { keys: ApiKey[] };
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
        : scopesText.split(",").map((s) => s.trim()).filter(Boolean);
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
      setName("");
      setScopesText("");
      setExpiresInDays("");
      setFullAccess(true);
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  }, [name, fullAccess, scopesText, expiresInDays, loadKeys]);

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

  const curlExample = useMemo(() => {
    const k = freshKey || "vms_live_YOUR_KEY";
    return `curl -X POST ${origin}/api/v1/clips \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://youtu.be/VIDEO_ID"}'`;
  }, [freshKey]);

  return (
    <div className="dev-console mx-auto w-full max-w-[920px] px-4 py-8 font-mono text-[13px] leading-relaxed text-slate-300">
      {/* Header */}
      <header className="mb-7 flex items-center gap-3 border-b border-slate-700/60 pb-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30">
          <Terminal className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="font-sans text-xl font-semibold tracking-tight text-slate-100">Developer</h1>
          <p className="truncate text-xs text-slate-500">
            One key, programmatic access to every studio service.
          </p>
        </div>
        <button
          onClick={() => void loadKeys()}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
        >
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          Refresh
        </button>
      </header>

      {storeDisabled && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-amber-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-xs">
            The API key store is not configured yet. Set <code className="text-amber-200">ACCESS_TABLE</code> (or{" "}
            <code className="text-amber-200">API_KEYS_TABLE</code>) on the server to enable keys.
          </p>
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-md border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* One-time secret reveal */}
      {freshKey && (
        <div className="mb-7 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-emerald-300">
            <KeyRound className="h-4 w-4" />
            <span className="font-sans text-sm font-semibold">Copy your key now - it won't be shown again</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-slate-950/70 px-3 py-2.5 text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
              {freshKey}
            </code>
            <button
              onClick={copyFresh}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-2.5 font-sans text-xs font-medium text-slate-950 transition-colors hover:bg-emerald-400"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {/* Create key */}
      <section className="mb-8 rounded-lg border border-slate-700/60 bg-slate-900/40 p-5">
        <h2 className="mb-4 font-sans text-sm font-semibold text-slate-200">Create a new key</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs text-slate-500">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. zapier-automation"
              className="rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-200 outline-none transition-colors focus:border-emerald-500/60"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-slate-500">
            Expires in (days, optional)
            <input
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="never"
              inputMode="numeric"
              className="rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-200 outline-none transition-colors focus:border-emerald-500/60"
            />
          </label>
        </div>

        <div className="mt-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={fullAccess}
              onChange={(e) => setFullAccess(e.target.checked)}
              className="h-3.5 w-3.5 accent-emerald-500"
            />
            Full access (all services) - recommended
          </label>
          {!fullAccess && (
            <input
              value={scopesText}
              onChange={(e) => setScopesText(e.target.value)}
              placeholder="youtube, subtitles, translator"
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950/60 px-3 py-2 text-slate-200 outline-none transition-colors focus:border-emerald-500/60"
            />
          )}
        </div>

        <button
          onClick={() => void createKey()}
          disabled={creating || storeDisabled}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3.5 py-2 font-sans text-xs font-medium text-slate-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Generate key
        </button>
      </section>

      {/* Existing keys */}
      <section className="mb-8">
        <h2 className="mb-3 font-sans text-sm font-semibold text-slate-200">Your keys</h2>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : keys.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-700/70 px-4 py-6 text-center text-xs text-slate-600">
            No keys yet. Generate one above to get started.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-700/60">
            {keys.map((k, i) => (
              <div
                key={k.keyId}
                className={
                  "flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 " +
                  (i > 0 ? "border-t border-slate-800/80 " : "") +
                  (k.status === "revoked" ? "opacity-50" : "")
                }
              >
                <CircleDot
                  className={"h-3 w-3 shrink-0 " + (k.status === "active" ? "text-emerald-400" : "text-slate-600")}
                />
                <code className="text-slate-300">{k.prefix}...</code>
                <span className="font-sans text-slate-200">{k.name}</span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                  {k.scopes.includes("*") ? "full access" : k.scopes.join(", ")}
                </span>
                <span className="ml-auto text-[11px] text-slate-600">
                  {k.monthlyQuota
                    ? `${k.usageMonth ?? 0}/${k.monthlyQuota} reqs/mo - `
                    : (k.usageMonth ?? 0) > 0
                      ? `${k.usageMonth} reqs/mo - `
                      : ""}
                  created {fmtDate(k.createdAt)} - used {fmtDate(k.lastUsedAt)}
                  {k.expiresAt ? ` - expires ${fmtDate(k.expiresAt * 1000)}` : ""}
                </span>
                {k.status === "active" && (
                  <button
                    onClick={() => void revokeKey(k.keyId)}
                    title="Revoke"
                    className="rounded p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Quick start */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-sans text-sm font-semibold text-slate-200">Quick start</h2>
          {onOpenDocs && (
            <button
              type="button"
              onClick={onOpenDocs}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 px-2.5 py-1.5 font-sans text-xs font-medium text-emerald-300 transition-colors hover:border-emerald-400/60 hover:bg-emerald-500/10 hover:text-emerald-200"
            >
              <BookOpen className="h-3.5 w-3.5" />
              Read full documentation
            </button>
          )}
        </div>
        <p className="mb-2 text-xs text-slate-500">
          Send your key as a bearer token. It works from anywhere - scripts, servers, automations.
        </p>
        <pre className="overflow-x-auto rounded-lg border border-slate-700/60 bg-slate-950/70 p-4 text-[12px] text-emerald-300">
{curlExample}
        </pre>
        <p className="mb-2 mt-5 text-xs text-slate-500">Services this key can reach:</p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {SERVICES.map((s) => (
            <li key={s.scope} className="flex items-center gap-2 text-xs text-slate-400">
              <span className="text-emerald-500/70">&gt;</span>
              <code className="text-slate-300">{s.scope}</code>
              <span className="truncate text-slate-600">{s.label}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
