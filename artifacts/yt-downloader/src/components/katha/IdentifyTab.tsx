import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Loader2, Sparkles, ImagePlus, MapPin, X, RefreshCw, Check,
  AlertTriangle, Lightbulb, Image as ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { compressImage } from "@/lib/image-utils";
import { Reference, MatchResult, IdentifyMeta, MAX_FILE_MB } from "@/lib/katha-types";
import { estimateIdentifyCost, formatUsd } from "@/lib/cost-estimate";

// Pipeline stages shown to the user during identification.
const SHORTLIST_BATCH_SIZE = 25;
const FINAL_TOP_N = 12;
type Stage = { label: string; pct: number };

function buildStages(refCount: number): Stage[] {
  if (refCount <= FINAL_TOP_N) {
    return [
      { label: "Preparing images...", pct: 10 },
      { label: `Comparing against ${refCount} references...`, pct: 70 },
      { label: "Finalizing match...", pct: 95 },
    ];
  }
  const batches = Math.ceil(refCount / SHORTLIST_BATCH_SIZE);
  return [
    { label: "Preparing images...", pct: 8 },
    { label: `Shortlisting ${refCount} references in ${batches} batches...`, pct: 55 },
    { label: `Final ranking top ${FINAL_TOP_N} candidates...`, pct: 88 },
    { label: "Almost done...", pct: 96 },
  ];
}

interface Props {
  references: Reference[];
  onOpenLightbox: (src: string) => void;
}

