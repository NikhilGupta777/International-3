/**
 * Express ↔ Lambda Function URL streaming bridge
 * ==============================================
 *
 * Why this exists:
 *   API Gateway HTTP API buffers Lambda responses entirely before returning
 *   them, which kills SSE / chunked streaming and forces the 30s gateway
 *   timeout. The fix is to invoke Lambda through a Function URL with
 *   `InvokeMode: RESPONSE_STREAM`, which streams chunks back to CloudFront
 *   as soon as the function writes them.
 *
 * Strategy:
 *   - Spin up a tiny localhost-only Node http server bound to the Express
 *     `app` once per Lambda init (cold start). Node's real http machinery
 *     handles request parsing, body decoding, headers, keep-alive, etc.
 *   - On each invocation, translate the Function URL event into an http
 *     request to that internal server.
 *   - Pipe the proxied response chunks straight to the AWS-provided
 *     `responseStream` via `awslambda.HttpResponseStream.from(...)`.
 *
 * This avoids reimplementing the entire Express/Node response surface
 * (writeHead, setHeader, flush, pipe semantics, gzip, cookies, etc.) — we
 * just borrow the real one and forward bytes.
 */

import http from "node:http";
import type { Express } from "express";

interface AwsLambda {
  streamifyResponse: (
    handler: (event: any, responseStream: any, context: any) => Promise<void>,
  ) => any;
  HttpResponseStream: {
    from(
      stream: NodeJS.WritableStream,
      prelude: {
        statusCode?: number;
        headers?: Record<string, string>;
        cookies?: string[];
      },
    ): NodeJS.WritableStream;
  };
}

declare const awslambda: AwsLambda;

let internalServer: http.Server | null = null;
let internalPort = 0;
let serverReady: Promise<void> | null = null;

export function ensureInternalServer(app: Express): Promise<void> {
  if (serverReady) return serverReady;
  serverReady = new Promise<void>((resolve, reject) => {
    const server = http.createServer(app);
    // Long-lived SSE responses must not be killed by Node's default timeouts.
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;
    server.requestTimeout = 0;
    (server as any).timeout = 0;
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        internalServer = server;
        internalPort = addr.port;
        // Point the agent's internal tool calls (and any other code that
        // reads INTERNAL_API_BASE) at this in-process server. Without this,
        // tool calls would resolve to the public Lambda Function URL host
        // and recursively invoke another Lambda for every internal request.
        if (!process.env.INTERNAL_API_BASE) {
          process.env.INTERNAL_API_BASE = `http://127.0.0.1:${internalPort}`;
        }
        resolve();
      } else {
        reject(new Error("Lambda internal HTTP server failed to bind"));
      }
    });
  });
  return serverReady;
}

function buildRequestHeaders(event: any): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const src = (event.headers ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    headers[k.toLowerCase()] = String(v);
  }
  if (Array.isArray(event.cookies) && event.cookies.length > 0) {
    headers.cookie = event.cookies.join("; ");
  }
  const sourceIp = event.requestContext?.http?.sourceIp;
  if (sourceIp) {
    const xff = headers["x-forwarded-for"];
    headers["x-forwarded-for"] = xff ? `${xff}, ${sourceIp}` : String(sourceIp);
  }
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = "https";
  // Function URL events deliver host as the lambda-url hostname; that's fine
  // for Express (used for URL building) but make sure x-forwarded-host wins.
  if (src["x-forwarded-host"]) headers["x-forwarded-host"] = src["x-forwarded-host"];
  return headers;
}

function flattenResponseHeaders(
  src: http.IncomingHttpHeaders,
): { headers: Record<string, string>; cookies: string[] } {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (k.toLowerCase() === "set-cookie") {
      if (Array.isArray(v)) cookies.push(...v.map(String));
      else cookies.push(String(v));
      continue;
    }
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return { headers, cookies };
}

export async function proxyToInternalServer(
  event: any,
  responseStream: any,
): Promise<void> {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const rawPath =
    event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "/";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";

  const requestHeaders = buildRequestHeaders(event);
  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body, "utf8")
    : undefined;
  if (body) requestHeaders["content-length"] = String(body.length);

  await new Promise<void>((resolve, reject) => {
    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: internalPort,
        path: rawPath + query,
        method,
        headers: requestHeaders,
      },
      (proxyRes) => {
        const { headers, cookies } = flattenResponseHeaders(proxyRes.headers);
        // Strip transfer-encoding: chunked — Lambda runtime adds its own.
        delete headers["transfer-encoding"];
        // Strip content-length so the runtime can stream chunked.
        delete headers["content-length"];
        let wrapped: NodeJS.WritableStream;
        try {
          wrapped = awslambda.HttpResponseStream.from(responseStream, {
            statusCode: proxyRes.statusCode ?? 200,
            headers,
            cookies: cookies.length > 0 ? cookies : undefined,
          } as any);
        } catch (e) {
          return reject(e as Error);
        }
        proxyRes.on("data", (chunk: Buffer) => {
          // write() may return false under backpressure — but the AWS
          // responseStream typically does not respect highWaterMark. Writing
          // immediately is what gives us millisecond-granular streaming.
          wrapped.write(chunk);
        });
        proxyRes.once("end", () => {
          wrapped.end();
          resolve();
        });
        proxyRes.once("error", (err) => {
          try { wrapped.end(); } catch { /* noop */ }
          reject(err);
        });
      },
    );
    proxyReq.once("error", reject);
    if (body) proxyReq.write(body);
    proxyReq.end();
  });
}

export function getInternalServer(): http.Server | null {
  return internalServer;
}
