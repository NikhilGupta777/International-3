import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // Bundle runtime deps into worker output because this worker dynamically
  // imports api-server route modules. Keeping deps bundled avoids runtime
  // resolution failures for transitive modules in Batch containers.
});
