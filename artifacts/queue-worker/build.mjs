import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // Treat all npm packages as external — only bundle our own TypeScript source.
  // This prevents esbuild from trying to resolve api-server's deps (express,
  // multer, @google/genai, etc.) which are available at runtime via pnpm.
  packages: "external",
});
