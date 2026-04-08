import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// In production, serve the built frontend static files
if (process.env["NODE_ENV"] === "production") {
  const __dirname = fileURLToPath(new URL(".", import.meta.url));

  // STATIC_DIR env var allows overriding the path (useful in Docker)
  // Fallback: from artifacts/api-server/dist/ go 2 levels up → artifacts/
  const staticDir =
    process.env["STATIC_DIR"] ??
    join(__dirname, "..", "..", "yt-downloader", "dist", "public");

  if (existsSync(staticDir)) {
    logger.info({ staticDir }, "Serving static frontend files");
    app.use(express.static(staticDir));
    // SPA fallback — serve index.html for any non-/api path that doesn't
    // match a static file (handles client-side routing).
    // Explicitly exclude /api/* so API 404s still return proper JSON errors.
    app.get(/^(?!\/api(\/|$))/, (_req: Request, res: Response) => {
      res.sendFile(join(staticDir, "index.html"));
    });
  } else {
    logger.warn(
      { staticDir },
      "Static dir not found — frontend will not be served. Run the frontend build first.",
    );
  }
}

export default app;
