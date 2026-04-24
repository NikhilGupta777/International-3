// Side-effect module: loads .env into process.env BEFORE any other module
// captures values. Must be the first import in src/index.ts.
//
// Tiny zero-dep parser — only runs in development; production env vars come
// from the platform/Lambda environment.
import { readFileSync, existsSync } from "fs";
import { join } from "path";

if (process.env.NODE_ENV !== "production") {
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", "..", ".env"),
    join(process.cwd(), "..", "..", "..", ".env"),
  ];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        // Replit Secrets / pre-existing env always win over .env values.
        if (process.env[key] === undefined) process.env[key] = value;
      }
    } catch {
      // Ignore unreadable .env files.
    }
  }
}
