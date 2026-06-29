// Must come first: side-effect import that loads .env into process.env
// before any downstream module captures config values at import-time.
import "./lib/load-env";
import dns from "dns";

// Fix Node.js 18+ Windows IPv6 hanging issue with fetch
dns.setDefaultResultOrder("ipv4first");

import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
