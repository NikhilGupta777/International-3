import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isBatchWorkerInvocation = Boolean(process.env.JOB_PAYLOAD);
const prettyLogsEnabled =
  !isProduction &&
  !isBatchWorkerInvocation &&
  process.env.LOG_PRETTY !== "false";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(prettyLogsEnabled
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}),
});
