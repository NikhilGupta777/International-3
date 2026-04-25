import { spawnSync } from "node:child_process";

const result = spawnSync("uv", ["sync", "--quiet"], { stdio: "ignore", shell: true });
if (result.error && result.error.code !== "ENOENT") {
  console.warn(`uv sync skipped: ${result.error.message}`);
}