export function IdentifyTab({ references, onOpenLightbox }: Props) {
  const [queryFile, setQueryFile] = useState<File | null>(null);
  const [queryPreview, setQueryPreview] = useState<string | null>(null);
  const [queryCompressedDataUrl, setQueryCompressedDataUrl] = useState<string | null>(null);
  const [queryDims, setQueryDims] = useState<{ w: number; h: number } | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [results, setResults] = useState<MatchResult[] | null>(null);
  const [analysis, setAnalysis] = useState("");
  const [meta, setMeta] = useState<IdentifyMeta | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stageIdx, setStageIdx] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stageTimerRef = useRef<number | null>(null);

  const stages = buildStages(references.length);

  // Paste handler
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) handleQueryFile(f);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Cmd/Ctrl+Enter to identify
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && queryFile && !identifying) {
        identify();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Advance stage labels on a heuristic timer while identifying.
  useEffect(() => {
    if (!identifying) {
      if (stageTimerRef.current) window.clearInterval(stageTimerRef.current);
      stageTimerRef.current = null;
      return;
    }
    setStageIdx(0);
    // Estimate total time: ~1.2s/batch sequentially, /4 concurrency, +2s final.
    const batches = Math.ceil(references.length / SHORTLIST_BATCH_SIZE);
    const estTotalMs = references.length > FINAL_TOP_N
      ? Math.max(3500, (batches / 4) * 1500 + 2200)
      : 3500;
    const stepMs = estTotalMs / stages.length;
    stageTimerRef.current = window.setInterval(() => {
      setStageIdx((i) => Math.min(i + 1, stages.length - 1));
    }, stepMs);
    return () => {
      if (stageTimerRef.current) window.clearInterval(stageTimerRef.current);
    };
  }, [identifying, references.length]);

  async function handleQueryFile(f: File) {
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      toast.error(`Image too large (max ${MAX_FILE_MB}MB)`);
      return;
    }
    setQueryFile(f);
    setResults(null); setAnalysis(""); setMeta(null); setLastError(null);
    try {
      // Single compression - reuse for both preview and AI request.
      const { dataUrl, width, height } = await compressImage(f, 1280, 0.85);
      setQueryPreview(dataUrl);
      setQueryCompressedDataUrl(dataUrl);
      setQueryDims({ w: width, h: height });
    } catch (e: any) {
      toast.error("Could not read image: " + e.message);
    }
  }

  function clearQuery() {
    abortRef.current?.abort();
    setQueryFile(null); setQueryPreview(null); setQueryCompressedDataUrl(null);
    setQueryDims(null);
    setResults(null); setAnalysis(""); setMeta(null); setLastError(null);
  }

  async function identify() {
    if (!queryCompressedDataUrl) { toast.error("Upload a photo first"); return; }
    if (references.length === 0) { toast.error("Add reference images first"); return; }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setIdentifying(true);
    setResults(null); setAnalysis(""); setMeta(null); setLastError(null);
    try {
      const refsForAi = references.map((r) => ({
        id: r.id, place_name: r.place_name, location: r.location, notes: r.notes, image_url: r.image_url,
      }));
      const { data, error } = await supabase.functions.invoke("identify-katha", {
        body: { queryImage: queryCompressedDataUrl, references: refsForAi },
      });
      if (ac.signal.aborted) return;
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setResults(data.matches || []);
      setAnalysis(data.overall_analysis || "");
      setMeta({
        shortlisted: data.shortlisted,
        total: data.total_references,
        evaluated: data.candidates_evaluated,
        elapsed_ms: data.elapsed_ms,
      });
      toast.success(`Identification complete in ${((data.elapsed_ms ?? 0) / 1000).toFixed(1)}s`);
    } catch (e: any) {
      if (!ac.signal.aborted) {
        const msg = e.message || "Identification failed";
        setLastError(msg);
        toast.error(msg);
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setIdentifying(false);
    }
  }

  // Quality hints for the query image.
  const lowRes = queryDims && Math.max(queryDims.w, queryDims.h) < 800;
  const topConfidence = results?.[0]?.confidence ?? 0;
  const noConfidentMatch = results !== null && results.length > 0 && topConfidence < 50;
  const noResults = results !== null && results.length === 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6 space-y-4">
          <label
            htmlFor="query-file"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f && f.type.startsWith("image/")) handleQueryFile(f);
            }}
            className="block cursor-pointer"
          >
            <div className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 bg-muted/30"
            }`}>
              {queryPreview ? (
                <div className="space-y-3">
                  <img
                    src={queryPreview}
                    alt="Query"
                    width={1280}
                    height={960}
                    className="max-h-72 w-auto mx-auto rounded-lg shadow-md"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => { e.preventDefault(); clearQuery(); }}
                  >
                    <X className="h-3 w-3 mr-1" /> Clear
                  </Button>
                </div>
              ) : (
                <div className="py-8">
                  <ImagePlus className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm font-medium">Click, drop, or paste an image</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    JPG, PNG - max {MAX_FILE_MB}MB - auto-compressed
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 hidden sm:block">
                    Tip: paste with <kbd className="px-1 py-0.5 rounded bg-muted text-[10px]">CmdV</kbd>
                  </p>
                </div>
              )}
            </div>
            <input id="query-file" type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleQueryFile(f); e.target.value = ""; }} />
          </label>

          <div className="flex gap-2">
            <Button
              onClick={identify}
              disabled={!queryFile || identifying || references.length === 0}
              className="flex-1"
              size="lg"
              style={{ background: "var(--gradient-warm)" }}
            >
              {identifying ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> <span className="truncate">Analyzing {references.length}...</span></>
              ) : (
                <><Sparkles className="h-4 w-4 mr-2" /> Identify location</>
              )}
            </Button>
            {results && !identifying && (
              <Button variant="outline" size="lg" onClick={identify} title="Re-run">
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
          </div>

          {references.length === 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
              <Lightbulb className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Your library is empty.</span> Switch to the
                Library tab and upload photos of known katha venues so the AI has something to match against.
              </p>
            </div>
          )}
          {references.length > 0 && (() => {
            const est = estimateIdentifyCost(references.length);
            return (
              <p className="text-[11px] text-center text-muted-foreground">
                Est. AI cost per run: <span className="font-medium text-foreground">{formatUsd(est.usd)}</span>
                <span className="opacity-70"> - {est.batches} call{est.batches === 1 ? "" : "s"} - ~{Math.round(est.inputTokens / 1000)}k tokens</span>
              </p>
            );
          })()}
          {/* Quality hint for small images */}
          {queryPreview && lowRes && !identifying && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-2.5 text-xs">
              <Lightbulb className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Low-resolution image</span> ({queryDims!.w}x{queryDims!.h}px).
                Photos at least 800px on the long side give noticeably better matches.
              </p>
            </div>
          )}

          {/* Live pipeline progress */}
          {identifying && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {stages[stageIdx]?.label}
                </span>
                <span className="text-muted-foreground">Step {stageIdx + 1}/{stages.length}</span>
              </div>
              <Progress value={stages[stageIdx]?.pct ?? 0} className="h-1.5" />
            </div>
          )}

          {/* Error panel with retry */}
          {lastError && !identifying && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-foreground">Identification failed</p>
                <p className="text-muted-foreground mt-0.5 break-words">{lastError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 h-7 text-xs"
                  onClick={identify}
                  disabled={!queryFile || references.length === 0}
                >
                  <RefreshCw className="h-3 w-3 mr-1" /> Try again
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>


      {/* No matches at all */}
      {noResults && !identifying && (
        <Card>
          <CardContent className="pt-6 pb-6 text-center space-y-2">
            <ImageIcon className="h-8 w-8 mx-auto text-muted-foreground" />
            <h3 className="font-medium">No matches returned</h3>
            <p className="text-sm text-muted-foreground">
              The AI couldn't return any candidates. Try a clearer photo of the venue backdrop or vyas peeth.
            </p>
            <Button variant="outline" size="sm" onClick={identify}>
              <RefreshCw className="h-3 w-3 mr-1" /> Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {results && results.length > 0 && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Match results</h2>
              {analysis && <p className="text-sm text-muted-foreground pt-1">{analysis}</p>}
              {meta && (
                <div className="flex flex-wrap gap-2 pt-2">
                  <Badge variant="outline" className="text-xs">Searched {meta.total}</Badge>
                  {meta.shortlisted && <Badge variant="outline" className="text-xs">Shortlisted top {meta.evaluated}</Badge>}
                  {typeof meta.elapsed_ms === "number" && (
                    <Badge variant="outline" className="text-xs">{(meta.elapsed_ms / 1000).toFixed(1)}s</Badge>
                  )}
                  {typeof meta.total === "number" && (
                    <Badge variant="outline" className="text-xs">
                      ~{formatUsd(estimateIdentifyCost(meta.total).usd)} AI cost
                    </Badge>
                  )}
                </div>
              )}
            </div>

            {noConfidentMatch && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="text-muted-foreground">
                  <p className="font-medium text-foreground">Low confidence - these may not be the right venue</p>
                  <p className="mt-1">Top match is only {Math.round(topConfidence)}%. Common reasons:</p>
                  <ul className="list-disc list-inside mt-1 space-y-0.5">
                    <li>The venue isn't in your library yet - add a reference for it</li>
                    <li>Your photo focuses on the speaker; the AI needs to see the backdrop / vyas peeth</li>
                    <li>Lighting or angle differs significantly from references</li>
                  </ul>
                </div>
              </div>
            )}

            {results.map((m, idx) => (
              <div key={idx} className="rounded-xl border border-border p-4 bg-card">
                <div className="flex items-start gap-2 flex-wrap mb-3">
                  <Badge
                    variant={idx === 0 ? "default" : "secondary"}
                    style={idx === 0 ? { background: "var(--gradient-warm)" } : undefined}
                  >
                    #{idx + 1} - {Math.round(m.confidence)}% match
                  </Badge>
                  {idx === 0 && m.confidence >= 70 && <Badge variant="outline">Best match</Badge>}
                  {idx === 0 && m.confidence < 50 && <Badge variant="destructive">Low confidence</Badge>}
                </div>

                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Your photo</p>
                    {queryPreview && (
                      <button onClick={() => onOpenLightbox(queryPreview)} className="block w-full">
                        <img
                          src={queryPreview}
                          alt="Query"
                          loading="lazy"
                          className="w-full aspect-square object-cover rounded-lg"
                        />
                      </button>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Match</p>
                    {m.reference && (
                      <button onClick={() => onOpenLightbox(m.reference!.image_url)} className="block w-full">
                        <img
                          src={m.reference.image_url}
                          alt={m.reference.place_name}
                          loading="lazy"
                          className="w-full aspect-square object-cover rounded-lg"
                        />
                      </button>
                    )}
                  </div>
                </div>

                <h3 className="font-semibold text-lg">{m.reference?.place_name || "Unknown"}</h3>
                {m.reference?.location && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> {m.reference.location}
                  </p>
                )}
                {m.reference?.notes && <p className="text-xs text-muted-foreground mt-1">{m.reference.notes}</p>}

                <div className="mt-3">
                  <p className="text-xs font-medium mb-1 flex items-center gap-1">
                    <Check className="h-3 w-3" /> Matched venue features:
                  </p>
                  <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                    {m.matched_features.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

