/**
 * Video Translator Proxy Route
 * All /api/translator/* requests are forwarded to the Fargate service.
 * Video streams (preview/download) are piped byte-for-byte.
 */

import { Router } from "express";
import { Readable } from "stream";

const router = Router();

const TRANSLATOR_URL = (
  process.env.TRANSLATOR_SERVICE_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

// ── Generic JSON proxy ────────────────────────────────────────────────────────

async function proxyJson(req: any, res: any, path: string, method = "GET", body?: any) {
  try {
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    const upstream = await fetch(`${TRANSLATOR_URL}${path}`, opts);
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: `Translator service unreachable: ${err?.message}` });
  }
}

// ── Multipart upload proxy (streams the file without buffering) ───────────────

router.post("/upload", async (req, res) => {
  try {
    // Re-forward the raw multipart body
    const upstream = await fetch(`${TRANSLATOR_URL}/upload`, {
      method: "POST",
      // @ts-ignore — node-fetch / undici accept Node streams
      body: req as any,
      headers: {
        "content-type": req.headers["content-type"] ?? "multipart/form-data",
        "content-length": req.headers["content-length"] ?? "",
        "transfer-encoding": req.headers["transfer-encoding"] ?? "",
      },
      // @ts-ignore
      duplex: "half",
    });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: `Upload proxy failed: ${err?.message}` });
  }
});

// ── Status / Transcript (JSON) ────────────────────────────────────────────────

router.get("/status/:id",     (req, res) => proxyJson(req, res, `/status/${req.params.id}`));
router.get("/transcript/:id", (req, res) => proxyJson(req, res, `/transcript/${req.params.id}`));
router.get("/jobs",           (req, res) => proxyJson(req, res, "/jobs"));
router.get("/system-status",  (req, res) => proxyJson(req, res, "/system-status"));
router.get("/healthz",        (req, res) => proxyJson(req, res, "/healthz"));
router.delete("/jobs/:id",    (req, res) => proxyJson(req, res, `/jobs/${req.params.id}`, "DELETE"));

// ── Video stream proxy (preview + download) ────────────────────────────────────

async function proxyVideoStream(req: any, res: any, path: string, isDownload = false) {
  try {
    const upstream = await fetch(`${TRANSLATOR_URL}${path}`, {
      headers: req.headers["range"] ? { Range: req.headers["range"] } : {},
    });

    if (!upstream.ok || !upstream.body) {
      const err = await upstream.text().catch(() => "");
      return res.status(upstream.status).json({ error: err || "Not found" });
    }

    // Forward key headers
    const ct = upstream.headers.get("content-type") ?? "video/mp4";
    const cl = upstream.headers.get("content-length");
    const cr = upstream.headers.get("content-range");
    const ac = upstream.headers.get("accept-ranges");

    res.setHeader("Content-Type", ct);
    if (cl) res.setHeader("Content-Length", cl);
    if (cr) res.setHeader("Content-Range", cr);
    if (ac) res.setHeader("Accept-Ranges", ac);
    if (isDownload) {
      const cd = upstream.headers.get("content-disposition") ?? `attachment; filename="translated.mp4"`;
      res.setHeader("Content-Disposition", cd);
    }

    res.status(upstream.status === 206 ? 206 : 200);

    // Pipe response body
    const nodeStream = Readable.fromWeb(upstream.body as any);
    nodeStream.pipe(res);
    nodeStream.on("error", () => res.end());
  } catch (err: any) {
    res.status(502).json({ error: `Video stream proxy failed: ${err?.message}` });
  }
}

router.get("/preview/:id",  (req, res) => proxyVideoStream(req, res, `/preview/${req.params.id}`));
router.get("/download/:id", (req, res) => proxyVideoStream(req, res, `/download/${req.params.id}`, true));

export default router;
