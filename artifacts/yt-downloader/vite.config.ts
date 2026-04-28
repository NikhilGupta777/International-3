import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const port = process.env.PORT ? Number(process.env.PORT) : 5173;
const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 8080}`,
        changeOrigin: true,
        // ── SSE / streaming FIX ──────────────────────────────────────────────
        // Root cause of "everything appears at once": Vite's http-proxy
        // auto-pipes proxyRes → res by default, PLUS our old configure handler
        // was calling proxyRes.pipe(res) a SECOND time. Double-consuming a
        // readable causes Node.js to buffer the whole stream and flush at end.
        //
        // The CORRECT fix: selfHandleResponse: true
        //   → tells http-proxy "do NOT auto-pipe the response body"
        //   → we pipe it ourselves in the proxyRes handler
        //   → for SSE, we also set TCP_NODELAY so every sseEvent() write
        //     bypasses Nagle's algorithm and hits the browser immediately.
        selfHandleResponse: true,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res: any) => {
            const ct = proxyRes.headers["content-type"] ?? "";

            if (ct.includes("text/event-stream")) {
              // SSE: set real-time headers, disable Nagle, pipe directly.
              // CRITICAL: do NOT set "Transfer-Encoding: identity". That
              // disables chunked encoding, and without Content-Length the
              // Replit edge proxy then buffers the entire body until the
              // upstream socket closes — so the browser only receives the
              // full response at the end. Letting Node default to
              // "Transfer-Encoding: chunked" lets each write flush through.
              // Also drop any upstream Content-Length to avoid a length
              // mismatch on a streaming body.
              res.writeHead(proxyRes.statusCode ?? 200, {
                "Content-Type":          "text/event-stream; charset=utf-8",
                "Cache-Control":         "no-cache, no-store, no-transform, must-revalidate",
                "Connection":            "keep-alive",
                "X-Accel-Buffering":     "no",
                "Access-Control-Allow-Origin": "*",
              });
              // TCP_NODELAY: flush every write() immediately (no Nagle batching)
              res.socket?.setNoDelay?.(true);
              // 2KB comment padding tells some intermediaries to start
              // streaming immediately instead of waiting for a buffer to fill.
              res.write(":" + " ".repeat(2048) + "\n\n");
              if (typeof (res as any).flush === "function") (res as any).flush();
              proxyRes.pipe(res);
            } else {
              // All other routes: forward status + headers normally, pipe body
              res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
              proxyRes.pipe(res);
            }
          });

          proxy.on("error", (err, _req, res: any) => {
            if (!res.headersSent) res.writeHead(502);
            res.end(`Proxy error: ${err.message}`);
          });
        },
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
