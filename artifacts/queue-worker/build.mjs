import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  banner: {
    js: `import { createRequire as __queueWorkerCreateRequire } from "node:module";
import { fileURLToPath as __queueWorkerFileURLToPath } from "node:url";
import { dirname as __queueWorkerDirname } from "node:path";
const require = __queueWorkerCreateRequire(import.meta.url);
const __filename = __queueWorkerFileURLToPath(import.meta.url);
const __dirname = __queueWorkerDirname(__filename);`,
  },
  // Bundle runtime deps into worker output because this worker dynamically
  // imports api-server route modules. Keeping deps bundled avoids runtime
  // resolution failures for transitive modules in Batch containers.
});
