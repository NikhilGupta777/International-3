import { rmSync } from "node:fs";

for (const file of ["package-lock.json", "yarn.lock"]) {
  rmSync(file, { force: true });
}

if (!process.env.npm_config_user_agent?.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
