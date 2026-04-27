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
        // ── SSE / streaming fix ──────────────────────────────────────────
        // Vite's http-proxy buffers responses by default. For Server-Sent
        // Events (text/event-stream) we must disable buffering so chunks
        // reach the browser as they are written — not all at once at the end.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, req, res) => {
            const contentType = proxyRes.headers["content-type"] ?? "";
            if (contentType.includes("text/event-stream")) {
              // Disable response buffering on the socket
              res.setHeader("Content-Type", "text/event-stream");
              res.setHeader("Cache-Control", "no-cache");
              res.setHeader("Connection", "keep-alive");
              res.setHeader("X-Accel-Buffering", "no");
              // TCP_NODELAY — flush every write immediately without Nagle delay
              (res.socket as any)?.setNoDelay?.(true);
              proxyRes.pipe(res, { end: true });
              // Prevent http-proxy from touching the response after we piped it
              (res as any).__sse_piped = true;
            }
          });
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            // Skip if we already piped it above
            if ((res as any).__sse_piped) return;
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
